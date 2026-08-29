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
MAX_STEPS = int(os.environ.get("AGENT_MAX_STEPS", "20"))
COMMAND_TIMEOUT = int(os.environ.get("AGENT_CMD_TIMEOUT", "60"))
LLM_TIMEOUT = float(os.environ.get("AGENT_LLM_TIMEOUT", "90"))
LLM_MAX_RETRIES = int(os.environ.get("AGENT_LLM_MAX_RETRIES", "1"))
LLM_THINKING = os.environ.get("AGENT_LLM_THINKING", "disabled").strip().lower()
# 会话压缩：更早的工具输出截断，最近若干条工具结果保持原文
KEEP_RECENT_TOOL_RESULTS = int(os.environ.get("AGENT_KEEP_RECENT_TOOLS", "6"))
COMPACT_TOOL_CHARS = int(os.environ.get("AGENT_COMPACT_TOOL_CHARS", "1200"))
EPISODE_RECALL_MIN_SCORE = int(os.environ.get("AGENT_EPISODE_MIN_SCORE", "2"))
EPISODE_WARN = int(os.environ.get("AGENT_EPISODE_WARN", "20"))
DEPRECATED_WARN = int(os.environ.get("AGENT_DEPRECATED_WARN", "8"))
