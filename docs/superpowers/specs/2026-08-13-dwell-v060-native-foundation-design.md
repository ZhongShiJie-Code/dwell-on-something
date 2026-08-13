# Dwell v0.6.0：安全基础、SQLite/SSE 与 Compose 原生核心合并设计

日期：2026-08-13
状态：用户已确认把原 v0.5 基础升级与 v0.6 原生升级合并为一个版本；等待书面规格复核

## 1. 决策摘要

Dwell 下一次公开发布直接使用 `v0.6.0`，不单独发布 `v0.5.0`。开发过程仍拆成三个可独立验收、可回滚的内部里程碑：

1. **基础层**：设备配对、凭据保护、SQLite、SSE、连接管理、正式签名与自动检查。
2. **原生核心**：用 Jetpack Compose 实现聊天、会话列表、侧栏、定时任务、设置、模型选择、语音和通知入口。
3. **集成发布**：把日记、共读、仓库、日报、健康等低频页面作为受控 Legacy WebView 接入，完成迁移、真机验收和 GitHub Release。

这不是从空项目重新开发。Node.js 后端、Claude Code CLI 适配器、Claude Desktop 定时任务桥、局域网与 Cloudflare 双端点、现有业务数据和已经验证的回复动作全部保留。原生化只替换影响流畅度、通知、语音、导航和崩溃率的核心交互层。

发布目标仍然只有 Android APK，不增加 iOS、网页公开产品、账号体系、订阅计费或 Google Play 上架范围。

## 2. 为什么现在合并升级

v0.4.7 已经补齐主要功能，但继续在当前结构上叠加会扩大回归风险：

- `web/index.html` 同时承担样式、路由、演示数据、离线仓库、连接管理、聊天流、所有生活页面和手势状态。
- `backend/server.mjs` 同时负责 HTTP 路由、Claude 进程、数据持久化、通知、上传、仓库、日历和生活数据。
- `MainActivity.java` 同时负责 WebView、文件选择、语音识别、TTS、通知、设置存储、系统返回和崩溃恢复。
- 长轮询、JSON 全量重写、`file://` universal access、localStorage 明文令牌和 debug 签名都已不适合作为长期基础。

单独先发布 v0.5 再发布 v0.6 会重复修改网络、缓存、通知和数据模型。合并版本让原生客户端直接建立在新的 v2 API、SQLite 和 SSE 上，减少一次兼容层返工。

## 3. 不采用的方案

### 3.1 继续只修 WebView

优点是改动小；缺点是聊天长列表、底部卡片、侧栏手势、语音生命周期和后台通知继续受 DOM/WebView 边界限制。该方案不能达到三星 S25+ 上接近原生 Claude 手机版的稳定手感，因此不采用。

### 3.2 全部页面一次性改成 Compose

原生一致性最好，但会同时重写日记、共读、仓库、健康、日报、日历等大量低频页面，难以控制视觉回归，也会重复以前“先打通管道、后补体验”的失败路径，因此不采用。

### 3.3 Flutter、React Native 或 Capacitor

项目只需要 Android。引入跨平台框架会增加桥接层、包体和调试面，不会比 Compose 更好地解决 Android 通知、语音、返回手势和 120Hz 动画问题，因此不采用。

## 4. 总体架构

```text
Samsung S25+
  Compose App
    Chat / Chats / Tasks / Settings / Model / Voice
    Room cache + DataStore + Android Keystore
    SSE client + REST commands + WorkManager
    LegacyFeatureScreen
      WebViewAssetLoader -> packaged web assets
                    |
              HTTPS / LAN HTTP
                    |
Mac Dwell backend
  HTTP v1 compatibility routes
  REST v2 + SSE event stream
  device pairing and revocation
  SQLite WAL database
  Claude Code adapter
  Claude Desktop task adapter
  optional FCM sender
                    |
       Claude Code CLI / Claude Desktop task files
```

核心原则：

- Compose 是主应用，不再由 WebView 决定应用导航。
- 后端是唯一业务事实源；Room 是手机缓存和离线草稿，不生成另一套冲突历史。
- `api/v1` 兼容现有 Web 页面，`api/v2` 服务原生客户端。
- WebView 只能显示打包页面，不保存长期设备凭据，不具备 universal file access。
- 所有迁移先备份、后导入、再核对数量，旧数据在 v0.6.0 发布时不删除。

## 5. 里程碑 A：安全与后端基础

### 5.1 SQLite 数据层

后端新增 `backend/db/`，把以下结构化数据迁入 SQLite：

- chats
- messages
- message feedback
- todos
- calendar events and day records
- diary entries
- whisper entries
- nook progress and annotations
- notification events and cursors
- task run snapshots
- paired devices and revocations
- idempotent mutation receipts

书籍 Markdown、日报 Markdown、上传文件和仓库文件继续保留在文件系统，不塞入数据库。

数据库启用 WAL、foreign keys、busy timeout 和显式 schema version。Node 22 本机的 `node:sqlite` 仍会输出 experimental warning，因此实现使用兼容当前 Node 22 的稳定 SQLite 驱动并锁定版本，不依赖实验 API。

首次启动迁移顺序：

1. 将 `backend/data` 复制到 `backend/data/backups/pre-v060-<timestamp>`。
2. 创建临时数据库并在单个事务内导入 JSON/JSONL。
3. 核对会话数、消息数、待办数、日历数、日记数和最大消息序号。
4. 原子替换为正式数据库。
5. 写入迁移报告；任一数量不一致即保持 v0.4.7 数据并拒绝启动写入模式。

v0.6.0 不删除旧 JSON/JSONL；回滚到 v0.4.7 时仍可使用备份。新数据只写 SQLite，避免双写造成分叉。

### 5.2 后端模块边界

保留 Node.js，不改成 FastAPI。`server.mjs` 拆成以下单一职责模块：

- `http/app.mjs`：服务器、通用错误和静态资源
- `http/auth.mjs`：设备鉴权、旧 token 兼容、CORS
- `routes/v1.mjs`：旧 Web 页面兼容
- `routes/v2/*.mjs`：聊天、任务、模型、设置和设备 API
- `services/claude.mjs`：Claude Code 进程与流式事件
- `services/tasks.mjs`：Claude Desktop 任务读取和受控动作
- `services/notifications.mjs`：通知事件和 FCM 发送
- `db/*.mjs`：schema、迁移和 repository

路由输入使用统一 schema 验证；错误返回稳定的 `code`、用户可读信息和可追踪 request ID。日志不记录完整 token、Cookie、消息正文或上传内容。

### 5.3 SSE 事件流

新增 `GET /api/v2/events`，使用 Server-Sent Events 替换原生客户端的 `api/poll` 长轮询。每个事件具有单调递增 ID、chat ID、type、timestamp 和 payload。客户端使用 `Last-Event-ID` 自动续接。

事件至少包括：

- chat.started
- assistant.delta
- thought.delta
- tool.started / tool.finished
- assistant.completed / assistant.failed
- chat.updated
- task.started / task.progress / task.completed / task.failed
- model.changed
- notification.created

后端保留有限事件重放窗口；超出窗口时客户端收到 `resync_required` 并通过 REST 拉取当前会话快照。旧 Web 页面在迁移期间继续使用 `api/poll`，但底层事件源与 SSE 共用同一个 event store。

### 5.4 设备配对与凭据

长期目标是替换一个全局 `DWELL_AUTH_TOKEN`：

1. Mac 后端生成一次性六位配对码，有效期五分钟且只能使用一次。
2. 手机提交配对码、设备名和设备公钥。
3. 后端返回随机设备令牌并只保存其哈希与设备记录。
4. 手机使用 Android Keystore 保护令牌；WebView 和 localStorage 不再接触令牌。
5. 每个设备可在 Mac 后端单独撤销。

v0.6.0 仍接受旧 `DWELL_AUTH_TOKEN` 完成首次迁移，但设置页连接成功后引导转换为设备凭据。CORS 从默认 `*` 改为受控 appassets origin 和显式配置的管理页面来源。

### 5.5 连接管理

原生 `ConnectionManager` 保存局域网地址和 Cloudflare 地址，启动、网络切换和恢复前台时并行健康探测：

- 局域网在 800ms 内健康则优先。
- 局域网失败或连续两次超时则使用 Cloudflare。
- 当前连接健康时不因单次探测结果来回跳地址。
- 两者均离线时显示缓存，不自动发送聊天。

Cloudflare Tunnel 继续使用 HTTPS。生产连接拒绝无效证书；局域网 HTTP 只允许用户明确保存的私网地址。远程入口必须启用 Dwell 设备鉴权，不能只依赖主机名保密。

## 6. 里程碑 B：Compose 原生核心

### 6.1 Android 工程结构

Android 开启 AndroidX、Kotlin 和 Compose，按功能拆分：

- `app/`：Activity、导航、依赖装配、主题
- `core/network/`：REST、SSE、连接状态和鉴权
- `core/database/`：Room schema、缓存和迁移
- `core/design/`：颜色、字体、图标、尺寸、动效
- `feature/chat/`
- `feature/chats/`
- `feature/tasks/`
- `feature/settings/`
- `feature/legacy/`
- `service/voice/`
- `service/notifications/`

单一 Activity 承载 Compose Navigation。WebView 只存在于 `LegacyFeatureScreen`，WebView 崩溃不得关闭聊天核心。

### 6.2 原生页面范围

v0.6.0 必须原生化：

- 启动过渡与全新空白会话
- 主聊天页和长消息列表
- Chats 搜索、筛选、归档和恢复
- 侧边栏及全区域左滑关闭
- 新会话、更多菜单和重命名
- Add to chat
- Sources、Summary、Thought process
- 模型与 effort 选择
- 定时任务列表、任务详情、运行详情
- 设置、连接、通知诊断和运行诊断
- 语音输入、TTS 播放和系统分享

继续由 Legacy WebView 承载：

- 待办
- 日历
- 日记
- 共读
- 日报
- 健康
- 仓库浏览
- 其他低频生活页

原生侧栏打开这些页面时传入明确 feature route；Legacy 页面关闭后回到原生侧栏来源，不再重新加载整个聊天页面。

### 6.3 聊天状态模型

原生客户端使用稳定的 `ChatTurn`：

```text
ChatTurn
  chatId
  userMessage
  assistantVersions[]
  selectedVersionId
  thoughtBlocks[]
  toolEvents[]
  sources[]
  summary
  feedback
  status
  createdAt / completedAt
```

每次重新生成创建新的 assistant version，旧答案不删除；界面默认显示新版本并允许切回旧版本。若原回答包含会修改文件或外部状态的工具，重新生成前必须确认。

消息列表使用稳定 ID 的 `LazyColumn`，只更新正在生成的消息。流式 delta 以约 32–50ms 合并后刷新，避免每个 token 触发整页组合。缓存会话先从 Room 立即显示，再与后端差异同步。

### 6.4 模型选择

模型配置改为会话级，不再只保存一个全局字符串。界面同时显示：

- 用户选择的模型或 Mac 默认
- 后端实际启动参数
- Claude Code 流中返回的实际模型（可获得时）
- 当前 effort
- 是否具备工具、图片、Web search 等能力

后端没有验证成功的模型不能出现在可选列表。切换模型只影响下一轮，不静默改写已经完成的答案。

### 6.5 原生手势和视觉系统

不直接使用 Material 默认外观复制页面。建立 Dwell 自己的 Compose 设计令牌：

- 产品名 `dwell`
- 助手来源 `Claude Code`
- 用户名 `ShiJie`
- 暖白与炭黑双主题，跟随系统并允许临时覆盖
- UI 使用现代无衬线；英文展示标题使用开源衬线；中文标题使用一致的中文衬线回退
- 图标统一 viewBox、视觉尺寸和线宽
- 点击区域不小于 48dp，视觉图标约 18–21dp

所有底部卡片共用一个 `DwellSheetState`，只提供 `closed`、`collapsed`、`expanded` 三个锚点。拖动使用 transform/Compose layer 位移和统一弹簧；expanded 顶部保留安全间距、圆角和边框。内部滚动到顶部后才把下拉交给卡片，按钮拖动后不得误触。

侧栏同样使用单一状态机，任意非横向滚动控件位置均可向左拖动关闭。系统返回键、预测性返回手势和页面左上角按钮执行同一导航动作。

### 6.6 离线与缓存

Room 保存：

- 会话列表和最近消息
- 当前任务及运行记录快照
- 模型能力快照
- 未发送草稿
- 连接状态和同步游标

DataStore 保存非敏感偏好；凭据只进 Keystore。完全离线时聊天只能保存草稿，必须由用户恢复网络后再次确认发送。待办、日历等 Legacy 页面继续使用现有 IndexedDB 队列，后续版本再逐页迁移到 Room。

## 7. 里程碑 C：系统集成、通知和稳定性

### 7.1 Legacy 页面集成

Legacy WebView 使用 `WebViewAssetLoader` 从 `https://appassets.androidplatform.net` 加载打包资源，关闭 file URL 的 universal access。原生层只向页面传递 feature route、主题和必要的非敏感页面参数；API 请求由受控原生网络桥发出，设备令牌不注入 JavaScript。

每个 Legacy 页面拥有独立返回路径、加载态、离线快照、错误态和 renderer 恢复。关闭 Legacy 页面只弹出该 Compose destination，不销毁原生聊天状态、SSE 连接或当前草稿。

### 7.2 通知

通知分两层：

- **FCM 实时层**：聊天完成、定时任务完成或失败后，由 Mac 后端发送 data message；手机生成本地通知并深链到对应聊天或任务运行详情。
- **WorkManager 补偿层**：定期校对通知游标，补回 FCM 丢失的事件；它不承担秒级实时通知承诺。

FCM 需要用户拥有的 Firebase Android 项目和 Mac 侧发送凭据。仓库实现可选 FCM 模块和完整诊断；没有 `google-services.json` 与服务端凭据时仍能构建并使用 WorkManager 补偿，但验收结果必须明确标记“实时推送未启用”，不能假装完成。

设置页通知诊断依次显示：系统权限、FCM token、后端设备注册、Mac 发送能力、最近发送、最近收到和补偿轮询。

### 7.3 语音

保留 Android SpeechRecognizer 与系统 TTS，不加入体积巨大的离线语音模型。语音控制器独立于 Activity 生命周期，具备明确的 `idle/listening/processing/error` 状态、权限诊断和系统识别 Intent 兜底。

TTS 从结构化消息块生成可朗读文本，不再只靠正则删除星号。代码块、URL、表格和界面标签按明确规则省略或转换；播放支持停止、速度设置和切换消息自动停止上一条。

### 7.4 崩溃与安全模式

应用记录不含消息正文的结构化诊断。若两分钟内连续发生三次启动或渲染崩溃，下次进入安全模式：禁用 Legacy WebView 自动恢复、停止循环重载、保留聊天缓存并提供复制诊断。Legacy WebView renderer 崩溃只重建该页面，不重启整个 Activity。

## 8. 正式签名和升级策略

v0.4.7 是 debug 签名。v0.6.0 建立一把项目专用 release keystore，保存在仓库外并备份，密码只通过本机环境变量或 GitHub Secrets 提供。

Android 不允许不同证书直接覆盖安装同一 package，因此从 v0.4.7 到 v0.6.0 需要一次卸载再安装。Mac 后端业务数据不会丢失；v0.6.0 通过六位配对码重新获取连接，不要求用户再次手抄长 token。此后所有 v0.6+ 使用同一 release key，可正常覆盖升级。

若用户在书面规格复核时明确要求保留覆盖安装，则必须继续使用现有 debug certificate，并接受长期签名安全和备份风险；默认采用一次性重装建立正式签名。

版本号：

- applicationId 保持 `com.xinwithyu.dwell`
- versionName `0.6.0`
- versionCode `15`

## 9. 测试与发布门槛

### 9.1 自动测试

后端：

- JSON/JSONL 到 SQLite 的数量与内容迁移测试
- SQLite 事务回滚和重复迁移测试
- 设备配对、过期、撤销和旧 token 迁移测试
- SSE 顺序、断线续接、过期游标和多会话隔离测试
- Claude 流、模型、重新生成、上传和通知集成测试
- 定时任务只读测试；真实手动任务测试仍只允许 `Github trending backup`

Android：

- Room migration 和 repository 单元测试
- ConnectionManager 端点切换测试
- SSE reducer 和重复事件测试
- Compose 页面、返回层级、空态、错误态和底部卡片 UI 测试
- 语音权限、无识别服务、TTS 清洗和停止测试
- 通知深链和安全模式测试

仓库新增 GitHub Actions，执行 Node 检查、后端测试、Android unit test、lint 和 unsigned release build。正式签名只在受保护的 release workflow 中执行。

### 9.2 真机验收

GitHub Release 前必须在三星 S25+ 验收：

- 冷启动进入空白新会话
- 1000 条以上历史中的会话切换
- 长回复流式渲染、滚动和代码块
- 所有底部卡片和侧栏手势
- 中文语音输入和 TTS
- 浅色/深色系统切换
- 局域网、5G Cloudflare、断网缓存和恢复
- FCM 通知及任务运行深链（配置 FCM 时）
- App 前台、后台、被系统回收后恢复
- v0.6.0 APK 签名、包名、版本、资源与 SHA-256

目标指标：

- 缓存会话首屏在点击后 150ms 内出现。
- 连接正常时 SSE 中断后 3 秒内恢复。
- 卡片和侧栏拖动期间无超过 50ms 的明显停顿，至少 95% 帧低于 16.7ms。
- FCM 已配置时，Mac 产生完成事件到手机通知通常少于 10 秒。
- 语音按钮在 1.5 秒内进入监听或给出具体错误。
- 任何未捕获错误不得导致连续闪退循环。

## 10. 回滚和数据保护

- 开始迁移前创建 Git tag 和数据备份。
- 旧 JSON/JSONL 至少保留到 v0.6.1 验收结束。
- SQLite migration 失败时不写迁移完成标志。
- Compose 原生核心异常时，开发构建可切换到旧 Web 聊天壳；正式版不自动静默降级。
- v0.4.7 GitHub Release 和 APK 保留作为可下载回滚版本。
- `night/` 和其他用户未跟踪文件不纳入提交。

## 11. 明确不在 v0.6.0 做的事

- 不把 Claude Desktop GUI 会话冒充为 Claude Code CLI 会话。
- 不新建、编辑或删除 Claude Desktop 定时任务；手机只查看、运行、暂停和恢复。
- 不自动发送离线聊天草稿。
- 不复制 Anthropic 私有字体、商标或受保护资源。
- 不原生重写全部生活页面。
- 不增加多用户、公开注册、支付或云端托管数据库。
- 不在没有 Firebase 项目凭据时宣称秒级后台推送已经完成。

## 12. 完成定义

只有同时满足以下条件，v0.6.0 才算完成：

1. v0.4.7 数据无损迁入 SQLite，迁移报告通过。
2. Compose 原生核心功能真实连接 Mac 后端，不存在假按钮和演示模型。
3. SSE、会话、模型、任务、语音、TTS、设置和通知诊断通过自动测试。
4. Legacy 页面通过受控 appassets WebView 打开，不能访问设备凭据。
5. release-signed APK 可安装，后续同证书版本可覆盖升级。
6. 三星 S25+ 真机完成规定的网络、手势、语音、后台和长会话验收。
7. 代码、迁移工具、测试、README、APK 和 GitHub Release 一起发布。
8. FCM 未配置时，Release 说明明确标注该项；配置后必须完成真实通知端到端验收。
