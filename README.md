# 简单编程智能体

不用任何 agent 框架。对话历史、工具执行、循环终止都在本项目里自己写。
只使用官方 OpenAI 兼容客户端的 Chat Completions + 原生 tool calling。

## 准备

```text
cd coding-agent
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env
```

编辑 `.env`，填入 `OPENAI_API_KEY`。若用 DeepSeek 等兼容网关，同时设置：

```text
OPENAI_BASE_URL=https://api.deepseek.com
OPENAI_MODEL=deepseek-v4-flash
```

Anaconda 用户：`conda activate agent` 后同样改 `.env`。

## 运行

桌面窗口（Codex 式：左对话历史、中聊天；右侧 Dock 按需打开。默认工作区 `demo_multi`）：

```text
python app.py
```

- 左侧是对话和工作区。右侧 Dock 默认收起，顶栏打开改动 / 文件 / 终端 / 浏览器。文件树不显示 `.agent`。输入框旁可切换模型。
- 左侧：按工作区列出对话；点「新建」开新会话。项目约定和任务队列按工作区共用。
- 中间：聊天。底部输入任务，Enter 发送，运行中按钮变为停止。点改动里的文件后，中间预览用 `+/-` 显示差异（只读）；从文件树打开才可编辑、Ctrl+S 保存。
- 右侧「改动」列出改过的文件和历史版本，可回退。历史版本不能保存。
- 未做完的任务在当前对话里说「继续」。
- 只起本地服务、用浏览器打开：`python app.py --browser`

命令行仍然可用：

```text
python main.py -w demo_multi "补全结账并运行 pytest 直到测试通过"
python main.py -w demo_multi
python main.py -w demo_multi --resume
```

录视频或演示前先运行 `python demo_multi/prepare_demo.py`，把购物车实现还原成测试失败的状态。

## 记忆

三层都在工作区 `.agent/`，人可以打开看。

- **对话**：`.agent/conversations.json` + `conversations/c00x.json`，每个对话一份消息历史。`session.json` 同步当前活动对话，供 `--resume` 使用。
- **项目约定**：`project.json` 为数据源，`MEMORY.md` 是给人看的渲染。所有对话共用。`update_memory` 把旧条标成废弃再追加新条；`recall` 默认只看当前有效。
- **情节**：每个用户任务结束由循环写入 `episodes.jsonl`。**新任务入口按关键词自动召回**命中项（不是全量加载）。
- **任务队列**：`.agent/tasks.json`，追加不覆盖。未完成的工作一直留在「进行中」；问进度只追加一条询问记录，不会把大任务擦掉。说「继续」会接上未完成任务并恢复它的会话。`WORKING.md` 是队列的可读视图。
- 任务结束后打印一条记忆维护提示（情节条数、废弃条数），不额外调模型。

## 文件各自做什么

- `llm.py`：发请求、解析 tool_calls
- `tools.py`：本地文件/命令 + 记忆工具（含 glob/grep、分段阅读、todo、apply_patch）
- `memory.py`：项目约定、情节、任务队列、多对话落盘
- `agent.py`：循环、入口召回、结束时写情节和队列
- `main.py`：命令行入口
- `server.py`：本地 HTTP（文件树 / 读写文件 / 聊天任务轮询）
- `web/`：静态页面（左对话、中聊天、右改动）
- `app.py`：桌面壳（uvicorn + pywebview）
