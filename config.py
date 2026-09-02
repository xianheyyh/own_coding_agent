"""从环境变量读取配置。密钥不得写进代码或仓库。"""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent / ".env")


def _optional(name: str) -> str | None:
    value = os.environ.get(name, "").strip()
    return value or None


API_KEY = os.environ.get("OPENAI_API_KEY", "").strip()
BASE_URL = _optional("OPENAI_BASE_URL")
MODEL = os.environ.get("OPENAI_MODEL", "gpt-4o-mini").strip()

_DEFAULT_DEEPSEEK = (
    "deepseek-v4-flash",
    "deepseek-v4-pro",
    "deepseek-chat",
    "deepseek-reasoner",
)
_DEFAULT_OPENAI = (
    "gpt-4o-mini",
    "gpt-4o",
    "gpt-4.1-mini",
)


def list_models() -> list[str]:
    """界面可选模型：OPENAI_MODELS 逗号分隔，否则按网关给一组常用名，并始终包含 OPENAI_MODEL。"""
    seen: set[str] = set()
    items: list[str] = []

    def add(name: str) -> None:
        n = (name or "").strip()
        if not n or n in seen:
            return
        seen.add(n)
        items.append(n)

    raw = os.environ.get("OPENAI_MODELS", "").strip()
    if raw:
        for part in raw.split(","):
            add(part)
    elif BASE_URL and "deepseek" in BASE_URL.lower():
        for name in _DEFAULT_DEEPSEEK:
            add(name)
    else:
        for name in _DEFAULT_OPENAI:
            add(name)
    add(MODEL)
    return items


def normalize_model(name: str) -> str:
    n = (name or "").strip()
    if not n or len(n) > 80:
        raise ValueError("模型名不合法")
    if any(ch in n for ch in " \t\n\r/\\"):
        raise ValueError("模型名不合法")
    return n


MAX_STEPS = int(os.environ.get("AGENT_MAX_STEPS", "20"))
COMMAND_TIMEOUT = int(os.environ.get("AGENT_CMD_TIMEOUT", "60"))
LLM_TIMEOUT = float(os.environ.get("AGENT_LLM_TIMEOUT", "90"))
LLM_MAX_RETRIES = int(os.environ.get("AGENT_LLM_MAX_RETRIES", "2"))
LLM_RETRY_BASE = float(os.environ.get("AGENT_LLM_RETRY_BASE", "0.6"))
LLM_THINKING = os.environ.get("AGENT_LLM_THINKING", "disabled").strip().lower()
# 会话压缩：更早的工具输出截断，最近若干条工具结果保持原文
KEEP_RECENT_TOOL_RESULTS = int(os.environ.get("AGENT_KEEP_RECENT_TOOLS", "6"))
COMPACT_TOOL_CHARS = int(os.environ.get("AGENT_COMPACT_TOOL_CHARS", "1200"))
EPISODE_RECALL_MIN_SCORE = int(os.environ.get("AGENT_EPISODE_MIN_SCORE", "2"))
EPISODE_WARN = int(os.environ.get("AGENT_EPISODE_WARN", "20"))
DEPRECATED_WARN = int(os.environ.get("AGENT_DEPRECATED_WARN", "8"))
