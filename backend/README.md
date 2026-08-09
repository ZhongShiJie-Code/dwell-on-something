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

## 环境变量

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `DWELL_HOST` | `0.0.0.0` | 监听地址 |
| `DWELL_PORT` | `8787` | 监听端口 |
| `DWELL_WORKSPACE` | 仓库根目录 | Claude Code 和仓库页工作的目录 |
| `DWELL_DATA_DIR` | `backend/data` | 本地 JSON/JSONL、日报和上传文件 |
| `DWELL_AUTH_TOKEN` | 空 | 手机访问令牌；设置后在 APK 连接页填写 |
| `DWELL_HEALTH_TOKEN` | 自动生成 | 快捷指令上传健康数据的独立令牌 |
| `DWELL_CLAUDE_BARE` | `1` | 跳过 hooks/MCP 启动等待，适合手机后端；设为 `0` 才加载本机 hooks/MCP |
| `DWELL_PERMISSION_MODE` | `acceptEdits` | Claude Code 权限模式 |
| `DWELL_VAPID_EMAIL` | `mailto:dwell@localhost` | Web Push 的 VAPID 联系地址 |

数据目录已被 Git 忽略，令牌不会提交到仓库。生产或跨网络访问时应使用 HTTPS/VPN，并设置 `DWELL_AUTH_TOKEN`；局域网调试才使用 APK 支持的 HTTP。

## 已接入的真实能力

- Claude Code CLI `stream-json` 流式回复、思考、工具调用、停止、继续会话和模型/effort 设置
- 会话列表、重命名、收纳、新窗口、消息历史和增量事件轮询
- 待办（日常两栏）、日历事件/重复/重要日子/心情、你的日记、悄悄话
- 共读书架（把 Markdown 放入 `backend/data/books/`）、阅读进度和段落批注楼
- 仓库只读时间线、diff、文件树和文件内容，路径与输出长度均有限制
- 音乐卡片从网易云歌曲 ID 查询曲名、歌手、专辑、封面和时长
- 健康数据 `POST /api/health` 鉴权接收、快照展示；健康页可复制上传网址和独立令牌
- Web Push 公钥和订阅保存；安装依赖后可发送订阅通知，并自动清理失效订阅
- 夜间唤醒开关、每天最多两次、间隔和安静时间限制；可从设置手动重新唤醒
- 日报读取 `backend/data/news/日报-YYYY-MM-DD.md`；`npm run news` 抓 RSS 生成一份，设置 `DWELL_NEWS_USE_CLAUDE=1` 可让本机 Claude Code 改写

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
