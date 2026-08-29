"""桌面窗口入口：本地 HTTP + 系统窗口。核心循环仍在 agent.py，不引入 agent 框架。"""

from __future__ import annotations

import argparse
import socket
import sys
import threading
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent


def _enable_utf8_stdout() -> None:
    if sys.platform == "win32" and hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
        sys.stderr.reconfigure(encoding="utf-8", line_buffering=True)


def find_free_port(start: int = 8765) -> int:
    for port in range(start, start + 30):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise RuntimeError("找不到可用端口")


def wait_ready(url: str, timeout: float = 10.0) -> None:
    deadline = time.time() + timeout
    last_error = None
    while time.time() < deadline:
        try:
            urllib.request.urlopen(url, timeout=0.4)
            return
        except OSError as exc:
            last_error = exc
            time.sleep(0.12)
    raise RuntimeError(f"本地服务启动超时: {last_error}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="编程智能体桌面窗口")
    parser.add_argument(
        "-w",
        "--workspace",
        default=str(HERE / "demo_multi"),
        help="工作区目录（默认 demo_multi）",
    )
    parser.add_argument("--port", type=int, default=0, help="固定端口；默认自动选择")
    parser.add_argument(
        "--browser",
        action="store_true",
        help="不打开系统窗口，只启动本地服务",
    )
    return parser.parse_args()


class FolderApi:
    def choose_folder(self) -> str | None:
        import webview

        if not webview.windows:
            return None
        result = webview.windows[0].create_file_dialog(webview.FOLDER_DIALOG)
        if not result:
            return None
        if isinstance(result, (list, tuple)):
            return str(result[0]) if result else None
        return str(result)

    def start_chat(self, task: str) -> dict:
        from server import ChatBusy, start_chat_job

        try:
            return start_chat_job(task)
        except ChatBusy as exc:
            return {"error": str(exc)}
        except Exception as exc:
            return {"error": str(exc)}

    def poll_chat(self, job_id: str, after: int = 0) -> dict:
        from server import poll_chat_job

        try:
            return poll_chat_job(job_id, after)
        except KeyError:
            return {"error": "任务不存在", "events": [], "next": 0, "done": True}

    def stop_chat(self) -> dict:
        from server import stop_chat_job

        return stop_chat_job()


def main() -> None:
    _enable_utf8_stdout()
    args = parse_args()

    import uvicorn

    from server import app, init_workspace

    workspace = Path(args.workspace).expanduser().resolve()
    if not workspace.is_dir():
        workspace = HERE
        print(f"指定工作区不存在，改用 {workspace}")
    init_workspace(workspace)

    port = args.port or find_free_port()
    url = f"http://127.0.0.1:{port}"

    def run_server() -> None:
        uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")

    threading.Thread(target=run_server, daemon=True, name="uvicorn").start()
    wait_ready(url)
    print(f"本地服务: {url}", flush=True)
    print(f"工作区: {workspace}", flush=True)

    if args.browser:
        print("在浏览器打开上面的地址。Ctrl+C 退出。")
        try:
            threading.Event().wait()
        except KeyboardInterrupt:
            print("\n退出。")
        return

    try:
        import webview
    except ImportError:
        print("未安装 pywebview，请用浏览器打开:", url)
        print("或 pip install pywebview 后再运行 python app.py")
        try:
            threading.Event().wait()
        except KeyboardInterrupt:
            print("\n退出。")
        return

    api = FolderApi()
    webview.create_window(
        "编程智能体",
        url,
        width=1480,
        height=900,
        min_size=(720, 520),
        js_api=api,
    )
    webview.start()


if __name__ == "__main__":
    main()
