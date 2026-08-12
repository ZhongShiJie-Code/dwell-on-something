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

### 不在局域网时：Cloudflare Tunnel

外网使用时，把 Mac 后端只绑定到本机回环地址，再用 Cloudflare Tunnel 暴露一个专用主机名。配置模板在
[`deploy/cloudflared/config.yml.example`](../deploy/cloudflared/config.yml.example)。Cloudflare Zero Trust 中还要给这个主机名配置 Access 应用和登录策略；Tunnel 地址本身不是身份验证。

手机在「设置 → 接入 API」同时填写局域网地址和 Cloudflare 地址。应用会并行探测两者，局域网健康时优先局域网，否则使用 Cloudflare；两个地址都不可用时继续显示手机上次成功保存的离线快照。

`DWELL_AUTH_TOKEN` 是 Dwell 自己的第二道门，不能把它写进仓库、APK 或 Tunnel 配置：

```bash
cd backend
DWELL_HOST=127.0.0.1 DWELL_PORT=8787 DWELL_AUTH_TOKEN='只在 Mac 环境变量中保存' npm start
```

仓库内置受控任务桥 `backend/desktop-task-bridge.mjs`。服务端用单个 JSON 参数调用它，格式为
`{"action":"run|pause|resume","task_id":"..."}`。暂停/恢复会先备份再更新 Claude Desktop 的任务定义；立即运行优先调用任务文件明确声明的白名单主机工具或脚本，并把运行中/成功/失败状态写入 Mac 本地状态目录。不要把任务令牌或凭据写进任务说明。

## 环境变量

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `DWELL_HOST` | `0.0.0.0` | 监听地址 |
| `DWELL_PORT` | `8787` | 监听端口 |
| `DWELL_WORKSPACE` | 仓库根目录 | Claude Code 和仓库页工作的目录 |
| `DWELL_DATA_DIR` | `backend/data` | 本地 JSON/JSONL、日报和上传文件 |
| `DWELL_CLAUDE_BIN` | `claude` | Claude Code CLI 可执行文件路径 |
| `DWELL_CLAUDE_MODEL` | 空 | 可选的 Claude Code 实际模型覆盖；留空使用 Mac CLI 默认模型 |
| `DWELL_CLAUDE_TIMEOUT_MS` | `900000` | 单次主助手请求最长等待时间（毫秒） |
| `DWELL_AUTH_TOKEN` | 空 | 手机访问令牌；设置后在 APK 连接页填写 |
| `DWELL_CLAUDE_PROFILE` | `~/Library/Application Support/Claude-3p` | Claude Desktop 任务读取根目录 |
| `DWELL_CLAUDE_TASKS_FILE` | 自动发现 | 指定 Claude Desktop 的 `scheduled-tasks.json` |
| `DWELL_CLAUDE_HISTORY_ROOT` | `~/.claude` | Mac Claude Code 会话历史目录 |
| `DWELL_DESKTOP_TASKS_BRIDGE` | 空 | 受控桌面任务桥路径；建议指向仓库内的 `backend/desktop-task-bridge.mjs` |
| `DWELL_HEALTH_TOKEN` | 自动生成 | 快捷指令上传健康数据的独立令牌 |
| `DWELL_CLAUDE_SAFE_MODE` | `1` | 禁用易卡住的自定义 hooks/MCP，但保留 Claude Code 内置文件与代码工具 |
| `DWELL_CLAUDE_BARE` | `0` | 极简 API-key 模式；通常不要开启，开启后不会读取 OAuth/钥匙串 |
| `DWELL_GONG_MODEL` | `haiku` | 「另一位」独立会话使用的 Claude Code 模型 |
| `DWELL_PERMISSION_MODE` | `acceptEdits` | Claude Code 权限模式 |
| `DWELL_VAPID_EMAIL` | `mailto:dwell@localhost` | Web Push 的 VAPID 联系地址 |

数据目录已被 Git 忽略，令牌不会提交到仓库。生产或跨网络访问时应使用 HTTPS/VPN，并设置 `DWELL_AUTH_TOKEN`；局域网调试才使用 APK 支持的 HTTP。

## 已接入的真实能力

- Claude Code CLI `stream-json` 流式回复、思考、工具调用、停止、继续会话和模型/effort 设置；模型页从后端读取当前真实可用的 CLI 别名，不再展示写死的未来型号
- 会话列表、重命名、收纳、新窗口、消息历史和增量事件轮询；同时读取 Mac `~/.claude` 的真实 Claude Code 会话，打开后可继续原会话
- 图片会落到受限上传目录再交给本机 Claude Code；大文件分块上传完成后才加入当前消息
- 待办（日常两栏）、日历事件/重复/重要日子/心情、你的日记、悄悄话
- 共读书架（把 Markdown 放入 `backend/data/books/`）、阅读进度和段落批注楼
- 仓库只读时间线、diff、文件树和文件内容，路径与输出长度均有限制
- 音乐卡片从网易云歌曲 ID 查询曲名、歌手、专辑、封面和时长
- 健康数据 `POST /api/health` 鉴权接收、快照展示；健康页可复制上传网址和独立令牌
- 浏览器 Web Push，以及供 Android 原生后台任务读取的新消息接口；Android 设置页可查看最近轮询时间、结果和具体错误
- 本机用量记录、当前上下文估算、工作区项目、工具权限和项目 MCP 连接器状态
- Claude Desktop 定时任务：名称、说明、周期、启用状态、最近运行时间和结果；配置内置桥后可暂停、恢复和立即运行，并在页面显示实时状态
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
