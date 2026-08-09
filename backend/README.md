# dwell backend

这是手机端 `dwell` 的本地服务端。它在 Mac 上运行，网页或 APK 通过局域网访问；Claude Code 使用 Mac 上已经登录的 `claude` CLI，不把 API key 放进 APK 或 GitHub。

## 启动

```bash
cd backend
npm install
DWELL_HOST=0.0.0.0 DWELL_PORT=8787 npm start
```

浏览器打开 `http://127.0.0.1:8787/` 可以直接使用同源前端。手机安装 APK 后，在「设置 → 接入 API」里填 Mac 的局域网地址，例如：

```text
http://192.168.1.10:8787
```

Mac 和手机必须在同一个 Wi‑Fi。macOS 防火墙如果拦截 Node，要允许入站连接。
「保存并连接」会先真实请求 `/api/health`；地址、Wi‑Fi 或令牌不对时不会覆盖原来的可用连接。

## 环境变量

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `DWELL_HOST` | `0.0.0.0` | 监听地址 |
| `DWELL_PORT` | `8787` | 监听端口 |
| `DWELL_WORKSPACE` | 仓库根目录 | Claude Code 和仓库页工作的目录 |
| `DWELL_DATA_DIR` | `backend/data` | 本地 JSON/JSONL、日报和上传文件 |
| `DWELL_CLAUDE_BIN` | `claude` | Claude Code CLI 可执行文件路径 |
| `DWELL_CLAUDE_TIMEOUT_MS` | `900000` | 单次主助手请求最长等待时间（毫秒） |
| `DWELL_AUTH_TOKEN` | 空 | 手机访问令牌；设置后在 APK 连接页填写 |
| `DWELL_HEALTH_TOKEN` | 自动生成 | 快捷指令上传健康数据的独立令牌 |
| `DWELL_CLAUDE_BARE` | `1` | 跳过 hooks/MCP 启动等待，适合手机后端；设为 `0` 才加载本机 hooks/MCP |
| `DWELL_GONG_MODEL` | `haiku` | 「另一位」独立会话使用的 Claude Code 模型 |
| `DWELL_PERMISSION_MODE` | `acceptEdits` | Claude Code 权限模式 |
| `DWELL_VAPID_EMAIL` | `mailto:dwell@localhost` | Web Push 的 VAPID 联系地址 |

数据目录已被 Git 忽略，令牌不会提交到仓库。生产或跨网络访问时应使用 HTTPS/VPN，并设置 `DWELL_AUTH_TOKEN`；局域网调试才使用 APK 支持的 HTTP。

## 已接入的真实能力

- Claude Code CLI `stream-json` 流式回复、思考、工具调用、停止、继续会话和模型/effort 设置
- 会话列表、重命名、收纳、新窗口、消息历史和增量事件轮询；每个窗口有独立消息和 Claude 会话
- 图片会落到受限上传目录再交给本机 Claude Code；大文件分块上传完成后才加入当前消息
- 待办（日常两栏）、日历事件/重复/重要日子/心情、你的日记、悄悄话
- 共读书架（把 Markdown 放入 `backend/data/books/`）、阅读进度和段落批注楼
- 仓库只读时间线、diff、文件树和文件内容，路径与输出长度均有限制
- 音乐卡片从网易云歌曲 ID 查询曲名、歌手、专辑、封面和时长
- 健康数据 `POST /api/health` 鉴权接收、快照展示；健康页可复制上传网址和独立令牌
- 浏览器 Web Push，以及供 Android 原生后台任务读取的新消息接口
- 本机用量记录、当前上下文估算、工作区项目、工具权限和项目 MCP 连接器状态
- OpenAI、OpenRouter、Anthropic 兼容的备用模型通道，含真实最小请求测试和图片输入
- 夜间唤醒开关、每天最多两次、间隔和安静时间限制；可从设置手动重新唤醒
- 日报读取 `backend/data/news/日报-YYYY-MM-DD.md`；`npm run news` 抓 RSS 生成一份，设置 `DWELL_NEWS_USE_CLAUDE=1` 可让本机 Claude Code 改写

备用模型通道只负责模型回复，不会获得 Claude Code CLI 的本机工具、hook 或 MCP。要让手机真正操作 Mac 上的项目，应继续使用默认 Claude Code 通道。

## 自检

语法检查：

```bash
npm run check
```

完整冒烟测试需要先用独立测试数据目录启动服务，再在另一个终端执行；它会测试窗口隔离、待办、日历、上传、通知接口，以及模拟的 OpenAI/Anthropic 通道：

```bash
DWELL_DATA_DIR=/tmp/dwell-smoke DWELL_CLAUDE_BIN=/usr/bin/false DWELL_PORT=18788 npm start
DWELL_SMOKE_URL=http://127.0.0.1:18788 npm run smoke
```

## 健康快捷指令

在健康页点右上角钥匙，把显示的 URL 和 Token 填入手机快捷指令：用 JSON `POST` 到该 URL，并发送 `Authorization: Bearer <Token>`。可以传扁平字段，例如：

```json
{
  "device": "Galaxy Watch",
  "sleep_hours": {"value": 6.2, "unit": "小时"},
  "steps": {"value": 8321, "unit": "步"}
}
```

健康数据只是同步快照，不是医疗监护；服务端不会因为某个指标自动报警。
