"""本地工具：在工作区内读改文件、列目录、执行命令。

全部在本机执行，不使用服务端 Code Interpreter / Files API。
路径一律相对工作区根目录，禁止逃逸到工作区外。
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import config
from file_history import FileHistory
from memory import EpisodeLog, LongTermMemory

MAX_READ_CHARS = 80_000
MAX_CMD_CHARS = 8_000


TOOL_SCHEMAS: list[dict] = [
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "读取工作区内一个文本文件的内容。",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "相对工作区的文件路径"},
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "write_file",
            "description": "写入（新建或覆盖）工作区内一个文本文件。不要用它做小修改，小修改请用 edit_file。",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "相对工作区的文件路径"},
                    "content": {"type": "string", "description": "文件的完整内容"},
                },
                "required": ["path", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "edit_file",
            "description": (
                "精确替换文件中的一段文本。old 必须在文件中唯一出现一次。"
                "适合改函数、修 bug，避免整文件覆盖。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "相对工作区的文件路径"},
                    "old": {"type": "string", "description": "文件中现有的那段文本"},
                    "new": {"type": "string", "description": "要替换成的文本"},
                },
                "required": ["path", "old", "new"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_dir",
            "description": "列出工作区内某个目录的文件和子目录。",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "相对工作区的目录路径，默认当前目录",
                    },
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "run_shell",
            "description": (
                "在工作区根目录用 Windows cmd 执行一条命令。"
                "适合 python -m pytest、dir、type、python。"
                "不要使用 grep、ls、cat、find | head 等 Unix 命令。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "要执行的命令"},
                },
                "required": ["command"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "remember",
            "description": (
                "写入一条当前有效的项目约定。kind: env / command / constraint / decision。"
                "相近约定已存在时请改用 update_memory。"
                "不要写入源码全文、密钥或一次性命令输出。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "fact": {"type": "string", "description": "要记住的一条简短事实"},
                    "kind": {
                        "type": "string",
                        "description": "env、command、constraint 或 decision，默认 decision",
                    },
                },
                "required": ["fact"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "recall",
            "description": "检索项目约定，默认只返回当前有效条目。",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "关键字或记忆 id，例如 pytest、m003",
                    },
                    "include_deprecated": {
                        "type": "boolean",
                        "description": "为 true 时包含已废弃条目",
                    },
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "update_memory",
            "description": (
                "更新项目约定：把匹配的旧条目标为废弃，再追加一条当前有效条目。"
                "old 必须只匹配一条有效约定（可用 id）。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "old": {"type": "string", "description": "旧约定的关键字或 id"},
                    "new": {"type": "string", "description": "更正后的完整事实"},
                    "kind": {"type": "string", "description": "可选，不填则沿用旧条的 kind"},
                },
                "required": ["old", "new"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "forget",
            "description": "把一条当前有效约定标为废弃（保留记录，默认不再召回）。",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "关键字或 id"},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "recall_episode",
            "description": (
                "按关键字检索历史任务情节。新任务开始时程序也会自动召回命中项；"
                "用户问「上次怎么改的」时再用这个核对。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "任务相关的关键字"},
                },
                "required": ["query"],
            },
        },
    },
]


class Workspace:
    def __init__(self, root: str | Path) -> None:
        self.root = Path(root).resolve()
        if not self.root.is_dir():
            raise NotADirectoryError(f"工作区不存在: {self.root}")

    def resolve(self, rel: str) -> Path:
        rel = (rel or ".").strip() or "."
        target = (self.root / rel).resolve()
        try:
            target.relative_to(self.root)
        except ValueError as exc:
            raise PermissionError(f"路径不允许逃出工作区: {rel}") from exc
        return target

    def read_file(self, path: str) -> str:
        p = self.resolve(path)
        if not p.is_file():
            return f"错误: 文件不存在: {path}"
        text = p.read_text(encoding="utf-8", errors="replace")
        if len(text) > MAX_READ_CHARS:
            return text[:MAX_READ_CHARS] + f"\n\n...[已截断，原文件约 {len(text)} 字符]"
        return text

    def _is_memory_file(self, path: str) -> bool:
        try:
            target = self.resolve(path)
            target.relative_to(self.root / ".agent")
            return True
        except (PermissionError, ValueError):
            return False

    def write_file(self, path: str, content: str) -> str:
        if self._is_memory_file(path):
            return "错误: .agent/ 下的记忆文件由专用工具和循环维护，不要直接覆盖"
        p = self.resolve(path)
        FileHistory(self.root).snapshot_before(path, "write_file")
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")
        return f"已写入 {path}（{len(content)} 字符）"

    def edit_file(self, path: str, old: str, new: str) -> str:
        if self._is_memory_file(path):
            return "错误: .agent/ 下的记忆文件由专用工具和循环维护，不要直接 edit_file"
        p = self.resolve(path)
        if not p.is_file():
            return f"错误: 文件不存在: {path}"
        text = p.read_text(encoding="utf-8", errors="replace")
        count = text.count(old)
        if count == 0:
            return "错误: 找不到要替换的 old 文本。请先 read_file，确认原文后重试。"
        if count > 1:
            return f"错误: old 在文件中出现了 {count} 次，必须唯一。请扩大上下文再试。"
        FileHistory(self.root).snapshot_before(path, "edit_file")
        p.write_text(text.replace(old, new, 1), encoding="utf-8")
        return f"已修改 {path}"

    def list_dir(self, path: str = ".") -> str:
        p = self.resolve(path)
        if not p.is_dir():
            return f"错误: 目录不存在: {path}"
        names = []
        for child in sorted(p.iterdir(), key=lambda x: (x.is_file(), x.name.lower())):
            tag = "dir" if child.is_dir() else "file"
            names.append(f"{tag}\t{child.name}")
        return "\n".join(names) if names else "(空目录)"

    def run_shell(self, command: str) -> str:
        command = (command or "").strip()
        if not command:
            return "错误: 命令为空"
        try:
            proc = subprocess.run(
                command,
                shell=True,
                cwd=self.root,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=config.COMMAND_TIMEOUT,
            )
        except subprocess.TimeoutExpired:
            return f"错误: 命令超时（{config.COMMAND_TIMEOUT}s）: {command}"

        out = (proc.stdout or "") + (proc.stderr or "")
        if len(out) > MAX_CMD_CHARS:
            out = out[:MAX_CMD_CHARS] + "\n...[输出已截断]"
        return f"exit_code={proc.returncode}\n{out}".rstrip()


def dispatch(workspace: Workspace, name: str, arguments: str) -> str:
    """根据模型给出的工具名和 JSON 参数，在本地执行并返回字符串结果。"""
    try:
        args = json.loads(arguments) if arguments else {}
        if not isinstance(args, dict):
            return "错误: 工具参数必须是 JSON 对象"
    except json.JSONDecodeError as exc:
        return f"错误: 无法解析工具参数 JSON: {exc}"

    try:
        if name == "read_file":
            return workspace.read_file(args.get("path", ""))
        if name == "write_file":
            return workspace.write_file(args.get("path", ""), args.get("content", ""))
        if name == "edit_file":
            return workspace.edit_file(
                args.get("path", ""), args.get("old", ""), args.get("new", "")
            )
        if name == "list_dir":
            return workspace.list_dir(args.get("path", "."))
        if name == "run_shell":
            return workspace.run_shell(args.get("command", ""))
        if name == "remember":
            return LongTermMemory(workspace.root).remember(
                args.get("fact", ""), args.get("kind") or "decision"
            )
        if name == "recall":
            return LongTermMemory(workspace.root).recall(
                args.get("query", ""),
                bool(args.get("include_deprecated", False)),
            )
        if name == "update_memory":
            return LongTermMemory(workspace.root).update(
                args.get("old", ""),
                args.get("new", ""),
                args.get("kind") or "",
            )
        if name == "forget":
            return LongTermMemory(workspace.root).forget(args.get("query", ""))
        if name == "recall_episode":
            log = EpisodeLog(workspace.root)
            hits = log.search(args.get("query", ""), limit=5)
            return log.format_hits(hits)
        return f"错误: 未知工具 {name}"
    except PermissionError as exc:
        return f"错误: {exc}"
    except OSError as exc:
        return f"错误: 文件系统异常: {exc}"
