"""记忆：项目约定、情节日志、任务检查点、多对话会话落盘。不使用 agent 框架。"""

from __future__ import annotations

import json
import re
from datetime import date, datetime
from pathlib import Path

import config

AGENT_DIR = ".agent"
PROJECT_JSON = "project.json"
MEMORY_MD = "MEMORY.md"
EPISODES_FILE = "episodes.jsonl"
TASKS_JSON = "tasks.json"
CHECKPOINT_MD = "WORKING.md"
SESSION_NAME = "session.json"
CONVERSATIONS_JSON = "conversations.json"
CONVERSATIONS_DIR = "conversations"
TITLE_MAX = 32

KINDS = ("env", "command", "constraint", "decision")

_STOP = {
    "这个", "那个", "一个", "我们", "你们", "什么", "怎么", "怎样", "如果",
    "可以", "不要", "不是", "没有", "以及", "或者", "还有", "进行", "使用",
    "代码", "文件", "项目", "仓库", "一下", "直接", "回答", "告诉",
    "the", "and", "for", "with", "from", "this", "that", "have", "just",
}

_CJK = re.compile(r"[\u4e00-\u9fff]+")
_WORD = re.compile(r"[a-z0-9_\-./]{2,}", re.I)


def tokenize(text: str) -> set[str]:
    text = (text or "").lower()
    tokens: set[str] = set()
    for m in _WORD.finditer(text):
        w = m.group(0).strip("./")
        if len(w) >= 2:
            tokens.add(w)
    for chunk in _CJK.findall(text):
        if len(chunk) <= 4:
            tokens.add(chunk)
        else:
            tokens.add(chunk)
            for i in range(len(chunk) - 1):
                tokens.add(chunk[i : i + 2])
    return {t for t in tokens if t not in _STOP and len(t) >= 2}


def _today() -> str:
    return date.today().isoformat()


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _agent_dir(root: Path) -> Path:
    return Path(root).resolve() / AGENT_DIR


def files_from_tool(name: str, arguments: str) -> list[str]:
    try:
        args = json.loads(arguments) if arguments else {}
    except json.JSONDecodeError:
        return []
    if not isinstance(args, dict):
        return []
    path = args.get("path")
    if isinstance(path, str) and path.strip() and name in {
        "read_file",
        "write_file",
        "edit_file",
        "list_dir",
    }:
        return [path.strip()]
    return []


class ProjectMemory:
    """项目记忆：json 为真相，MEMORY.md 给人看。更新=旧条废弃+追加新条。"""

    def __init__(self, workspace_root: str | Path) -> None:
        self.root = Path(workspace_root).resolve()
        self.dir = _agent_dir(self.root)
        self.json_path = self.dir / PROJECT_JSON
        self.path = self.dir / MEMORY_MD  # 兼容旧入口打印
        self._migrate_legacy_md()

    def _load(self) -> dict:
        if not self.json_path.is_file():
            return {"next_id": 1, "entries": []}
        try:
            data = json.loads(self.json_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return {"next_id": 1, "entries": []}
        if not isinstance(data, dict):
            return {"next_id": 1, "entries": []}
        data.setdefault("next_id", 1)
        data.setdefault("entries", [])
        return data

    def _save(self, data: dict) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        self.json_path.write_text(
            json.dumps(data, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        self.path.write_text(self._render_md(data), encoding="utf-8")

    def _migrate_legacy_md(self) -> None:
        if self.json_path.is_file() or not self.path.is_file():
            return
        data = {"next_id": 1, "entries": []}
        for line in self.path.read_text(encoding="utf-8", errors="replace").splitlines():
            stripped = line.strip()
            if not stripped.startswith("- "):
                continue
            body = stripped[2:].strip()
            fact = body
            if len(body) >= 12 and body[4] == "-" and body[7] == "-" and body[10:12] == ": ":
                fact = body[12:].strip()
            if not fact:
                continue
            eid = f"m{data['next_id']:03d}"
            data["next_id"] += 1
            data["entries"].append(
                {
                    "id": eid,
                    "kind": "decision",
                    "fact": fact,
                    "status": "active",
                    "updated": _today(),
                    "deprecated_reason": None,
                    "superseded_by": None,
                }
            )
        if data["entries"]:
            self._save(data)

    def catalog(self) -> str:
        active = [e for e in self._load()["entries"] if e.get("status") == "active"]
        if not active:
            return "（尚无有效的项目约定）"
        lines = ["仅列出当前有效条目；废弃约定默认不注入。"]
        for e in active:
            lines.append(f"- {e['id']} [{e.get('kind', 'decision')}] {e['fact']}")
        return "\n".join(lines)

    def remember(self, fact: str, kind: str = "decision") -> str:
        fact = (fact or "").strip()
        kind = (kind or "decision").strip().lower()
        if not fact:
            return "错误: 记忆内容为空"
        if kind not in KINDS:
            return f"错误: kind 必须是 {', '.join(KINDS)} 之一"
        data = self._load()
        for e in data["entries"]:
            if e.get("status") == "active" and e.get("fact") == fact:
                return f"这条记忆已存在（{e['id']}），未重复写入"
        overlap = self._conflicts(data, fact)
        if overlap:
            listing = "\n".join(f"- {e['id']}: {e['fact']}" for e in overlap)
            return (
                "错误: 已有相近的有效约定，请用 update_memory 更新而不是再记一条：\n"
                + listing
            )
        eid = f"m{data['next_id']:03d}"
        data["next_id"] += 1
        data["entries"].append(
            {
                "id": eid,
                "kind": kind,
                "fact": fact,
                "status": "active",
                "updated": _today(),
                "deprecated_reason": None,
                "superseded_by": None,
            }
        )
        self._save(data)
        return f"已写入项目记忆 {eid} [{kind}]: {fact}"

    def recall(self, query: str = "", include_deprecated: bool = False) -> str:
        entries = self._load()["entries"]
        if not include_deprecated:
            entries = [e for e in entries if e.get("status") == "active"]
        if not entries:
            return "（尚无有效的项目约定）"
        query = (query or "").strip()
        if query:
            q = query.lower()
            entries = [
                e
                for e in entries
                if q in e.get("fact", "").lower() or q == e.get("id", "").lower()
            ]
            if not entries:
                return f"（没有与 {query!r} 匹配的有效约定）"
        lines = []
        for e in entries:
            mark = "当前" if e.get("status") == "active" else "废弃"
            extra = ""
            if e.get("status") != "active" and e.get("deprecated_reason"):
                extra = f" （{e['deprecated_reason']}）"
            lines.append(
                f"- {e['id']} [{mark}/{e.get('kind', 'decision')}] {e['fact']}{extra}"
            )
        return "\n".join(lines)

    def update(self, old: str, new: str, kind: str = "") -> str:
        old = (old or "").strip()
        new = (new or "").strip()
        if not old or not new:
            return "错误: old 和 new 都不能为空"
        data = self._load()
        active = [e for e in data["entries"] if e.get("status") == "active"]
        idxs = self._match_indexes(active, old)
        if not idxs:
            return f"错误: 没有与 {old!r} 匹配的有效约定"
        if len(idxs) > 1:
            listing = "\n".join(f"- {active[i]['id']}: {active[i]['fact']}" for i in idxs)
            return f"错误: 匹配到 {len(idxs)} 条，请把 old 写得更具体或用 id：\n{listing}"
        previous = active[idxs[0]]
        new_kind = (kind or previous.get("kind") or "decision").strip().lower()
        if new_kind not in KINDS:
            return f"错误: kind 必须是 {', '.join(KINDS)} 之一"
        eid = f"m{data['next_id']:03d}"
        data["next_id"] += 1
        previous["status"] = "deprecated"
        previous["deprecated_reason"] = f"已被 {eid} 取代"
        previous["superseded_by"] = eid
        previous["updated"] = _today()
        data["entries"].append(
            {
                "id": eid,
                "kind": new_kind,
                "fact": new,
                "status": "active",
                "updated": _today(),
                "deprecated_reason": None,
                "superseded_by": None,
            }
        )
        self._save(data)
        return (
            f"已更新项目记忆（旧条目标为废弃，而非覆盖）：\n"
            f"废弃 {previous['id']}: {previous['fact']}\n"
            f"当前 {eid}: {new}"
        )

    def forget(self, query: str) -> str:
        query = (query or "").strip()
        if not query:
            return "错误: 请提供要废弃的关键字或 id"
        data = self._load()
        active = [e for e in data["entries"] if e.get("status") == "active"]
        idxs = self._match_indexes(active, query)
        if not idxs:
            return f"错误: 没有与 {query!r} 匹配的有效约定"
        if len(idxs) > 1:
            listing = "\n".join(f"- {active[i]['id']}: {active[i]['fact']}" for i in idxs)
            return f"错误: 匹配到 {len(idxs)} 条，请把关键字写得更具体：\n{listing}"
        target = active[idxs[0]]
        target["status"] = "deprecated"
        target["deprecated_reason"] = "用户声明不再需要"
        target["updated"] = _today()
        self._save(data)
        return f"已废弃项目记忆 {target['id']}: {target['fact']}（条目保留，默认不再召回）"

    def deprecated_count(self) -> int:
        return sum(1 for e in self._load()["entries"] if e.get("status") == "deprecated")

    def _conflicts(self, data: dict, fact: str) -> list[dict]:
        tokens = tokenize(fact)
        hits = []
        for e in data["entries"]:
            if e.get("status") != "active":
                continue
            shared = tokens & tokenize(e.get("fact", ""))
            if len(shared) >= 2:
                hits.append(e)
        return hits

    def _match_indexes(self, entries: list[dict], query: str) -> list[int]:
        q = query.lower()
        return [
            i
            for i, e in enumerate(entries)
            if q == e.get("id", "").lower() or q in e.get("fact", "").lower()
        ]

    def _render_md(self, data: dict) -> str:
        active = [e for e in data["entries"] if e.get("status") == "active"]
        dead = [e for e in data["entries"] if e.get("status") == "deprecated"]
        lines = ["# 项目记忆", "", "## 当前有效"]
        if active:
            for e in active:
                lines.append(f"- [当前] {e['id']} [{e.get('kind', 'decision')}] {e['fact']}")
        else:
            lines.append("（无）")
        lines += ["", "## 已废弃（默认不召回）"]
        if dead:
            for e in dead:
                reason = e.get("deprecated_reason") or ""
                lines.append(
                    f"- [废弃] {e['id']} [{e.get('kind', 'decision')}] {e['fact']}"
                    + (f" — {reason}" if reason else "")
                )
        else:
            lines.append("（无）")
        lines.append("")
        return "\n".join(lines)


LongTermMemory = ProjectMemory


class EpisodeLog:
    def __init__(self, workspace_root: str | Path) -> None:
        self.root = Path(workspace_root).resolve()
        self.path = _agent_dir(self.root) / EPISODES_FILE

    def load_all(self) -> list[dict]:
        if not self.path.is_file():
            return []
        rows = []
        for line in self.path.read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                item = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(item, dict):
                rows.append(item)
        return rows

    def append(
        self,
        user: str,
        tools: list[str],
        files: list[str],
        outcome: str,
        summary: str,
    ) -> dict:
        rows = self.load_all()
        eid = f"e{len(rows) + 1:03d}"
        blob = " ".join([user, summary, *files, *tools])
        episode = {
            "id": eid,
            "time": _now(),
            "user": user,
            "tools": tools,
            "files": sorted(set(files)),
            "outcome": outcome,
            "summary": (summary or "")[:240],
            "triggers": sorted(tokenize(blob)),
        }
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(episode, ensure_ascii=False) + "\n")
        return episode

    def search(self, query: str, limit: int = 3) -> list[tuple[int, dict]]:
        q_tokens = tokenize(query)
        scored: list[tuple[int, dict]] = []
        for ep in self.load_all():
            triggers = set(ep.get("triggers") or [])
            if not triggers:
                triggers = tokenize(
                    " ".join(
                        [
                            ep.get("user") or "",
                            ep.get("summary") or "",
                            " ".join(ep.get("files") or []),
                        ]
                    )
                )
            shared = q_tokens & triggers
            score = len(shared)
            for path in ep.get("files") or []:
                pl = str(path).lower().replace("\\", "/")
                ql = query.lower().replace("\\", "/")
                name = Path(path).name.lower()
                if pl in ql or (name and name in ql):
                    score += 2
            if score <= 0:
                continue
            strong = any(
                len(t) >= 4
                or "." in t
                or "/" in t
                or "\\" in t
                or (len(t) >= 3 and _CJK.fullmatch(t) is not None)
                for t in shared
            )
            if score < config.EPISODE_RECALL_MIN_SCORE and not (score == 1 and strong):
                continue
            scored.append((score, ep))
        scored.sort(key=lambda x: (x[0], x[1].get("id", "")), reverse=True)
        return scored[:limit]

    def format_hits(self, hits: list[tuple[int, dict]]) -> str:
        if not hits:
            return "（本次任务没有命中历史情节，按新问题处理）"
        lines = ["仅注入关键词命中的条目，不是全量加载。"]
        for score, ep in hits:
            files = ", ".join(ep.get("files") or []) or "—"
            lines.append(
                f"- {ep.get('id')} (score={score}) {ep.get('user')}\n"
                f"  摘要: {ep.get('summary')}\n"
                f"  文件: {files}"
            )
        return "\n".join(lines)


class TaskQueue:
    """任务队列：追加不覆盖。未完成条目一直留着，问进度不会把它擦掉。"""

    _INSPECT_MARKERS = (
        "做到哪",
        "做到哪儿",
        "现在进度",
        "当前进度",
        "哪一步",
        "进度如何",
        "进行到哪",
        "现在哪了",
        "改了哪些文件",
        "上次改了",
    )
    _RESUME_MARKERS = ("继续", "接着", "做完", "接着做", "接着干", "恢复任务")

    def __init__(self, workspace_root: str | Path) -> None:
        self.root = Path(workspace_root).resolve()
        self.path = _agent_dir(self.root) / TASKS_JSON
        self.md_path = _agent_dir(self.root) / CHECKPOINT_MD
        self.sessions_dir = _agent_dir(self.root) / "sessions"
        self._migrate_legacy_checkpoint()

    def _load(self) -> dict:
        if not self.path.is_file():
            return {"next_id": 1, "items": []}
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return {"next_id": 1, "items": []}
        if not isinstance(data, dict):
            return {"next_id": 1, "items": []}
        data.setdefault("next_id", 1)
        data.setdefault("items", [])
        return data

    def _save(self, data: dict) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(
            json.dumps(data, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        self.md_path.write_text(self._render_md(data), encoding="utf-8")

    def _migrate_legacy_checkpoint(self) -> None:
        if self.path.is_file():
            return
        old = _agent_dir(self.root) / "checkpoint.json"
        if not old.is_file():
            return
        try:
            raw = json.loads(old.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return
        if not isinstance(raw, dict) or not raw.get("goal"):
            return
        data = {
            "next_id": 2,
            "items": [
                {
                    "id": "t001",
                    "kind": "work",
                    "goal": raw.get("goal") or "",
                    "status": "done" if raw.get("finished") else "interrupted",
                    "finished": bool(raw.get("finished")),
                    "last_tools": raw.get("last_tools") or [],
                    "files": raw.get("files") or [],
                    "summary": raw.get("summary") or "",
                    "outcome": "ok" if raw.get("finished") else "max_steps",
                    "updated": raw.get("updated") or _now(),
                }
            ],
        }
        self._save(data)

    def open_items(self) -> list[dict]:
        return [
            e
            for e in self._load()["items"]
            if e.get("kind") != "inspect" and not e.get("finished")
        ]

    def is_inspect(self, task: str) -> bool:
        t = task or ""
        return any(m in t for m in self._INSPECT_MARKERS)

    def is_resume_phrase(self, task: str) -> bool:
        t = task or ""
        return any(m in t for m in self._RESUME_MARKERS)

    def find_resume(self, task: str) -> dict | None:
        opened = self.open_items()
        if not opened:
            return None
        if self.is_resume_phrase(task):
            return opened[-1]
        q = tokenize(task)
        best: tuple[int, dict] | None = None
        for row in opened:
            score = len(q & tokenize(row.get("goal") or ""))
            for path in row.get("files") or []:
                name = Path(str(path)).name.lower()
                if name and name in task.lower():
                    score += 2
            if best is None or score > best[0]:
                best = (score, row)
        if best and best[0] >= 2:
            return best[1]
        return None

    def start(self, task: str, messages: list[dict]) -> tuple[str, dict]:
        if self.is_inspect(task):
            return "inspect", {"id": None, "kind": "inspect"}
        has_user = any(m.get("role") == "user" for m in messages)
        target = self.find_resume(task)
        if target is not None and (self.is_resume_phrase(task) or not has_user):
            if not has_user:
                loaded = self.load_task_session(target["id"])
                if loaded:
                    messages.clear()
                    messages.extend(loaded)
                    print(f"已接上未完成任务 {target['id']}")
            return "resume", target
        data = self._load()
        tid = f"t{data['next_id']:03d}"
        data["next_id"] += 1
        item = {
            "id": tid,
            "kind": "work",
            "goal": task,
            "status": "in_progress",
            "finished": False,
            "last_tools": [],
            "files": [],
            "summary": "",
            "outcome": "",
            "updated": _now(),
        }
        data["items"].append(item)
        self._save(data)
        return "new", item

    def record(
        self,
        mode: str,
        item: dict,
        task: str,
        tools: list[str],
        files: list[str],
        finished: bool,
        outcome: str,
        summary: str,
    ) -> None:
        data = self._load()
        summary_one = " ".join((summary or "").split())[:240]
        file_list = sorted(set(files))
        tool_list = tools[-8:]
        if mode == "inspect":
            tid = f"t{data['next_id']:03d}"
            data["next_id"] += 1
            data["items"].append(
                {
                    "id": tid,
                    "kind": "inspect",
                    "goal": task,
                    "status": "done",
                    "finished": True,
                    "last_tools": tool_list,
                    "files": file_list,
                    "summary": summary_one,
                    "outcome": outcome,
                    "updated": _now(),
                }
            )
            self._save(data)
            return
        tid = item.get("id")
        for row in data["items"]:
            if row.get("id") == tid:
                row["last_tools"] = tool_list
                row["files"] = file_list
                row["summary"] = summary_one
                row["outcome"] = outcome
                row["updated"] = _now()
                row["finished"] = finished
                if finished:
                    row["status"] = "done"
                elif outcome in {"max_steps", "interrupted"}:
                    row["status"] = "interrupted"
                else:
                    row["status"] = "in_progress"
                break
        self._save(data)

    def save_task_session(self, task_id: str | None, messages: list[dict]) -> None:
        if not task_id:
            return
        self.sessions_dir.mkdir(parents=True, exist_ok=True)
        path = self.sessions_dir / f"{task_id}.json"
        path.write_text(
            json.dumps(messages, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    def load_task_session(self, task_id: str) -> list[dict] | None:
        path = self.sessions_dir / f"{task_id}.json"
        if not path.is_file():
            return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return None
        if not isinstance(data, list):
            return None
        return data

    def format_for_prompt(self) -> str:
        data = self._load()
        opened = [
            e
            for e in data["items"]
            if e.get("kind") != "inspect" and not e.get("finished")
        ]
        recent = data["items"][-8:]
        lines = []
        if opened:
            lines.append("进行中（问进度看这里；说「继续」接最新一条未完成）：")
            for e in opened:
                lines.append(self._line(e))
        else:
            lines.append("进行中：无")
        lines.append("最近记录（可回溯；询问不会覆盖进行中的工作任务）：")
        if recent:
            for e in recent:
                lines.append(self._line(e))
        else:
            lines.append("（空）")
        return "\n".join(lines)

    def _line(self, e: dict) -> str:
        kind = e.get("kind") or "work"
        status = e.get("status") or ("done" if e.get("finished") else "in_progress")
        files = ", ".join(e.get("files") or []) or "—"
        return (
            f"- {e.get('id')} [{kind}/{status}] {e.get('goal')}\n"
            f"  文件: {files}\n"
            f"  摘要: {e.get('summary') or '—'}"
        )

    def _render_md(self, data: dict) -> str:
        opened = [
            e
            for e in data["items"]
            if e.get("kind") != "inspect" and not e.get("finished")
        ]
        lines = ["# 任务队列", "", "## 进行中（可继续）"]
        if opened:
            for e in opened:
                lines.append(f"- {e['id']} [{e.get('status')}] {e.get('goal')}")
                lines.append(f"  - 文件：{', '.join(e.get('files') or []) or '—'}")
                lines.append(f"  - 摘要：{e.get('summary') or '—'}")
        else:
            lines.append("（无）")
        lines += ["", "## 最近记录（可回溯）"]
        recent = data["items"][-12:]
        if recent:
            for e in reversed(recent):
                lines.append(
                    f"- {e['id']} [{e.get('kind')}/{e.get('status')}] {e.get('goal')}"
                )
        else:
            lines.append("（无）")
        lines.append("")
        return "\n".join(lines)


Checkpoint = TaskQueue


def health_check(workspace_root: Path) -> list[str]:
    notes = []
    episodes = EpisodeLog(workspace_root).load_all()
    n = len(episodes)
    notes.append(f"情节 {n}/{config.EPISODE_WARN} 条")
    if n >= config.EPISODE_WARN:
        notes.append(
            f"情节已达 {config.EPISODE_WARN} 条上限提示：可把旧记录挪到归档文件，"
            "当前不会自动删除。"
        )
    deprecated = ProjectMemory(workspace_root).deprecated_count()
    notes.append(f"废弃约定 {deprecated} 条（默认不召回，仍留在 project.json）")
    opened = TaskQueue(workspace_root).open_items()
    notes.append(f"未完成任务 {len(opened)} 条")
    if deprecated >= config.DEPRECATED_WARN:
        notes.append(
            f"废弃约定已有 {deprecated} 条，演示时可打开 MEMORY.md 的「已废弃」一节核对，"
            "不会自动抹掉。"
        )
    return notes


def session_file(workspace_root: Path) -> Path:
    return _agent_dir(workspace_root) / SESSION_NAME


def _read_session_json(workspace_root: Path) -> list[dict] | None:
    path = session_file(workspace_root)
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None
    if not isinstance(data, list):
        return None
    return data


def _write_session_json(workspace_root: Path, messages: list[dict]) -> None:
    path = session_file(workspace_root)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(messages, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def title_from_messages(messages: list[dict]) -> str:
    for m in messages:
        if m.get("role") != "user":
            continue
        text = " ".join(str(m.get("content") or "").split())
        if text:
            return text[:TITLE_MAX]
    return "新对话"


def has_user_message(messages: list[dict]) -> bool:
    return any(m.get("role") == "user" for m in messages)


class ConversationStore:
    """多对话：每份 messages 独立落盘。项目约定 / 情节 / 任务队列仍按工作区共享。"""

    def __init__(self, workspace_root: str | Path) -> None:
        self.root = Path(workspace_root).resolve()
        self.dir = _agent_dir(self.root)
        self.index_path = self.dir / CONVERSATIONS_JSON
        self.files_dir = self.dir / CONVERSATIONS_DIR
        self._migrate_and_ensure()

    def _empty_index(self) -> dict:
        return {"active_id": None, "next_id": 1, "items": []}

    def _load_index(self) -> dict:
        if not self.index_path.is_file():
            return self._empty_index()
        try:
            data = json.loads(self.index_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return self._empty_index()
        if not isinstance(data, dict):
            return self._empty_index()
        data.setdefault("active_id", None)
        data.setdefault("next_id", 1)
        data.setdefault("items", [])
        return data

    def _save_index(self, data: dict) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        self.index_path.write_text(
            json.dumps(data, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    def _path_for(self, cid: str) -> Path:
        return self.files_dir / f"{cid}.json"

    def _load_messages(self, cid: str) -> list[dict]:
        path = self._path_for(cid)
        if not path.is_file():
            return []
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return []
        return data if isinstance(data, list) else []

    def _write_messages(self, cid: str, messages: list[dict]) -> None:
        self.files_dir.mkdir(parents=True, exist_ok=True)
        self._path_for(cid).write_text(
            json.dumps(messages, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    def _new_id(self, data: dict) -> str:
        cid = f"c{data['next_id']:03d}"
        data["next_id"] = int(data["next_id"]) + 1
        return cid

    def _add_item(self, data: dict, cid: str, title: str) -> None:
        data["items"].append(
            {"id": cid, "title": title, "updated": _now()}
        )

    def _touch(self, data: dict, cid: str, messages: list[dict]) -> None:
        title = title_from_messages(messages)
        for row in data["items"]:
            if row.get("id") == cid:
                row["title"] = title
                row["updated"] = _now()
                return
        self._add_item(data, cid, title)

    def _migrate_and_ensure(self) -> None:
        if self.index_path.is_file():
            data = self._load_index()
            if data.get("items"):
                if not data.get("active_id"):
                    data["active_id"] = data["items"][-1]["id"]
                    self._save_index(data)
                return
        data = self._empty_index()
        cid = self._new_id(data)
        old = _read_session_json(self.root) or []
        self._write_messages(cid, old)
        self._add_item(data, cid, title_from_messages(old))
        data["active_id"] = cid
        self._save_index(data)
        _write_session_json(self.root, old)

    def list_payload(self) -> dict:
        data = self._load_index()
        items = [row for row in (data.get("items") or []) if isinstance(row, dict)]
        return {"active_id": data.get("active_id"), "items": items}

    def load_active(self) -> list[dict]:
        data = self._load_index()
        cid = data.get("active_id")
        if not cid:
            return []
        return self._load_messages(cid)

    def save(self, messages: list[dict], cid: str | None = None) -> None:
        data = self._load_index()
        target = cid or data.get("active_id")
        if not target:
            target = self._new_id(data)
            data["active_id"] = target
        self._write_messages(target, messages)
        self._touch(data, target, messages)
        data["active_id"] = target
        self._save_index(data)
        _write_session_json(self.root, messages)

    def create(self, current: list[dict]) -> list[dict]:
        if not has_user_message(current):
            return list(current)
        self.save(current)
        data = self._load_index()
        cid = self._new_id(data)
        self._write_messages(cid, [])
        self._add_item(data, cid, "新对话")
        data["active_id"] = cid
        self._save_index(data)
        _write_session_json(self.root, [])
        return []

    def select(self, cid: str, current: list[dict]) -> list[dict]:
        data = self._load_index()
        if not any(row.get("id") == cid for row in data.get("items") or []):
            raise KeyError(cid)
        active = data.get("active_id")
        if active and active != cid:
            self.save(current, cid=active)
            data = self._load_index()
        data["active_id"] = cid
        self._save_index(data)
        loaded = self._load_messages(cid)
        _write_session_json(self.root, loaded)
        return loaded

    def reorder(self, ids: list[str]) -> None:
        data = self._load_index()
        by_id = {
            row.get("id"): row
            for row in data.get("items") or []
            if isinstance(row, dict) and row.get("id")
        }
        next_items = []
        seen: set[str] = set()
        for cid in ids:
            row = by_id.get(cid)
            if not row or cid in seen:
                continue
            seen.add(cid)
            next_items.append(row)
        for row in data.get("items") or []:
            if not isinstance(row, dict):
                continue
            cid = row.get("id")
            if cid and cid not in seen:
                next_items.append(row)
                seen.add(cid)
        data["items"] = next_items
        self._save_index(data)

    def snapshot(self, messages: list[dict] | None = None) -> dict:
        payload = self.list_payload()
        payload["messages"] = (
            list(messages) if messages is not None else self.load_active()
        )
        return payload


STATE_DIR = Path(__file__).resolve().parent / ".app-state"
WORKSPACES_JSON = STATE_DIR / "workspaces.json"


def _load_workspace_index() -> dict:
    if not WORKSPACES_JSON.is_file():
        return {"items": []}
    try:
        data = json.loads(WORKSPACES_JSON.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {"items": []}
    if not isinstance(data, dict):
        return {"items": []}
    data.setdefault("items", [])
    return data


def _save_workspace_index(data: dict) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    WORKSPACES_JSON.write_text(
        json.dumps(data, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def project_workspace(path: str | Path) -> Path:
    """把误选的 `.agent/...` 目录收回到真正的项目根。"""
    try:
        root = Path(path).expanduser().resolve()
    except OSError:
        return Path(path)
    parts = root.parts
    try:
        idx = parts.index(".agent")
    except ValueError:
        return root
    if idx <= 0:
        return root
    return Path(*parts[:idx])


def remember_workspace(path: str | Path) -> None:
    root = project_workspace(path)
    if not root.is_dir():
        return
    data = _load_workspace_index()
    key = str(root)
    items = []
    seen: set[str] = set()
    found = False
    for row in data.get("items") or []:
        raw = row.get("path") or ""
        if not raw:
            continue
        cleaned = project_workspace(raw)
        ck = str(cleaned)
        if ck in seen or not cleaned.is_dir():
            continue
        seen.add(ck)
        if ck == key:
            found = True
            items.append({"path": key, "name": root.name, "opened": _now()})
        else:
            items.append(
                {
                    "path": ck,
                    "name": cleaned.name,
                    "opened": row.get("opened") or _now(),
                }
            )
    if not found:
        items.append({"path": key, "name": root.name, "opened": _now()})
    data["items"] = items[:24]
    _save_workspace_index(data)


def reorder_workspaces(paths: list[str]) -> None:
    data = _load_workspace_index()
    by_key: dict[str, dict] = {}
    for row in data.get("items") or []:
        raw = row.get("path") or ""
        if not raw:
            continue
        cleaned = project_workspace(raw)
        if not cleaned.is_dir():
            continue
        key = str(cleaned)
        if key not in by_key:
            by_key[key] = {
                "path": key,
                "name": cleaned.name,
                "opened": row.get("opened") or _now(),
            }
    items = []
    seen: set[str] = set()
    for raw in paths:
        if not raw:
            continue
        key = str(project_workspace(raw))
        row = by_key.get(key)
        if not row or key in seen:
            continue
        seen.add(key)
        items.append(row)
    for key, row in by_key.items():
        if key not in seen:
            items.append(row)
    data["items"] = items[:24]
    _save_workspace_index(data)


def list_known_workspaces(current: str | Path) -> list[Path]:
    current_root = project_workspace(current)
    here = Path(__file__).resolve().parent
    ordered: list[Path] = []
    seen: set[str] = set()

    def add(path: Path) -> None:
        try:
            root = project_workspace(path)
        except OSError:
            return
        if not root.is_dir():
            return
        key = str(root)
        if key in seen:
            return
        seen.add(key)
        ordered.append(root)

    for row in _load_workspace_index().get("items") or []:
        raw = row.get("path")
        if raw:
            add(Path(raw))
    add(here / "demo_multi")
    add(here / "demo")
    add(current_root)
    return ordered


def peek_conversation_items(root: Path) -> list[dict]:
    index_path = _agent_dir(root) / CONVERSATIONS_JSON
    if not index_path.is_file():
        return []
    try:
        data = json.loads(index_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return []
    items = data.get("items") or []
    if not isinstance(items, list):
        return []
    return [row for row in items if isinstance(row, dict)]


def grouped_conversation_payload(
    workspace_root: str | Path,
    messages: list[dict] | None = None,
) -> dict:
    current = project_workspace(workspace_root)
    snap = ConversationStore(current).snapshot(messages)
    groups = []
    for path in list_known_workspaces(current):
        is_current = path == current
        groups.append(
            {
                "path": str(path),
                "name": path.name,
                "current": is_current,
                "items": snap["items"] if is_current else peek_conversation_items(path),
            }
        )
    snap["workspaces"] = groups
    snap["workspace"] = str(current)
    snap["workspace_name"] = current.name
    return snap


def save_session(workspace_root: Path, messages: list[dict]) -> None:
    ConversationStore(workspace_root).save(messages)


def load_session(workspace_root: Path) -> list[dict] | None:
    store = ConversationStore(workspace_root)
    loaded = store.load_active()
    return loaded if loaded else None
