"""本地 HTTP API：文件树、读文件、把 Agent 事件推给前端。不使用 agent 框架。"""

from __future__ import annotations

import json
import threading
import uuid
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import agent
import llm
from file_history import FileHistory
from memory import (
    ConversationStore,
    TaskQueue,
    grouped_conversation_payload,
    project_workspace,
    remember_workspace,
    reorder_workspaces,
    save_session,
)
from tools import Workspace

SKIP_DIRS = {
    ".git",
    "__pycache__",
    ".venv",
    "venv",
    "node_modules",
    ".pytest_cache",
    ".mypy_cache",
}
SKIP_FILES = {".DS_Store"}
MAX_TREE_DEPTH = 8
MAX_PREVIEW_BYTES = 800_000

WEB_DIR = Path(__file__).resolve().parent / "web"

app = FastAPI(title="coding-agent")


@app.middleware("http")
async def no_store_static(request, call_next):
    response = await call_next(request)
    path = request.url.path
    if path == "/" or path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-store, max-age=0"
    return response

_lock = threading.Lock()
_busy = False
_cancel = False
_workspace = Path(".").resolve()
_messages: list[dict[str, Any]] = []
_client = None
_jobs: dict[str, dict[str, Any]] = {}


class ChatReq(BaseModel):
    task: str


class WorkspaceReq(BaseModel):
    path: str


class PathReq(BaseModel):
    path: str


class SaveReq(BaseModel):
    path: str
    content: str


class ShellReq(BaseModel):
    command: str


class SelectConvReq(BaseModel):
    id: str
    workspace: str | None = None


class ReorderConvReq(BaseModel):
    ids: list[str]
    workspace: str | None = None


class ReorderWsReq(BaseModel):
    paths: list[str]


class RestoreHistReq(BaseModel):
    path: str
    id: str


def _rel_path(path: str) -> str:
    rel = (path or "").strip().replace("\\", "/").lstrip("/")
    if not rel or rel in {".", ".."}:
        raise HTTPException(400, "路径不合法")
    if ".." in Path(rel).parts:
        raise HTTPException(400, "路径不允许包含 ..")
    return rel


def _writable(ws: Workspace, rel: str) -> Path:
    if ws._is_memory_file(rel):
        raise HTTPException(403, ".agent/ 下的记忆文件不能从界面直接改")
    try:
        return ws.resolve(rel)
    except PermissionError as exc:
        raise HTTPException(403, str(exc)) from exc


def _store() -> ConversationStore:
    return ConversationStore(_workspace)


def _conv_state(workspace_changed: bool = False) -> dict[str, Any]:
    payload = grouped_conversation_payload(_workspace, _messages)
    payload["workspace_changed"] = workspace_changed
    return payload


def _ws() -> Workspace:
    return Workspace(_workspace)


def _build_tree(path: Path, rel: str, depth: int) -> dict[str, Any] | None:
    if depth > MAX_TREE_DEPTH:
        return None
    name = path.name or str(path)
    if path.is_dir():
        if name in SKIP_DIRS:
            return None
        children: list[dict[str, Any]] = []
        try:
            entries = sorted(
                path.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower())
            )
        except OSError:
            entries = []
        for child in entries:
            node = _build_tree(
                child, f"{rel}/{child.name}".lstrip("/"), depth + 1
            )
            if node is not None:
                children.append(node)
        return {"name": name, "path": rel, "dir": True, "children": children}
    if name in SKIP_FILES:
        return None
    return {"name": name, "path": rel, "dir": False}


@app.get("/api/workspace")
def get_workspace() -> dict[str, Any]:
    opened = TaskQueue(_workspace).open_items()
    return {
        "path": str(_workspace),
        "name": _workspace.name,
        "busy": _busy,
        "open_tasks": len(opened),
    }


@app.post("/api/workspace")
def set_workspace(req: WorkspaceReq) -> dict[str, Any]:
    global _workspace, _messages
    target = project_workspace(req.path)
    if not target.is_dir():
        raise HTTPException(400, "工作区必须是已存在的目录")
    with _lock:
        if _busy:
            raise HTTPException(409, "任务进行中，先等当前任务结束再换工作区")
        ConversationStore(_workspace).save(_messages)
        _workspace = target
        remember_workspace(_workspace)
        _messages = ConversationStore(_workspace).load_active()
    return get_workspace()


@app.get("/api/tree")
def get_tree() -> dict[str, Any]:
    root = _build_tree(_workspace, "", 0)
    if root is None:
        raise HTTPException(500, "无法读取工作区")
    root["name"] = _workspace.name
    return root


@app.get("/api/file")
def get_file(path: str = Query(..., min_length=1)) -> dict[str, str]:
    ws = _ws()
    try:
        target = ws.resolve(path)
    except PermissionError as exc:
        raise HTTPException(403, str(exc)) from exc
    if not target.is_file():
        raise HTTPException(404, "文件不存在")
    if target.stat().st_size > MAX_PREVIEW_BYTES:
        raise HTTPException(413, "文件过大，暂不预览")
    raw = target.read_bytes()
    if b"\x00" in raw[:2048]:
        raise HTTPException(415, "暂不预览二进制文件")
    try:
        content = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise HTTPException(415, "暂不预览二进制文件") from exc
    return {"path": path, "content": content}


@app.get("/api/history")
def list_file_history() -> dict[str, Any]:
    return {"files": FileHistory(_workspace).list_files()}


@app.get("/api/history/versions")
def list_file_versions(path: str = Query(..., min_length=1)) -> dict[str, Any]:
    rel = _rel_path(path)
    return {"path": rel, "items": FileHistory(_workspace).list_versions(rel)}


@app.get("/api/history/content")
def get_history_content(
    path: str = Query(..., min_length=1),
    id: str = Query(..., min_length=1),
) -> dict[str, Any]:
    rel = _rel_path(path)
    try:
        content, missing = FileHistory(_workspace).read_version(rel, id)
    except KeyError:
        raise HTTPException(404, "没有这条历史") from None
    return {"path": rel, "id": id, "content": content, "missing": missing}


@app.post("/api/history/restore")
def restore_file_history(req: RestoreHistReq) -> dict[str, Any]:
    rel = _rel_path(req.path)
    ws = _ws()
    hist = FileHistory(_workspace)
    try:
        content, missing = hist.read_version(rel, req.id)
    except KeyError:
        raise HTTPException(404, "没有这条历史") from None
    target = _writable(ws, rel)
    hist.snapshot_before(rel, "rollback")
    if missing:
        if target.is_file():
            target.unlink()
    else:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
    return {"path": rel, "missing": missing, "files": hist.list_files()}


@app.post("/api/save")
def save_file(req: SaveReq) -> dict[str, str]:
    rel = _rel_path(req.path)
    ws = _ws()
    target = _writable(ws, rel)
    FileHistory(_workspace).snapshot_before(rel, "save")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(req.content, encoding="utf-8")
    return {"path": rel}


@app.post("/api/new-file")
def new_file(req: PathReq) -> dict[str, str]:
    rel = _rel_path(req.path)
    ws = _ws()
    target = _writable(ws, rel)
    if target.exists():
        raise HTTPException(409, "已存在同名文件或文件夹")
    FileHistory(_workspace).snapshot_before(rel, "create")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("", encoding="utf-8")
    return {"path": rel}


@app.post("/api/new-folder")
def new_folder(req: PathReq) -> dict[str, str]:
    rel = _rel_path(req.path)
    ws = _ws()
    target = _writable(ws, rel)
    if target.exists():
        raise HTTPException(409, "已存在同名文件或文件夹")
    target.mkdir(parents=True, exist_ok=True)
    return {"path": rel}


@app.post("/api/shell")
def run_shell(req: ShellReq) -> dict[str, str]:
    command = req.command.strip()
    if not command:
        raise HTTPException(400, "命令不能为空")
    return {"output": _ws().run_shell(command)}


@app.get("/api/open-tasks")
def open_tasks() -> dict[str, Any]:
    items = TaskQueue(_workspace).open_items()
    return {
        "items": [
            {
                "id": row.get("id"),
                "goal": row.get("goal"),
                "status": row.get("status"),
                "files": row.get("files") or [],
            }
            for row in items
        ]
    }


@app.get("/api/conversations")
def list_conversations() -> dict[str, Any]:
    return _conv_state()


@app.post("/api/conversations")
def create_conversation() -> dict[str, Any]:
    global _messages
    with _lock:
        if _busy:
            raise HTTPException(409, "任务进行中")
        _messages = _store().create(_messages)
    return _conv_state()


def _select_conversation(cid: str, workspace: str | None) -> dict[str, Any]:
    global _workspace, _messages
    changed = False
    with _lock:
        if _busy:
            raise HTTPException(409, "任务进行中")
        if workspace:
            target = project_workspace(workspace)
            if not target.is_dir():
                raise HTTPException(400, "工作区不存在")
            if target != _workspace:
                ConversationStore(_workspace).save(_messages)
                _workspace = target
                remember_workspace(_workspace)
                _messages = ConversationStore(_workspace).load_active()
                changed = True
        try:
            _messages = _store().select(cid, _messages)
        except KeyError:
            raise HTTPException(404, "对话不存在") from None
    return _conv_state(changed)


@app.post("/api/conversations/select")
def select_conversation_body(req: SelectConvReq) -> dict[str, Any]:
    return _select_conversation(req.id, req.workspace)


@app.post("/api/conversations/reorder")
def reorder_conversations(req: ReorderConvReq) -> dict[str, Any]:
    target = project_workspace(req.workspace) if req.workspace else _workspace
    if not target.is_dir():
        raise HTTPException(400, "工作区不存在")
    with _lock:
        ConversationStore(target).reorder(req.ids)
    return _conv_state()


@app.post("/api/workspaces/reorder")
def reorder_workspace_list(req: ReorderWsReq) -> dict[str, Any]:
    with _lock:
        reorder_workspaces(req.paths)
    return _conv_state()


@app.post("/api/conversations/{cid}/select")
def select_conversation(cid: str) -> dict[str, Any]:
    return _select_conversation(cid, None)


class ChatBusy(RuntimeError):
    pass


def stop_chat_job() -> dict[str, bool]:
    global _cancel, _client
    _cancel = True
    llm.abort_active_stream()
    client = _client
    _client = None
    if client is not None:
        threading.Thread(target=_close_client, args=(client,), daemon=True).start()
    return {"ok": True}


def _close_client(client: Any) -> None:
    try:
        client.close()
    except Exception:
        pass


def start_chat_job(task: str) -> dict[str, str]:
    global _busy, _messages, _client, _cancel
    task = (task or "").strip()
    if not task:
        raise ValueError("任务不能为空")
    with _lock:
        if _busy:
            raise ChatBusy("上一个任务还在跑")
        _busy = True
        _cancel = False

    job_id = uuid.uuid4().hex
    job: dict[str, Any] = {"events": [], "done": False}
    _jobs[job_id] = job
    extra = [k for k, row in list(_jobs.items()) if row.get("done")]
    for old_id in extra[:-8]:
        _jobs.pop(old_id, None)

    ws = _ws()
    history = _messages

    def push(kind: str, payload: dict[str, Any]) -> None:
        with _lock:
            job["events"].append({"kind": kind, "payload": payload})

    def on_event(kind: str, payload: dict[str, Any]) -> None:
        push(kind, payload)
        if kind != "tool":
            return
        if payload.get("name") not in ("read_file", "write_file", "edit_file"):
            return
        try:
            args = json.loads(payload.get("arguments") or "{}")
        except json.JSONDecodeError:
            return
        path = args.get("path")
        if isinstance(path, str) and path.strip():
            push("open_file", {"path": path.strip(), "reason": payload.get("name")})

    def worker() -> None:
        global _busy, _messages, _client
        try:
            if _client is None:
                _client = llm.make_client()
            agent.run_task(
                _client,
                ws,
                task,
                history,
                on_event=on_event,
                cancel_check=lambda: _cancel,
            )
            save_session(ws.root, history)
            _messages = history
        except Exception as exc:
            push("error", {"text": str(exc)})
        finally:
            with _lock:
                _busy = False
            push("done", {})
            job["done"] = True

    threading.Thread(target=worker, daemon=True, name="agent-task").start()
    return {"job_id": job_id}


def poll_chat_job(job_id: str, after: int = 0) -> dict[str, Any]:
    job = _jobs.get(job_id)
    if job is None:
        raise KeyError("任务不存在")
    start = max(0, int(after or 0))
    with _lock:
        events = job["events"][start:]
        done = bool(job.get("done"))
    return {
        "events": events,
        "next": start + len(events),
        "done": done,
    }


@app.post("/api/chat/stop")
def stop_chat() -> dict[str, bool]:
    return stop_chat_job()


@app.post("/api/chat")
def start_chat(req: ChatReq) -> dict[str, str]:
    try:
        return start_chat_job(req.task)
    except ChatBusy as exc:
        raise HTTPException(409, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.get("/api/chat/poll")
def poll_chat(job_id: str, after: int = 0) -> dict[str, Any]:
    try:
        return poll_chat_job(job_id, after)
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc


@app.get("/")
def index() -> FileResponse:
    return FileResponse(
        WEB_DIR / "index.html",
        headers={"Cache-Control": "no-store, max-age=0"},
    )


app.mount("/static", StaticFiles(directory=str(WEB_DIR)), name="static")


def init_workspace(path: Path) -> None:
    global _workspace, _messages
    _workspace = project_workspace(path.resolve())
    remember_workspace(_workspace)
    _messages = ConversationStore(_workspace).load_active()
