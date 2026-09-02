"""错误重试、超时配置、shell 沙箱、失败落盘。"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

import agent
import config
import llm
from memory import ProjectMemory, TaskQueue
from tools import Workspace, dispatch


def test_http_timeout_read_matches_llm_timeout():
    timeout = llm.http_timeout()
    assert timeout.read == config.LLM_TIMEOUT
    assert timeout.connect <= config.LLM_TIMEOUT


def test_retryable_errors():
    assert llm.is_retryable(TimeoutError("x"))
    assert llm.is_retryable(ConnectionError("x"))
    assert llm.is_retryable(RuntimeError("模型请求超时（90秒）。请检查网络后重试。"))
    assert llm.is_retryable(RuntimeError("连不上模型服务，请检查网络和 OPENAI_BASE_URL。"))
    assert not llm.is_retryable(RuntimeError("已停止"))
    assert not llm.is_retryable(ValueError("bad"))
    assert not llm.is_retryable(PermissionError("x"))
    assert not llm.is_retryable(FileNotFoundError("x"))

    class APIStatusError(Exception):
        pass

    assert not llm.is_retryable(APIStatusError("400 bad request"))
    err429 = APIStatusError("Error code: 429")
    assert llm.is_retryable(err429)
    err500 = APIStatusError("Error code: 500")
    err500.status_code = 500
    assert llm.is_retryable(err500)
    err400 = APIStatusError("bad")
    err400.status_code = 400
    assert not llm.is_retryable(err400)


def test_call_with_retries_succeeds_after_timeouts():
    n = {"i": 0}

    def flaky() -> str:
        n["i"] += 1
        if n["i"] < 3:
            raise TimeoutError("slow")
        return "ok"

    slept = []
    result = llm.call_with_retries(
        flaky,
        retries=2,
        sleep=lambda s: slept.append(s),
    )
    assert result == "ok"
    assert n["i"] == 3
    assert slept == [0.6, 1.2]


def test_call_with_retries_stops_on_cancel():
    def boom() -> str:
        raise TimeoutError("slow")

    with pytest.raises(RuntimeError, match="已停止"):
        llm.call_with_retries(
            boom,
            retries=5,
            sleep=lambda _s: None,
            cancel_check=lambda: True,
        )


def test_run_task_llm_error_marks_queue(monkeypatch, tmp_path: Path):
    (tmp_path / "x.py").write_text("print(1)\n", encoding="utf-8")
    ws = Workspace(tmp_path)

    def boom(*_a, **_k):
        raise RuntimeError("模型请求超时（90秒）。请检查网络后重试。")

    monkeypatch.setattr(agent.llm, "chat", boom)
    text = agent.run_task(object(), ws, "给 x.py 加注释", [])
    assert "超时" in text
    items = TaskQueue(tmp_path).open_items()
    assert len(items) == 1
    assert items[0]["outcome"] == "error"
    assert items[0]["status"] == "interrupted"
    assert items[0]["finished"] is False


def test_run_shell_blocks_parent_redirect(tmp_path: Path):
    ws = Workspace(tmp_path)
    probe = tmp_path.parent / "escape_probe_hardening.txt"
    if probe.is_file():
        probe.unlink()
    out = dispatch(
        ws,
        "run_shell",
        json.dumps({"command": "echo ok > ..\\escape_probe_hardening.txt"}),
    )
    assert "不允许逃出" in out
    assert not probe.is_file()


def test_run_shell_allows_redirect_inside(tmp_path: Path):
    ws = Workspace(tmp_path)
    out = dispatch(ws, "run_shell", json.dumps({"command": "echo hi > note.txt"}))
    assert "exit_code=0" in out
    assert (tmp_path / "note.txt").read_text(encoding="utf-8", errors="replace").strip() == "hi"


def test_remember_conflict_on_shared_identifier(tmp_path: Path):
    mem = ProjectMemory(tmp_path)
    first = mem.remember("使用 pytest 跑测试", "command")
    assert "已写入" in first
    second = mem.remember("pytest 必须在 demo 目录运行", "command")
    assert "update_memory" in second


def test_remember_unrelated_python_facts_ok(tmp_path: Path):
    mem = ProjectMemory(tmp_path)
    first = mem.remember("用 python 跑脚本", "command")
    assert "已写入" in first
    second = mem.remember("购物车用 python 实现满减", "decision")
    assert "已写入" in second


def test_run_shell_blocks_copy_parent(tmp_path: Path):
    ws = Workspace(tmp_path)
    (tmp_path / "a.txt").write_text("hi", encoding="utf-8")
    probe = tmp_path.parent / "judge_copy_hardening.txt"
    if probe.is_file():
        probe.unlink()
    out = dispatch(
        ws,
        "run_shell",
        json.dumps({"command": "copy a.txt ..\\judge_copy_hardening.txt"}),
    )
    assert "不允许逃出" in out
    assert not probe.is_file()


def test_run_shell_blocks_python_open_parent(tmp_path: Path):
    ws = Workspace(tmp_path)
    probe = tmp_path.parent / "judge_py_hardening.txt"
    if probe.is_file():
        probe.unlink()
    cmd = "python -c \"open(r'..\\\\judge_py_hardening.txt','w').write('x')\""
    out = dispatch(ws, "run_shell", json.dumps({"command": cmd}))
    assert "不允许逃出" in out
    assert not probe.is_file()


def test_run_shell_blocks_env_temp_redirect(tmp_path: Path):
    import os

    temp = os.environ.get("TEMP") or os.environ.get("TMP")
    if not temp:
        pytest.skip("未设置 TEMP")
    ws = Workspace(tmp_path)
    probe = Path(temp) / "ca_env_redirect_probe.txt"
    if probe.is_file():
        probe.unlink()
    out = dispatch(
        ws,
        "run_shell",
        json.dumps({"command": 'echo ok > "%TEMP%\\ca_env_redirect_probe.txt"'}),
    )
    assert "不允许逃出" in out
    assert not probe.is_file()


def test_run_task_stop_marks_interrupted(monkeypatch, tmp_path: Path):
    (tmp_path / "x.py").write_text("print(1)\n", encoding="utf-8")
    ws = Workspace(tmp_path)

    def boom(*_a, **_k):
        raise RuntimeError("已停止")

    monkeypatch.setattr(agent.llm, "chat", boom)
    text = agent.run_task(object(), ws, "给 x.py 加注释", [])
    assert "已暂停" in text
    queue = TaskQueue(tmp_path)
    assert queue.open_items() == []
    prompt = queue.format_for_prompt()
    assert "进行中：无" in prompt
    assert "interrupted" in prompt


def test_delete_conversation_keeps_one(tmp_path: Path):
    from memory import ConversationStore

    store = ConversationStore(tmp_path)
    store.save([{"role": "user", "content": "第一轮"}])
    store.create([{"role": "user", "content": "第一轮"}])
    store.save([{"role": "user", "content": "第二轮"}])
    snap = store.list_payload()
    assert len(snap["items"]) == 2
    first = snap["items"][0]["id"]
    loaded = store.delete(first, [{"role": "user", "content": "第二轮"}])
    left = store.list_payload()
    assert len(left["items"]) == 1
    assert first not in {row["id"] for row in left["items"]}
    assert isinstance(loaded, list)


def test_forget_workspace_drops_from_sidebar(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    import memory

    monkeypatch.setattr(memory, "STATE_DIR", tmp_path / "state")
    monkeypatch.setattr(memory, "WORKSPACES_JSON", tmp_path / "state" / "workspaces.json")
    a = tmp_path / "proj_a"
    b = tmp_path / "proj_b"
    a.mkdir()
    b.mkdir()
    memory.remember_workspace(a)
    memory.remember_workspace(b)
    memory.forget_workspace(a)
    paths = {str(p) for p in memory.list_known_workspaces(b)}
    assert str(a) not in paths
    assert str(b) in paths

