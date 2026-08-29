"""薄 LLM 客户端：只负责发一次请求、把结果收成统一结构。

不维护对话历史，不执行工具——那些在 agent.py 里。
使用官方 OpenAI 库，走 Chat Completions + 原生 tool calling。
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field

from openai import OpenAI

import config


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: str


@dataclass
class LLMResponse:
    content: str
    tool_calls: list[ToolCall] = field(default_factory=list)
    finish_reason: str | None = None

    @property
    def wants_tools(self) -> bool:
        return bool(self.tool_calls)


def make_client() -> OpenAI:
    if not config.API_KEY:
        raise RuntimeError(
            "未设置 OPENAI_API_KEY。请复制 .env.example 为 .env 并填入密钥。"
        )
    try:
        from httpx import Timeout

        timeout: object = Timeout(config.LLM_TIMEOUT, connect=10.0, read=25.0)
    except Exception:
        timeout = config.LLM_TIMEOUT
    kwargs: dict = {
        "api_key": config.API_KEY,
        "timeout": timeout,
        "max_retries": config.LLM_MAX_RETRIES,
    }
    if config.BASE_URL:
        kwargs["base_url"] = config.BASE_URL
    return OpenAI(**kwargs)


_active_stream = None
_active_lock = threading.Lock()


def abort_active_stream() -> None:
    """从停止按钮打断正在阻塞的模型 HTTP 流。"""
    with _active_lock:
        stream = _active_stream
    if stream is None:
        return
    print("中断模型请求", flush=True)
    try:
        stream.close()
    except Exception:
        pass
    try:
        resp = getattr(stream, "response", None)
        if resp is not None:
            resp.close()
    except Exception:
        pass


def _thinking_body() -> dict | None:
    """DeepSeek V4 默认开启 thinking，不关的话会长时间无返回，界面卡在「正在调用模型」。"""
    if not (config.BASE_URL and "deepseek" in config.BASE_URL.lower()):
        return None
    mode = config.LLM_THINKING
    if mode in {"disabled", "off", "0", "false"}:
        return {"thinking": {"type": "disabled"}}
    if mode in {"enabled", "on", "1", "true"}:
        return {"thinking": {"type": "enabled"}}
    return None


def chat(
    client: OpenAI,
    messages: list[dict],
    tools: list[dict] | None = None,
    on_text: Callable[[str], None] | None = None,
    on_thinking: Callable[[str], None] | None = None,
    cancel_check: Callable[[], bool] | None = None,
) -> LLMResponse:
    """流式请求模型：边收边回调，结束后返回完整文本和工具调用。"""
    kwargs: dict = {
        "model": config.MODEL,
        "messages": messages,
        "stream": True,
    }
    if tools:
        kwargs["tools"] = tools
        kwargs["tool_choice"] = "auto"
    extra = _thinking_body()
    if extra:
        kwargs["extra_body"] = extra

    started = time.time()
    print(
        f"调用模型 {config.MODEL}  messages={len(messages)} tools={'yes' if tools else 'no'} stream",
        flush=True,
    )
    content_parts: list[str] = []
    tool_buf: dict[int, dict[str, str]] = {}
    finish_reason: str | None = None
    first_token = False
    stream = None
    global _active_stream
    try:
        stream = client.chat.completions.create(**kwargs)
        with _active_lock:
            _active_stream = stream
        for chunk in stream:
            if cancel_check and cancel_check():
                raise RuntimeError("已停止")
            if not chunk.choices:
                continue
            choice = chunk.choices[0]
            if choice.finish_reason:
                finish_reason = choice.finish_reason
            delta = choice.delta
            if delta is None:
                continue
            piece = delta.content or ""
            if piece:
                if not first_token:
                    first_token = True
                    print(f"首字 {time.time()-started:.1f}s", flush=True)
                content_parts.append(piece)
                if on_text:
                    on_text(piece)
            thinking = getattr(delta, "reasoning_content", None) or getattr(
                delta, "reasoning", None
            )
            if thinking and on_thinking:
                on_thinking(thinking)
            for tc in delta.tool_calls or []:
                idx = tc.index if getattr(tc, "index", None) is not None else 0
                slot = tool_buf.setdefault(
                    idx, {"id": "", "name": "", "arguments": ""}
                )
                if tc.id:
                    slot["id"] = tc.id
                fn = tc.function
                if fn is None:
                    continue
                if fn.name:
                    slot["name"] += fn.name
                if fn.arguments:
                    slot["arguments"] += fn.arguments
    except RuntimeError:
        raise
    except Exception as exc:
        if cancel_check and cancel_check():
            raise RuntimeError("已停止") from exc
        name = type(exc).__name__
        print(f"模型失败 {name} {time.time()-started:.1f}s", flush=True)
        if "Timeout" in name or "ReadTimeout" in name:
            raise RuntimeError(
                f"模型请求超时（{int(config.LLM_TIMEOUT)}秒）。请检查网络后重试。"
            ) from exc
        if "APIConnection" in name:
            raise RuntimeError("连不上模型服务，请检查网络和 OPENAI_BASE_URL。") from exc
        raise
    finally:
        with _active_lock:
            if _active_stream is stream:
                _active_stream = None
        if stream is not None:
            try:
                stream.close()
            except Exception:
                pass

    tool_calls = [
        ToolCall(
            id=slot["id"] or f"call_{idx}",
            name=slot["name"],
            arguments=slot["arguments"] or "{}",
        )
        for idx, slot in sorted(tool_buf.items())
        if slot["name"]
    ]
    print(
        f"模型返回 {time.time()-started:.1f}s finish={finish_reason} tools={len(tool_calls)}",
        flush=True,
    )
    return LLMResponse(
        content="".join(content_parts),
        tool_calls=tool_calls,
        finish_reason=finish_reason,
    )


def assistant_message(resp: LLMResponse) -> dict:
    """把模型这一轮回复原样写回历史（含 tool_calls，API 要求必须对齐）。"""
    message: dict = {"role": "assistant", "content": resp.content or None}
    if resp.tool_calls:
        message["tool_calls"] = [
            {
                "id": tc.id,
                "type": "function",
                "function": {"name": tc.name, "arguments": tc.arguments},
            }
            for tc in resp.tool_calls
        ]
    return message


def tool_message(tool_call_id: str, content: str) -> dict:
    return {"role": "tool", "tool_call_id": tool_call_id, "content": content}
