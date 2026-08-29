"""命令行入口：和用户对话，把任务交给自研循环。"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import agent
import llm
from memory import LongTermMemory, load_session, save_session
from tools import Workspace


def _enable_utf8_stdout() -> None:
    if sys.platform == "win32" and hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="简单的本地编程智能体（CLI）")
    parser.add_argument(
        "task",
        nargs="?",
        help="直接传入任务；省略则进入多轮输入",
    )
    parser.add_argument(
        "-w",
        "--workspace",
        default=".",
        help="工作区目录（默认当前目录）",
    )
    parser.add_argument(
        "--resume",
        action="store_true",
        help="从当前活动对话恢复（.agent/conversations 与 session.json）",
    )
    return parser.parse_args()


def main() -> None:
    _enable_utf8_stdout()
    args = parse_args()
    workspace = Workspace(Path(args.workspace))
    client = llm.make_client()
    long_mem = LongTermMemory(workspace.root)

    messages: list[dict] = []
    if args.resume:
        loaded = load_session(workspace.root)
        if loaded:
            messages = loaded
            print("已恢复当前对话记忆")
        else:
            print("没有可恢复的会话，开始新会话")

    print(f"工作区: {workspace.root}")
    print(f"项目记忆: {long_mem.path}")
    print("输入任务后回车。空行退出。\n")

    def handle(task: str) -> None:
        agent.run_task(client, workspace, task, messages)
        save_session(workspace.root, messages)

    if args.task:
        handle(args.task)
        return

    while True:
        try:
            task = input("> ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\n退出。")
            return
        if not task:
            print("退出。")
            return
        handle(task)
        print()


if __name__ == "__main__":
    main()
