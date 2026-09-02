"""本地工具：在工作区内读改文件、列目录、搜索、执行命令。

全部在本机执行，不使用服务端 Code Interpreter / Files API。
路径一律相对工作区根目录，禁止逃逸到工作区外。
"""

from __future__ import annotations

import fnmatch
import json
import os
import re
import subprocess
from pathlib import Path

import config
from file_history import FileHistory
from memory import EpisodeLog, LongTermMemory, _agent_dir, _now

MAX_READ_CHARS = 80_000
MAX_CMD_CHARS = 8_000
MAX_GREP_HITS = 80
MAX_GREP_LINE = 240
MAX_GLOB_HITS = 200
SKIP_DIRS = {
    ".git",
    ".svn",
    ".hg",
    ".venv",
    "venv",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".agent",
    "node_modules",
    "dist",
    "build",
}

TOOL_SCHEMAS: list[dict] = [
    {
        "type": "function",
        "function": {
            "name": "glob",
            "description": (
                "按文件名模式列出工作区内的路径，例如 **/*.py、shop/*.py。"
                "先 glob/grep 定位，再 read_file，不要靠猜路径。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": {
                        "type": "string",
                        "description": "文件名 glob，如 **/*.py 或 *checkout*",
                    },
                    "path": {
                        "type": "string",
                        "description": "相对工作区的起始目录，默认当前目录",
                    },
                },
                "required": ["pattern"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "grep",
            "description": (
                "在工作区文本文件中搜索关键字或正则，返回 path:行号:内容。"
                "这是本地搜索工具，不要用 run_shell 调 Unix grep。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": {"type": "string", "description": "要搜索的文本或正则"},
                    "path": {
                        "type": "string",
                        "description": "相对工作区的文件或目录，默认整个工作区",
                    },
                    "glob": {
                        "type": "string",
                        "description": "可选，限制文件名，如 *.py",
                    },
                    "regex": {
                        "type": "boolean",
                        "description": "为 true 时把 pattern 当正则，默认按字面量",
                    },
                },
                "required": ["pattern"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": (
                "读取工作区内一个文本文件。默认带行号。"
                "大文件请用 offset（从 1 起的行号）和 limit（行数）分段读。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "相对工作区的文件路径"},
                    "offset": {
                        "type": "integer",
                        "description": "起始行号，从 1 开始，默认 1",
                    },
                    "limit": {
                        "type": "integer",
                        "description": "最多返回多少行；不填则尽量读完（仍有字符上限）",
                    },
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "write_file",
            "description": "写入（新建或覆盖）工作区内一个文本文件。不要用它做小修改，小修改请用 apply_patch 或 edit_file。",
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
            "name": "apply_patch",
            "description": (
                "用 unified 风格补丁改文件，比 edit_file 更稳。格式：\n"
                "*** Begin Patch\n"
                "*** Update File: 相对路径\n"
                "@@\n"
                " 上下文行\n"
                "-删除行\n"
                "+新增行\n"
                "*** Add File: 新文件路径\n"
                "+文件内容\n"
                "*** Delete File: 要删的路径\n"
                "*** End Patch"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "patch": {"type": "string", "description": "完整补丁文本"},
                },
                "required": ["patch"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "edit_file",
            "description": (
                "精确替换文件中的一段文本。old 必须在文件中唯一出现一次。"
                "对不齐时改用 apply_patch，并带上前后文。"
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
            "name": "todo",
            "description": (
                "更新当前任务的步骤清单。超过两三步的任务先列出步骤，"
                "完成或开始某一项时再次调用，把对应 status 改为 in_progress 或 done。"
                "每条 content 必须用简体中文，不要用英文。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "items": {
                        "type": "array",
                        "description": "完整清单（每次传入当前全部条目）",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": {"type": "string", "description": "可选短 id"},
                                "content": {
                                    "type": "string",
                                    "description": "这一步要做什么，必须用简体中文",
                                },
                                "status": {
                                    "type": "string",
                                    "description": "pending、in_progress 或 done",
                                },
                            },
                            "required": ["content", "status"],
                        },
                    },
                },
                "required": ["items"],
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
                "不要使用 grep、ls、cat、find | head 等 Unix 命令；搜索请用 grep/glob 工具。"
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


def _expand_command(command: str) -> str:
    """展开 %TEMP%、$env:TEMP 等，再做路径检查，避免守卫看到的是未展开原文。"""
    expanded = os.path.expandvars(command or "")

    def ps_env(match: re.Match[str]) -> str:
        return os.environ.get(match.group(1), match.group(0))

    expanded = re.sub(r"\$env:([A-Za-z_][\w]*)", ps_env, expanded, flags=re.I)

    def bang_env(match: re.Match[str]) -> str:
        return os.environ.get(match.group(1), match.group(0))

    return re.sub(r"!([A-Za-z_][\w]*)!", bang_env, expanded)


def _rel_posix(root: Path, path: Path) -> str:
    return path.resolve().relative_to(root).as_posix()


def _skip_dir(name: str) -> bool:
    return name in SKIP_DIRS or name.endswith(".egg-info")


_REDIR = re.compile(
    r"(?<![<>])(?:\d*)>{1,2}(?!&)\s*(?:\"([^\"]+)\"|'([^']+)'|(\S+))"
)
_QUOTED = re.compile(r"[\"']([^\"']+)[\"']")
_PATHISH = re.compile(
    r"(?:[a-zA-Z]:[\\/]|\\\\|\.\.[\\/]|[\\/]\.\.)[^\s'\"|,;)]*"
)


def _redirect_targets(command: str) -> list[str]:
    found: list[str] = []
    for match in _REDIR.finditer(command or ""):
        dest = next((g for g in match.groups() if g), "")
        dest = dest.strip()
        if dest:
            found.append(dest)
    return found


def _looks_like_path(text: str) -> bool:
    t = (text or "").strip()
    if not t or t.upper() in {"NUL", "CON", "PRN", "AUX"} or t in {"/dev/null"}:
        return False
    norm = t.replace("/", "\\")
    if ".." in norm or re.match(r"^[a-zA-Z]:\\", norm) or norm.startswith("\\\\"):
        return True
    return False


def _unescape_cmd_path(text: str) -> str:
    return (text or "").replace("\\\\", "\\")


def _path_candidates(command: str) -> list[str]:
    found: list[str] = []
    raw = command or ""
    for match in _QUOTED.finditer(raw):
        inner = _unescape_cmd_path(match.group(1))
        if _looks_like_path(inner):
            found.append(inner)
    for match in _PATHISH.finditer(raw):
        found.append(_unescape_cmd_path(match.group(0).rstrip(")'\"")))
    return found


def _is_probably_binary(path: Path) -> bool:
    try:
        chunk = path.read_bytes()[:1024]
    except OSError:
        return True
    return b"\x00" in chunk


class TaskTodos:
    """当前任务步骤清单，落在 .agent/todos.json，给人看、给模型改。"""

    def __init__(self, workspace_root: str | Path) -> None:
        self.root = Path(workspace_root).resolve()
        self.path = _agent_dir(self.root) / "todos.json"

    def update(self, items: list) -> str:
        if not isinstance(items, list) or not items:
            return "错误: items 必须是非空数组，每项含 content 和 status"
        cleaned = []
        allowed = {"pending", "in_progress", "done"}
        for i, raw in enumerate(items, start=1):
            if not isinstance(raw, dict):
                return f"错误: 第 {i} 项不是对象"
            content = str(raw.get("content") or "").strip()
            status = str(raw.get("status") or "pending").strip().lower()
            if not content:
                return f"错误: 第 {i} 项缺少 content"
            if status not in allowed:
                return f"错误: 第 {i} 项 status 只能是 pending / in_progress / done"
            tid = str(raw.get("id") or f"s{i:02d}").strip() or f"s{i:02d}"
            cleaned.append(
                {
                    "id": tid,
                    "content": content,
                    "status": status,
                    "updated": _now(),
                }
            )
        payload = {"updated": _now(), "items": cleaned}
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        lines = []
        for row in cleaned:
            mark = {"pending": "[ ]", "in_progress": "[>]", "done": "[x]"}[row["status"]]
            lines.append(f"{mark} {row['id']} {row['content']}")
        return "待办已更新\n" + "\n".join(lines)

    def format_for_prompt(self) -> str:
        if not self.path.is_file():
            return "（尚未列出步骤。超过两三步的任务请先调用 todo。）"
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return "（待办文件无法读取）"
        items = data.get("items") or []
        if not items:
            return "（空）"
        lines = []
        for row in items:
            mark = {"pending": "[ ]", "in_progress": "[>]", "done": "[x]"}.get(
                str(row.get("status") or "pending"), "[ ]"
            )
            lines.append(f"{mark} {row.get('id', '')} {row.get('content', '')}".rstrip())
        return "\n".join(lines)

    def clear(self) -> None:
        if self.path.is_file():
            self.path.unlink()


def patch_file_paths(patch: str) -> list[str]:
    found: list[str] = []
    for line in str(patch or "").splitlines():
        for prefix in ("*** Update File:", "*** Add File:", "*** Delete File:"):
            if line.startswith(prefix):
                rel = line.split(":", 1)[1].strip()
                if rel:
                    found.append(rel)
    return found


def _hunk_old_new(lines: list[str]) -> tuple[str, str]:
    old: list[str] = []
    new: list[str] = []
    for raw in lines:
        if raw.startswith("***") or raw.startswith("@@"):
            continue
        if raw.startswith("\\"):
            continue
        if raw.startswith("+"):
            new.append(raw[1:])
        elif raw.startswith("-"):
            old.append(raw[1:])
        elif raw.startswith(" "):
            old.append(raw[1:])
            new.append(raw[1:])
        else:
            old.append(raw)
            new.append(raw)
    return "\n".join(old), "\n".join(new)


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

    def _is_memory_file(self, path: str) -> bool:
        try:
            target = self.resolve(path)
            target.relative_to(self.root / ".agent")
            return True
        except (PermissionError, ValueError):
            return False

    def _walk_files(self, start: Path):
        if start.is_file():
            yield start
            return
        if not start.is_dir():
            return
        stack = [start]
        while stack:
            current = stack.pop()
            try:
                children = list(current.iterdir())
            except OSError:
                continue
            for child in children:
                if child.is_dir():
                    if not _skip_dir(child.name):
                        stack.append(child)
                elif child.is_file():
                    yield child

    def glob(self, pattern: str, path: str = ".") -> str:
        pattern = (pattern or "").strip()
        if not pattern:
            return "错误: pattern 不能为空"
        start = self.resolve(path or ".")
        if not start.exists():
            return f"错误: 路径不存在: {path}"
        patt = pattern.replace("\\", "/")
        if "/" not in patt and "**" not in patt:
            patt = "**/" + patt
        hits: list[str] = []
        for file in self._walk_files(start):
            rel = _rel_posix(self.root, file)
            if fnmatch.fnmatch(rel, patt) or fnmatch.fnmatch(file.name, pattern):
                hits.append(rel)
            if len(hits) >= MAX_GLOB_HITS:
                break
        if not hits:
            return "（无匹配）"
        extra = "" if len(hits) < MAX_GLOB_HITS else f"\n...[已截断，最多 {MAX_GLOB_HITS} 条]"
        return "\n".join(hits) + extra

    def grep(
        self,
        pattern: str,
        path: str = ".",
        glob: str = "",
        regex: bool = False,
    ) -> str:
        pattern = pattern or ""
        if not pattern:
            return "错误: pattern 不能为空"
        start = self.resolve(path or ".")
        if not start.exists():
            return f"错误: 路径不存在: {path}"
        file_filter = (glob or "").strip()
        compiled = None
        if regex:
            try:
                compiled = re.compile(pattern)
            except re.error as exc:
                return f"错误: 正则无效: {exc}"
        hits: list[str] = []
        files_scanned = 0
        for file in self._walk_files(start):
            if file_filter and not (
                fnmatch.fnmatch(file.name, file_filter)
                or fnmatch.fnmatch(_rel_posix(self.root, file), file_filter)
            ):
                continue
            if _is_probably_binary(file):
                continue
            files_scanned += 1
            try:
                text = file.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            rel = _rel_posix(self.root, file)
            for i, line in enumerate(text.splitlines(), start=1):
                ok = compiled.search(line) is not None if compiled else pattern in line
                if not ok:
                    continue
                shown = line if len(line) <= MAX_GREP_LINE else line[:MAX_GREP_LINE] + "…"
                hits.append(f"{rel}:{i}:{shown}")
                if len(hits) >= MAX_GREP_HITS:
                    extra = f"\n...[已截断，最多 {MAX_GREP_HITS} 条，已扫 {files_scanned} 个文件]"
                    return "\n".join(hits) + extra
        if not hits:
            return f"（无命中，已扫 {files_scanned} 个文件）"
        return "\n".join(hits)

    def read_file(self, path: str, offset: int | None = None, limit: int | None = None) -> str:
        p = self.resolve(path)
        if not p.is_file():
            return f"错误: 文件不存在: {path}"
        text = p.read_text(encoding="utf-8", errors="replace")
        lines = text.splitlines()
        total = len(lines)
        start = 1 if offset is None else int(offset)
        if start < 1:
            start = 1
        if start > total + 1:
            return f"错误: offset={start} 超出文件行数 {total}"
        if limit is None:
            chunk = lines[start - 1 :]
        else:
            n = max(0, int(limit))
            chunk = lines[start - 1 : start - 1 + n]
        numbered = [f"{start + i:5d}|{line}" for i, line in enumerate(chunk)]
        body = "\n".join(numbered)
        end = start + len(chunk) - 1 if chunk else start - 1
        header = f"{path}  第 {start}-{end} 行 / 共 {total} 行"
        if len(body) > MAX_READ_CHARS:
            body = body[:MAX_READ_CHARS] + "\n...[已截断，请减小 limit 或增大 offset]"
        return header + "\n" + body

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
            return "错误: 找不到要替换的 old 文本。请先 read_file，确认原文后用 apply_patch 带上下文重试。"
        if count > 1:
            return f"错误: old 在文件中出现了 {count} 次，必须唯一。请改用 apply_patch 并带上前后文。"
        FileHistory(self.root).snapshot_before(path, "edit_file")
        p.write_text(text.replace(old, new, 1), encoding="utf-8")
        return f"已修改 {path}"

    def _apply_update_hunk(self, path: str, hunk_lines: list[str]) -> str:
        if self._is_memory_file(path):
            return f"错误: 不能给记忆文件打补丁: {path}"
        p = self.resolve(path)
        if not p.is_file():
            return f"错误: 文件不存在: {path}"
        old, new = _hunk_old_new(hunk_lines)
        if not old and not new:
            return f"错误: {path} 的 hunk 为空"
        text = p.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n")
        candidates = [old]
        if old and not old.endswith("\n") and (old + "\n") in text:
            candidates.append(old + "\n")
        matched = None
        for cand in candidates:
            if cand and text.count(cand) == 1:
                matched = cand
                break
        if matched is None:
            if old and text.count(old) > 1:
                return (
                    f"错误: {path} 中这段上下文出现 {text.count(old)} 次，"
                    "请加大 @@ 前后文再试。"
                )
            preview = old.split("\n")[:4]
            hint = " | ".join(preview) if preview else "(空)"
            return f"错误: {path} 对不上补丁上下文。期望开头: {hint}"
        FileHistory(self.root).snapshot_before(path, "apply_patch")
        replacement = new
        if matched.endswith("\n") and not new.endswith("\n") and new:
            replacement = new + "\n"
        if matched.startswith("\n") and not new.startswith("\n") and new:
            replacement = "\n" + new
        p.write_text(text.replace(matched, replacement, 1), encoding="utf-8")
        return f"已补丁 {path}"

    def _apply_add_file(self, path: str, hunk_lines: list[str]) -> str:
        if self._is_memory_file(path):
            return f"错误: 不能在 .agent/ 下新增记忆文件: {path}"
        p = self.resolve(path)
        if p.exists():
            return f"错误: 文件已存在，不能 Add File: {path}"
        _old, content = _hunk_old_new(hunk_lines)
        if not content:
            content = "\n".join(
                line[1:] if line[:1] in "+ " else line
                for line in hunk_lines
                if not line.startswith("***")
            )
        FileHistory(self.root).snapshot_before(path, "apply_patch")
        p.parent.mkdir(parents=True, exist_ok=True)
        if content and not content.endswith("\n"):
            content += "\n"
        p.write_text(content, encoding="utf-8")
        return f"已新建 {path}"

    def _apply_delete_file(self, path: str) -> str:
        if self._is_memory_file(path):
            return f"错误: 不能删除记忆文件: {path}"
        p = self.resolve(path)
        if not p.is_file():
            return f"错误: 文件不存在: {path}"
        FileHistory(self.root).snapshot_before(path, "apply_patch")
        p.unlink()
        return f"已删除 {path}"

    def apply_patch(self, patch: str) -> str:
        raw = patch or ""
        if not raw.strip():
            return "错误: patch 为空"
        body = raw
        begin = body.find("*** Begin Patch")
        if begin >= 0:
            body = body[begin + len("*** Begin Patch") :]
        end = body.find("*** End Patch")
        if end >= 0:
            body = body[:end]

        notes: list[str] = []
        op: str | None = None
        path = ""
        hunk: list[str] = []

        def flush_hunk() -> None:
            nonlocal hunk
            if op == "update" and path and hunk:
                notes.append(self._apply_update_hunk(path, hunk))
            elif op == "add" and path and hunk:
                notes.append(self._apply_add_file(path, hunk))
            hunk = []

        def flush_file() -> None:
            nonlocal op, path
            flush_hunk()
            if op == "delete" and path:
                notes.append(self._apply_delete_file(path))
            op = None
            path = ""

        for line in body.splitlines():
            if line.startswith("*** Update File:"):
                flush_file()
                op = "update"
                path = line.split(":", 1)[1].strip()
                hunk = []
            elif line.startswith("*** Add File:"):
                flush_file()
                op = "add"
                path = line.split(":", 1)[1].strip()
                hunk = []
            elif line.startswith("*** Delete File:"):
                flush_file()
                op = "delete"
                path = line.split(":", 1)[1].strip()
                hunk = []
            elif line.startswith("@@"):
                if op == "update":
                    flush_hunk()
                else:
                    hunk.append(line)
            else:
                hunk.append(line)
        flush_file()
        if not notes:
            return "错误: 补丁里没有 Update/Add/Delete File 段。请按 apply_patch 说明的格式。"
        return "\n".join(notes)

    def list_dir(self, path: str = ".") -> str:
        p = self.resolve(path)
        if not p.is_dir():
            return f"错误: 目录不存在: {path}"
        names = []
        for child in sorted(p.iterdir(), key=lambda x: (x.is_file(), x.name.lower())):
            if child.is_dir() and _skip_dir(child.name):
                continue
            if child.name in {".env", ".DS_Store"}:
                continue
            tag = "dir" if child.is_dir() else "file"
            names.append(f"{tag}\t{child.name}")
        return "\n".join(names) if names else "(空目录)"

    def _outside_path(self, cwd: Path, dest: str) -> str | None:
        dest = (dest or "").strip().strip('"').strip("'")
        if not dest:
            return None
        if dest.upper() in {"NUL", "CON", "PRN", "AUX"} or dest in {"/dev/null"}:
            return None
        if dest in ("/", "\\"):
            return "错误: 路径不允许逃出工作区"
        target = Path(dest) if re.match(r"^[a-zA-Z]:", dest) else (cwd / dest)
        try:
            resolved = target.resolve()
            resolved.relative_to(self.root)
        except (OSError, ValueError):
            return f"错误: 路径不允许逃出工作区: {dest}"
        return None

    def _shell_guard(self, command: str) -> str | None:
        pieces = re.split(r"\s*(?:&&|&|\|\||\|)\s*", command)
        cwd = self.root
        for raw in pieces:
            part = raw.strip()
            if not part:
                continue
            matched = re.match(r"^(?:cd|chdir)(?:\s+/d)?(?:\s+(.*))?$", part, re.I)
            if matched:
                dest = (matched.group(1) or "").strip().strip('"').strip("'")
                if dest:
                    err = self._outside_path(cwd, dest)
                    if err:
                        return err
                    target = Path(dest) if re.match(r"^[a-zA-Z]:", dest) else (cwd / dest)
                    try:
                        cwd = target.resolve()
                    except OSError:
                        return f"错误: 路径不允许逃出工作区: {dest}"
            for dest in _redirect_targets(part):
                err = self._outside_path(cwd, dest)
                if err:
                    return err
            for dest in _path_candidates(part):
                err = self._outside_path(cwd, dest)
                if err:
                    return err
        return None

    def run_shell(self, command: str) -> str:
        command = (command or "").strip()
        if not command:
            return "错误: 命令为空"
        blocked = self._shell_guard(_expand_command(command))
        if blocked:
            return blocked
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


def _as_int(value, default: int | None = None) -> int | None:
    if value is None or value == "":
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def dispatch(workspace: Workspace, name: str, arguments: str) -> str:
    """根据模型给出的工具名和 JSON 参数，在本地执行并返回字符串结果。"""
    try:
        args = json.loads(arguments) if arguments else {}
        if not isinstance(args, dict):
            return "错误: 工具参数必须是 JSON 对象"
    except json.JSONDecodeError as exc:
        return f"错误: 无法解析工具参数 JSON: {exc}"

    try:
        if name == "glob":
            return workspace.glob(args.get("pattern", ""), args.get("path", "."))
        if name == "grep":
            return workspace.grep(
                args.get("pattern", ""),
                args.get("path", "."),
                args.get("glob", "") or "",
                bool(args.get("regex", False)),
            )
        if name == "read_file":
            return workspace.read_file(
                args.get("path", ""),
                _as_int(args.get("offset"), 1),
                _as_int(args.get("limit")),
            )
        if name == "write_file":
            return workspace.write_file(args.get("path", ""), args.get("content", ""))
        if name == "apply_patch":
            return workspace.apply_patch(args.get("patch", ""))
        if name == "edit_file":
            return workspace.edit_file(
                args.get("path", ""), args.get("old", ""), args.get("new", "")
            )
        if name == "list_dir":
            return workspace.list_dir(args.get("path", "."))
        if name == "todo":
            items = args.get("items")
            if isinstance(items, str):
                try:
                    items = json.loads(items)
                except json.JSONDecodeError:
                    return "错误: items 不是合法 JSON 数组"
            return TaskTodos(workspace.root).update(items if isinstance(items, list) else [])
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
