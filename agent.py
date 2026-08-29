"""自研 agent 循环：维护 messages，调用 LLM，本地执行工具，直到结束。

会话：messages 追加并压缩旧工具输出。
项目记忆：有效/废弃；情节：任务入口按关键词自动召回。
任务队列：未完成条目保留；询问进度只追加记录，不覆盖进行中的工作。
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from openai import OpenAI

import config
import llm
from memory import (
    EpisodeLog,
    ProjectMemory,
    TaskQueue,
    files_from_tool,
    health_check,
)
from tools import TOOL_SCHEMAS, Workspace, dispatch

SYSTEM_PROMPT = """你是一个在本地工作区里完成编程任务的助手。
工作区根目录是用户指定的文件夹，所有路径都必须相对这个根目录。

请遵循：
1. 先用 list_dir / read_file 了解现状，再修改。
2. 小改动用 edit_file（old 必须在文件中唯一），新建或整文件重写才用 write_file。
3. 改完代码后用 run_shell 运行测试或相关命令；失败则根据输出继续改，直到成功或确认无法完成。
   本机是 Windows，run_shell 走 cmd。用 python -m pytest、dir、type、findstr。
   不要用 grep、ls、cat、find | head 或其它 Unix 管道。
4. 不要编造看不到的文件内容。工具失败时根据错误信息调整，不要中止后空想。
5. 任务完成后用简短中文说明你改了什么、如何验证。不要再调用工具。
6. 用户不会点名工具。项目约定用 remember / update_memory / forget / recall：
   - remember：新的长期约定（kind 为 env/command/constraint/decision）
   - update_memory：约定过时则废弃旧条并追加新条，不要假装覆盖
   - forget：用户明确说不用再遵守时，软废弃
   - recall：只查当前有效约定；系统里已有目录时可直接用
   下面「自动召回的历史任务」由程序按关键词匹配注入，不是全量情节。
   任务队列里「进行中」才是未做完的工作。用户问进度时根据进行中回答，不要把问进度当成新的开发任务。
   用户说继续时，接上对应未完成任务，不要从头重做。
   用户只是打招呼或闲聊时，直接用一两句中文回复，不要调用工具、不要当新开发任务。
   不要把源码全文、API 密钥或整段终端日志写入项目记忆。
   不要直接改 .agent/ 下的记忆文件。
"""


def build_system(
    workspace: Workspace,
    recalled_text: str,
) -> str:
    project = ProjectMemory(workspace.root)
    queue = TaskQueue(workspace.root)
    return (
        SYSTEM_PROMPT
        + "\n\n## 项目记忆目录（仅当前有效）\n"
        + project.catalog()
        + "\n\n## 自动召回的历史任务\n"
        + recalled_text
        + "\n\n## 任务队列\n"
        + queue.format_for_prompt()
    )


def refresh_system(
    workspace: Workspace,
    messages: list[dict],
    recalled_text: str,
) -> None:
    sys_msg = {"role": "system", "content": build_system(workspace, recalled_text)}
    if messages and messages[0].get("role") == "system":
        messages[0] = sys_msg
    else:
        messages.insert(0, sys_msg)


def compact_messages(messages: list[dict]) -> None:
    """截断较早的工具输出。成对的 tool_calls 结构保持不变。"""
    tool_idx = [i for i, m in enumerate(messages) if m.get("role") == "tool"]
    keep_last = set(tool_idx[-config.KEEP_RECENT_TOOL_RESULTS :])
    for i, m in enumerate(messages):
        if m.get("role") != "tool" or i in keep_last:
            continue
        content = m.get("content") or ""
        if len(content) > config.COMPACT_TOOL_CHARS:
            m["content"] = (
                content[: config.COMPACT_TOOL_CHARS]
                + "\n...[会话压缩：更早的工具输出已截断]"
            )


def _emit(
    on_event: Callable[[str, dict[str, Any]], None] | None,
    kind: str,
    payload: dict[str, Any],
    line: str | None = None,
) -> None:
    if line is not None:
        print(line)
    if on_event is not None:
        on_event(kind, payload)


def _cancelled(cancel_check: Callable[[], bool] | None) -> bool:
    return bool(cancel_check and cancel_check())


def is_smalltalk(task: str) -> bool:
    t = (task or "").strip()
    if not t or len(t) > 24:
        return False
    if any(k in t for k in ("文件", "代码", "改", "写", "测", "运行", "bug", "函数", "报错")):
        return False
    low = t.lower()
    if low in {"hi", "hello", "hey", "ok", "好", "嗯"}:
        return True
    return any(g in t for g in ("你好", "您好", "嗨", "在吗", "谢谢", "早上好", "晚上好"))


def run_task(
    client: OpenAI,
    workspace: Workspace,
    task: str,
    messages: list[dict] | None = None,
    on_event: Callable[[str, dict[str, Any]], None] | None = None,
    cancel_check: Callable[[], bool] | None = None,
) -> str:
    if messages is None:
        messages = []

    smalltalk = is_smalltalk(task)
    queue = TaskQueue(workspace.root)
    if smalltalk:
        mode, item = "inspect", {"id": None, "kind": "inspect"}
        recalled_text = "（闲聊，未召回情节）"
        _emit(on_event, "recall", {"ids": ""}, "情节自动召回: 跳过（闲聊）")
        _emit(on_event, "queue", {"mode": "inspect", "id": "(闲聊)"}, "任务队列: 跳过闲聊")
    else:
        mode, item = queue.start(task, messages)
        hits = EpisodeLog(workspace.root).search(task, limit=2)
        recalled_text = EpisodeLog(workspace.root).format_hits(hits)
        if hits:
            ids = ", ".join(ep["id"] for _, ep in hits)
            _emit(on_event, "recall", {"ids": ids}, "情节自动召回: " + ids)
        else:
            _emit(on_event, "recall", {"ids": ""}, "情节自动召回: 无命中")
        qid = item.get("id") or "(询问)"
        _emit(on_event, "queue", {"mode": mode, "id": qid}, f"任务队列: {mode} {qid}")

    refresh_system(workspace, messages, recalled_text)
    messages.append({"role": "user", "content": task})

    tools_used: list[str] = []
    files_touched: list[str] = []
    final_text = ""
    finished = False
    outcome = "ok"

    try:
        for step in range(1, config.MAX_STEPS + 1):
            if _cancelled(cancel_check):
                finished = False
                outcome = "interrupted"
                final_text = final_text or "已停止"
                _emit(on_event, "error", {"text": "已停止"}, "已停止")
                break
            _emit(
                on_event,
                "step",
                {"step": step, "max": config.MAX_STEPS},
                f"\n----- 第 {step}/{config.MAX_STEPS} 轮 -----",
            )
            refresh_system(workspace, messages, recalled_text)
            compact_messages(messages)

            def on_text(piece: str) -> None:
                print(piece, end="", flush=True)
                _emit(on_event, "delta", {"text": piece})

            thinking_noted = False

            def on_thinking(_piece: str) -> None:
                nonlocal thinking_noted
                if thinking_noted:
                    return
                thinking_noted = True
                _emit(on_event, "thinking", {})

            resp = llm.chat(
                client,
                messages,
                tools=None if smalltalk else TOOL_SCHEMAS,
                on_text=on_text,
                on_thinking=on_thinking,
                cancel_check=cancel_check,
            )
            print("", flush=True)
            if _cancelled(cancel_check):
                finished = False
                outcome = "interrupted"
                final_text = final_text or "已停止"
                _emit(on_event, "error", {"text": "已停止"}, "已停止")
                break

            if not resp.wants_tools:
                messages.append(llm.assistant_message(resp))
                final_text = resp.content.strip() or "(模型没有返回文字)"
                _emit(on_event, "final", {"text": final_text}, final_text)
                finished = True
                outcome = "ok"
                break

            messages.append(llm.assistant_message(resp))

            stopped = False
            for call in resp.tool_calls:
                if _cancelled(cancel_check):
                    stopped = True
                    break
                _emit(
                    on_event,
                    "tool",
                    {"name": call.name, "arguments": call.arguments},
                    f"→ {call.name} {call.arguments}",
                )
                tools_used.append(call.name)
                files_touched.extend(files_from_tool(call.name, call.arguments))
                result = dispatch(workspace, call.name, call.arguments)
                preview = result if len(result) < 500 else result[:500] + "\n...[显示截断]"
                _emit(
                    on_event,
                    "tool_result",
                    {"name": call.name, "preview": preview},
                    f"← {preview}",
                )
                messages.append(llm.tool_message(call.id, result))
            if stopped:
                finished = False
                outcome = "interrupted"
                final_text = final_text or "已停止"
                _emit(on_event, "error", {"text": "已停止"}, "已停止")
                break
        else:
            final_text = f"已达到最大步数 {config.MAX_STEPS}，停止以免无限循环。"
            _emit(on_event, "final", {"text": final_text}, final_text)
            outcome = "max_steps"
    except KeyboardInterrupt:
        finished = False
        outcome = "interrupted"
        final_text = final_text or "用户中断"
        _emit(
            on_event,
            "final",
            {"text": final_text},
            "\n检测到中断，任务队列仍会落盘。",
        )
        raise
    finally:
        if not smalltalk:
            queue.record(
                mode,
                item,
                task,
                tools_used,
                files_touched,
                finished,
                outcome,
                final_text,
            )
            queue.save_task_session(item.get("id"), messages)
            if mode != "inspect":
                EpisodeLog(workspace.root).append(
                    user=task,
                    tools=tools_used,
                    files=files_touched,
                    outcome=outcome,
                    summary=final_text,
                )
            notes = health_check(workspace.root)
            health_line = "；".join(notes)
            _emit(
                on_event,
                "health",
                {"notes": notes, "open": len(queue.open_items())},
                "[记忆维护] " + health_line,
            )

    return final_text
