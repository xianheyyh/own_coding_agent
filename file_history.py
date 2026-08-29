"""工作区文件改动历史：改之前存一份，可回看、可回退。不使用 git / agent 框架。"""

from __future__ import annotations

import json
from pathlib import Path

from memory import _agent_dir, _now

MAX_VERSIONS = 30
MAX_BYTES = 800_000
HISTORY_DIR = "file-history"


def _norm(rel: str) -> str:
    return str(rel or "").replace("\\", "/").strip().lstrip("/")


class FileHistory:
    def __init__(self, workspace_root: str | Path) -> None:
        self.root = Path(workspace_root).resolve()
        self.dir = _agent_dir(self.root) / HISTORY_DIR
        self.index_path = self.dir / "index.json"
        self.blobs = self.dir / "blobs"

    def _empty(self) -> dict:
        return {"next_id": 1, "files": {}}

    def _load(self) -> dict:
        if not self.index_path.is_file():
            return self._empty()
        try:
            data = json.loads(self.index_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return self._empty()
        if not isinstance(data, dict):
            return self._empty()
        data.setdefault("next_id", 1)
        data.setdefault("files", {})
        if not isinstance(data["files"], dict):
            data["files"] = {}
        return data

    def _save(self, data: dict) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        self.index_path.write_text(
            json.dumps(data, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    def _blob(self, vid: str) -> Path:
        return self.blobs / f"{vid}.txt"

    def _new_id(self, data: dict) -> str:
        vid = f"h{int(data.get('next_id') or 1):03d}"
        data["next_id"] = int(data.get("next_id") or 1) + 1
        return vid

    def _target(self, rel: str) -> Path | None:
        key = _norm(rel)
        if not key or key.startswith(".agent/") or key == ".agent":
            return None
        target = (self.root / key).resolve()
        try:
            target.relative_to(self.root)
        except ValueError:
            return None
        return target

    def _trim(self, items: list[dict]) -> None:
        while len(items) > MAX_VERSIONS:
            old = items.pop(0)
            vid = old.get("id")
            if vid:
                path = self._blob(str(vid))
                if path.is_file():
                    path.unlink()

    def snapshot_before(self, rel: str, action: str) -> None:
        """在覆盖/修改磁盘文件之前，把当前内容存成一条历史。"""
        key = _norm(rel)
        target = self._target(key)
        if target is None:
            return
        missing = not target.is_file()
        content = ""
        if not missing:
            try:
                if target.stat().st_size > MAX_BYTES:
                    return
                raw = target.read_bytes()
            except OSError:
                return
            if b"\x00" in raw[:2048]:
                return
            try:
                content = raw.decode("utf-8")
            except UnicodeDecodeError:
                return
        data = self._load()
        items = data["files"].setdefault(key, [])
        if not isinstance(items, list):
            items = []
            data["files"][key] = items
        vid = self._new_id(data)
        self.blobs.mkdir(parents=True, exist_ok=True)
        if not missing:
            self._blob(vid).write_text(content, encoding="utf-8")
        items.append(
            {
                "id": vid,
                "at": _now(),
                "action": action or "edit_file",
                "bytes": len(content.encode("utf-8")) if content else 0,
                "missing": missing,
            }
        )
        self._trim(items)
        self._save(data)

    def list_files(self) -> list[dict]:
        data = self._load()
        rows = []
        for path, items in (data.get("files") or {}).items():
            if not isinstance(items, list) or not items:
                continue
            last = items[-1] if isinstance(items[-1], dict) else {}
            rows.append(
                {
                    "path": path,
                    "count": len(items),
                    "last_action": last.get("action") or "",
                    "last_at": last.get("at") or "",
                }
            )
        rows.sort(key=lambda row: row.get("last_at") or "", reverse=True)
        return rows

    def list_versions(self, rel: str) -> list[dict]:
        key = _norm(rel)
        data = self._load()
        items = data.get("files", {}).get(key) or []
        if not isinstance(items, list):
            return []
        out = [row for row in items if isinstance(row, dict)]
        out.reverse()
        return out

    def read_version(self, rel: str, vid: str) -> tuple[str, bool]:
        key = _norm(rel)
        data = self._load()
        items = data.get("files", {}).get(key) or []
        row = next((x for x in items if isinstance(x, dict) and x.get("id") == vid), None)
        if row is None:
            raise KeyError(vid)
        if row.get("missing"):
            return "", True
        path = self._blob(vid)
        if not path.is_file():
            raise KeyError(vid)
        return path.read_text(encoding="utf-8"), False
