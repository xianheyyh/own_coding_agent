# 编程智能体

本地编程智能体：把任务交给它，它会调用大模型，在指定工作区里自己找文件、改代码、跑命令，直到做完或达到步数上限。

没有使用 LangChain、LlamaIndex、OpenAI Agents SDK 等 agent 框架。对话历史、工具定义与本地执行、循环终止、错误处理都在本仓库里实现。模型侧只走 OpenAI 兼容的 Chat Completions 和原生 tool calling，不依赖云端代执行代码。

核心循环在 `agent.py`：把系统提示和对话发给模型 → 若返回 tool call，由 `tools.py` 在工作区沙箱里执行并把结果写回 → 再请求模型。模型不再调工具，或达到步数上限，即停止。读写路径不能逃出工作区；这不是容器隔离，任意 Python 代码仍应视为不可信。

界面是左对话、中聊天；右侧 Dock 默认收起，需要时再打开改动、文件、终端。`demo_multi` 是附带的结账演示：先让测试失败，再让智能体跨文件修改，直到 `pytest` 通过。

## 运行

```text
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env
```

在 `.env` 填写 `OPENAI_API_KEY`。兼容网关可同时设置，例如 DeepSeek：

```text
OPENAI_BASE_URL=https://api.deepseek.com
OPENAI_MODEL=deepseek-v4-flash
```

```text
python demo_multi/prepare_demo.py
python app.py
```

默认工作区是 `demo_multi`。命令行：`python main.py -w demo_multi "任务说明"`。
