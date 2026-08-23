# Dwell v0.6.1：FCM、Claude Cli 品牌、暗色主题与 Luna 路由设计

日期：2026-08-23  
状态：多专项代理与对抗复核已完成，等待用户书面规格复核  
目标版本：Android `0.6.1`、versionCode `16`

## 1. 决策摘要

本次升级完成四项用户需求，但四部分保持独立启用、独立门禁和独立回滚：

1. 接入 Android 原生 Firebase Cloud Messaging（FCM），用于 App 后台或进程被系统回收后的实时通知。
2. 将 Android 用户可见名称改为精确大小写 `Claude Cli`，保留包名和内部兼容标识。
3. 修复暗色模式下大量文字继承黑色的问题，并统一 Compose、原生启动主题和 Legacy WebView 的主题边界。
4. 将 Dwell 主聊天的 Claude CLI 请求模型迁移到本机网关已验证别名 `claude-opus-5`；只有成功请求的原始运行时元数据确认后，界面才显示实际上游 `gpt-5.6-luna`。

主流程负责最终架构、代码整合、生产变更和验收；专项代理只负责独立分析和反向审查。不会让多个代理无协调地同时修改同一文件。

上线不把数据库迁移、Android 发布、FCM 激活和模型切换压进同一变更窗口：

1. 后端迁移能力、通知一致性和模型可观测性；
2. Android 改名、主题和新通知客户端；
3. FCM 配置版 canary；
4. FCM 单设备激活；
5. Luna 并行 canary；
6. 满足独立回滚或用户明确接受 `fail_closed_only` 后，才允许生产 Luna 切换。

## 2. 已确认现状

### 2.1 Android

- `applicationId` 和 namespace 均为 `com.xinwithyu.dwell`。
- Manifest 的 `android:label` 已引用 `@string/app_name`，当前值为小写 `dwell`。
- 已声明 `POST_NOTIFICATIONS`，但没有 Firebase Messaging、Google Services 插件、`google-services.json` 或 `FirebaseMessagingService`。
- 当前通知路径是前台 SSE 和后台 WorkManager；未配置 FCM 时，后台延迟可达约 15 分钟。
- 设置页“实时 FCM / 未配置 Firebase 凭据”是硬编码文本，不是实际诊断。
- 当前 `DwellDatabase` 为 Room version 1，保存 chats、messages 和 drafts。
- 当前通知游标是一个未按后端、设备或通知 epoch 分区的 DataStore `Long`。
- `DwellTheme` 已定义暗色前景色，但根 Compose 树没有提供全局 Material `Surface`。页面大量使用 `Modifier.background()`；该修饰符不设置 `LocalContentColor`，因此未显式指定颜色的 `Text` 和 `Icon` 会继承默认黑色。这是大面积暗色黑字的首要根因。
- Manifest 始终使用浅色 `AppTheme`；现有 `AppThemeDark` 没有自动选择路径，也没有 `values-night/themes.xml`。
- Legacy WebView 有独立主题状态，可能与 Android App 内强制主题相反。

### 2.2 后端通知

- `state.notifications.items`、SQLite `notification_events` 和 SSE 形成三套通知表示；内存状态仍承担主要事实源。
- `notification_events` 会在完整 snapshot 保存时删除并重建，不能作为稳定 outbox 外键来源。
- 直接聊天完成路径没有统一执行“消息完成事务 → durable notification → SSE → FCM”。
- WorkManager 当前只展示返回列表的最后 3 条，却把游标推进到服务器最新值；一页超过 3 条时会永久漏通知。
- 当前接口返回最新 50 条而不是 oldest-first 增量页，积压超过 50 条时也会跳过历史。
- 当前任务扫描只保留最新一批 completed run；停机期间完成数量超过上限时，较早 run 可能永远不会被观察。
- 现有 Web Push `subscriptions` 不绑定配对设备，不能复用为 Android FCM 注册表。

### 2.3 数据库

- 当前后端 `SCHEMA_VERSION=1`。
- 现有打开逻辑没有 v1 → v2 增量迁移框架；直接提升版本会使生产数据库拒绝启动。
- 数据库启用了 WAL、foreign keys 和 busy timeout。
- 当前生产数据同时存在 `notification_events`、`state.notifications.items` 和 `taskSeen`；已观察任务数可能多于通知数。迁移不能简单丢弃 `taskSeen`，否则旧任务会重新提醒。

### 2.4 模型路由

当前生产 LaunchAgent 配置请求模型为：

```text
DWELL_CLAUDE_MODEL=deepseek-v4-flash
```

专项审查使用生产 Claude 可执行程序和本机网关做了非破坏性探测：

```text
Claude CLI 请求别名：claude-opus-5
system.init.model：claude-opus-5
assistant.message.model：gpt-5.6-luna
进程退出码：0
result.is_error：false
```

直接传入 `gpt-5.6-luna`、当前 `deepseek-v4-flash`、`haiku` 和子代理调度别名均失败。因此三个标识必须分开：

| 层级 | 标识 | 用途 |
| --- | --- | --- |
| Dwell 传给 Claude CLI | `claude-opus-5` | `DWELL_CLAUDE_MODEL` 候选值 |
| 网关实际上游 | `gpt-5.6-luna` | 成功 assistant 事件观察到的实际模型 |
| 子代理调度别名 | `claude-fable-5-dd-anul-6.5-tpg` | 只用于代理调度，不得写入 Dwell 模型变量 |

当前 `GET /api/v2/model` 响应中的 `runtime`，以及 `GET /api/v2/bootstrap` 内嵌的同一 model view，都不是运行时证明。后端把配置选择复制为 runtime，Android 又将其显示为“实际运行”。必须先修复可观测性，再启用 Luna 用户可见声明。

当前没有独立、已验证的模型回滚 route bundle：`claude-sonnet-5` 与 `claude-opus-5` 映射到同一 Luna 上游，不能防护 Luna 上游故障。

## 3. 范围与非目标

### 3.1 本次范围

- 后端 schema v2、顺序迁移、WAL 一致备份和通知 epoch。
- durable notification、任务 observation、每设备 FCM outbox、重试和失效 Token 清理。
- 兼容旧 APK 的通知分页升级。
- Android 独立通知 inbox 数据库、三路去重、游标、Token 生命周期和内部深链。
- Firebase disabled/enabled 双模式构建和真实项目激活。
- Android 用户可见品牌统一为 `Claude Cli`。
- Compose 根内容颜色、语义色、原生夜间启动主题和 WebView 主题同步。
- Claude CLI 请求模型、路由类型、当前 attempt 和 actually observed model 的真实可观测性。
- Dwell 专用 Claude CLI 配置身份、Luna canary、LaunchAgent 安全切换和 fail-closed 边界。
- 自动测试、API 31/33/35 instrumentation 和 Samsung S25+ 真机验收。

### 3.2 明确不做

- 不修改 `applicationId`、namespace、Kotlin 包名、现有聊天 Room 数据库名、DataStore 名、Keystore alias 或 `DwellDevice` 鉴权 scheme。
- 不把 Android App 改造成直接调用云端模型 API 的独立客户端。
- 不把 Claude Desktop GUI 变成交互式聊天后端。
- 不复用 Web Push subscription 作为 FCM 注册。
- 不把 Firebase Admin 私钥写入 APK、Git、SQLite、日志、设计文档或打印出的 LaunchAgent 内容。
- 不把上游名或子代理调度别名直接当成 Claude CLI `--model` 参数。
- 不静默改写 Claude Desktop 定时任务已有模型。
- 初始 Luna 上线不启用静默 `--fallback-model`。
- 不对整个 `server.mjs` 做与本次目标无关的大规模重构。
- 不在没有真实 Firebase 资源时宣称 FCM 已激活。
- 不在没有独立回滚 bundle、且用户也没有明确接受 `fail_closed_only` 时切换生产 Luna。

## 4. 总体架构与通知身份

```text
成功聊天完成 / 定时任务进入终态
                 |
                 v
       SQLite notification service
 event-key dedupe + notification epoch + outbox
       |                  |                 |
       |                  |                 +--> Firebase Admin --> FCM
       |                  +--> SSE notification.created
       +--> REST order=asc 分页补偿

Android NotificationCoordinator
       ^                 ^                 ^
       |                 |                 |
      FCM               SSE           WorkManager REST
       |                 |                 |
       +---- 独立 Room persistent inbox --+
                         |
                         v
            稳定本地通知 + 严格内部深链
```

核心原则：

- SQLite `notification_events` 是后端唯一通知事实源；SSE、FCM 和 REST 只是传输路径。
- 后端数据库拥有随机 UUID `notification_epoch`。通知 ID 只在一个 epoch 内有意义。
- Android 去重 scope 固定为：

```text
(notification_epoch, paired_device_id, notification_id)
```

- **只有成功处理 oldest-first REST 页面后才能推进 REST cursor；FCM 和 SSE 永远不得读取或修改该 cursor。**
- FCM 不阻塞聊天完成或 SSE。
- FCM data payload 不包含聊天正文、任务摘要、工具输出或其他用户生成内容。
- FCM 未配置或关闭时，SSE 和 WorkManager 仍完整可用。
- 旧 APK 与新后端共存期间，后端保留 v0.6.0 默认通知接口语义。

## 5. 后端组件边界

### 5.1 `backend/services/fcm-sender.mjs`

新增窄职责发送器：

- 延迟初始化 Firebase Admin SDK；
- 从仓库外 ADC 路径加载凭据；
- 将已校验通知转换为 high-priority、data-only FCM message；
- 设置 Android package restriction 和 TTL；
- 批量发送并返回逐 Token 结果；
- 区分成功、临时错误、永久 Token 错误、单 Token 项目不匹配和 sender-wide 错误；
- 不访问 HTTP request、SQLite 或聊天状态；
- 不记录 Token、凭据、Authorization、正文或 route 原文。

真实发送必须同时满足：

```text
DWELL_FCM_ENABLED=1
GOOGLE_APPLICATION_CREDENTIALS=<仓库外绝对路径>
DWELL_FCM_ANDROID_APP_ID=<预期 Firebase Android app ID>
DWELL_FCM_PROJECT_ID=<预期 Admin project ID>
```

### 5.2 `backend/services/notification-service.mjs`

负责：

- 通过唯一 `event_key` 创建或返回既有通知；
- 在同一事务内创建符合条件的 per-device delivery；
- 事务提交后才发送 `notification.created` SSE；
- oldest-first REST feed；
- outbox claim、fencing lease、重试、过期、取消和 dead 状态；
- Token generation guard、quarantine 和永久失效处理；
- sender disable 时取消 nonterminal delivery；
- 重启后回收过期 lease；
- 显式 shutdown dispatcher。

### 5.3 `backend/db/database.mjs`

数据库模块只提供存储操作，不导入 Firebase：

- `registerPushToken`
- `unregisterPushToken`
- `pushStatus`
- `notificationBaseline`
- `commitAssistantCompletion`
- `observeTaskRunAndCreateNotification`
- `listNotificationsAfter`
- `claimPushDeliveries`
- `completePushDelivery`
- `retryPushDelivery`
- `recoverExpiredPushLeases`
- `removeInvalidPushToken`
- `quarantinePushToken`

`notification_events` 和 task observations 从 snapshot destructive replacement 中完全移除。

### 5.4 子进程环境隔离

新增统一 sanitized child-environment builder，供以下路径共同使用：

- 主 Claude CLI；
- Gong；
- news；
- Desktop task bridge；
- MCP helper；
- 其他 `spawn`/`execFile`。

非 FCM 子进程至少移除：

```text
GOOGLE_APPLICATION_CREDENTIALS
全部 DWELL_FCM_* 变量
其他仅供后端使用且不属于 Claude route 的 secret
```

禁止调用点继续直接展开完整 `process.env`。Claude CLI 所需的专用 route 变量由明确 allowlist 传入。Admin credential 必须位于 workspace 和所有 `--add-dir` root 之外。

`0600` 只能隔离其他 OS 用户；如果要求隔离同一用户进程，FCM sender 必须运行在独立 OS identity 或隔离 helper 中。

## 6. 后端 schema v2 与迁移

### 6.1 一致备份和迁移框架

在提升到 schema 2 之前，拆分：

- pragma 设置；
- fresh latest schema；
- legacy JSON/JSONL 首次导入；
- 已存在 SQLite 的顺序迁移；
- 未知更高版本拒绝逻辑。

v1 → v2：

1. drain 服务并取得数据库 single-writer/process ownership，停止新事务；
2. 执行 `wal_checkpoint(TRUNCATE)` 并检查返回值；checkpoint busy 或仍有未 checkpoint frame 时中止；
3. 使用 SQLite online-backup API 从打开的源连接生成一致备份；禁止把未验证的单独主文件复制当成有效备份；
4. 用独立只读连接执行 `PRAGMA integrity_check`，结果必须为 `ok`；
5. 设置备份权限 `0600`，fsync 文件及父目录；
6. 在一个 immediate transaction 内执行全部 DDL、数据迁移和状态清理；
7. 只在全部成功后写入 `meta.schema_version=2`；
8. 失败则回滚，原 v1 数据库保持不变；
9. 未知更高 schema 不进行任何写入并拒绝启动。

旧 v1 二进制不能打开 v2 数据库。后端代码回滚必须与一致 v1 备份恢复同时进行。

### 6.2 通知、任务、Token 与 outbox 表

迁移将 `notification_events` 重建为保留原 ID 的 `INTEGER PRIMARY KEY AUTOINCREMENT` 表，并为非空 `event_key` 建唯一部分索引。重复 key 确定性保留最早 ID。

新增：

```sql
CREATE TABLE task_run_observations (
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  PRIMARY KEY(task_id, run_id)
);

CREATE TABLE assistant_turn_completions (
  attempt_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  message_seq INTEGER NOT NULL UNIQUE,
  completed_at INTEGER NOT NULL,
  route_fingerprint TEXT NOT NULL
);

CREATE TABLE device_push_tokens (
  device_id TEXT PRIMARY KEY
    REFERENCES paired_devices(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL UNIQUE,
  token_generation INTEGER NOT NULL DEFAULT 1,
  package_name TEXT NOT NULL,
  firebase_app_id TEXT NOT NULL,
  app_version TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_success_at INTEGER,
  last_error_code TEXT,
  last_error_at INTEGER,
  quarantined_at INTEGER,
  quarantine_code TEXT
);

CREATE TABLE push_deliveries (
  notification_id INTEGER NOT NULL
    REFERENCES notification_events(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL
    REFERENCES paired_devices(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (
    state IN ('pending','sending','retry','sent',
              'expired','cancelled','dead')
  ),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  lease_token TEXT,
  lease_until INTEGER,
  expires_at INTEGER NOT NULL,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  sent_at INTEGER,
  PRIMARY KEY(notification_id, device_id)
);

CREATE INDEX idx_push_deliveries_due
  ON push_deliveries(state, next_attempt_at);
```

`meta.notification_epoch` 为随机 UUID。fresh database 和 v1→v2 都生成。恢复较旧备份、重建通知数据或任何可能使通知 ID 倒退的操作必须轮换 epoch，并把恢复出的 nonterminal delivery 改为 `cancelled`。

### 6.3 `app_state.notifications` 和 `taskSeen` 迁移

v1→v2 必须：

1. 原样保留现有通知 ID；
2. 将 `state.notifications.taskSeen` 全部迁入 `task_run_observations`；这些旧 run 不创建 notification 或 delivery；
3. 从 `app_state.payload` 完整删除 `notifications` 对象，包括 items、next、chatMax、taskSeen 和 initialized；
4. `saveState`、snapshot、备份和恢复统一使用 sanitizer，禁止再次写入通知副本；
5. 新任务扫描在同一事务内插入 observation、notification 和符合条件的 delivery；observation 已存在时不通知。

### 6.4 Chat 会话身份迁移

现有 `sessionId` 拆为：

- `sourceSessionId`：Claude Code 导入来源的不可变身份；
- `resumeSessionId`：当前 provider/route 下可清空的 CLI resume ID。

v1 迁移：

- `source='claude-code'`：旧值同时迁入 source 和 resume；
- 其他来源：旧值只迁入 resume。

route fingerprint 改变时只清除 resume，不删除 source identity、消息、draft、feedback 或任务历史。

## 7. Durable 通知语义

### 7.1 聊天完成

每个成功 assistant turn 只创建一条通知：

```text
event_key = chat:<final-assistant-message-seq>
```

不通知 delta、thought、tool、stopped、failed 或同 turn 的中间 assistant 事件。

成功 final result 的 durable commit 使用一个 immediate transaction：

1. 写入或确认最终 assistant message；
2. 写入 `assistant_turn_completions`；
3. 创建唯一 notification event；
4. 仅当 sender 启动配置同时 `enabled && configured` 时，为当时具有有效、未 quarantine Token 的活跃设备创建 delivery。

任何一步失败都回滚。`assistant.completed` 和 `notification.created` 不得在提交前发出。此 persistence API 必须传播 SQLite 错误，不能通过吞掉 rejection 的 queue 只记日志。

重新生成产生新 message sequence，因此产生新通知。迁移前历史消息只作为 baseline，不推断成功、不补发历史通知。

### 7.2 任务完成

统一状态：

```text
queued | running | success | failed | cancelled | interrupted
```

终态：

```text
success | failed | cancelled | interrupted
```

- 明确 cancellation 才映射 `cancelled`；
- 长时间无 result、进程消失或审计异常终止映射 `interrupted`；
- interrupted 的稳定 `completedAt` 使用审计 mtime 或首次观察时间；
- 不把未知状态猜为 cancelled。

通知 key：

```text
task:<taskId>:<runId>
```

标题分别为“已完成”“运行失败”“已取消”“已中断”。

45 秒触发频率可以保留，但“只取最新 N 条”不能作为权威输入。每个 task source 必须 oldest-first 增量分页，使用 durable watermark；持续读取直到 watermark 后所有终态 run 都已检查。只有 observation/event 事务提交后才能推进 watermark。

### 7.3 共享 envelope 与 ID

`notification_events.id` 是正的 signed int64，在一个 epoch 内不复用。

SSE：

```json
{
  "id": 9876,
  "type": "notification.created",
  "data": {
    "notification_epoch": "uuid",
    "device_id": "device_...",
    "id": 1234,
    "notification_id": 1234,
    "kind": "chat",
    "title": "Claude Cli",
    "body": "回答已完成",
    "route": "chat/<encoded-id>",
    "at": 1787000000
  }
}
```

顶层 `id` 只用于 `Last-Event-ID`。REST cursor、FCM、Android inbox、本地通知和深链只使用 `data.notification_id`。

FCM data-only payload 固定为字符串值：

```text
v="1"
notification_epoch="<uuid>"
device_id="<paired device id>"
notification_id="<positive decimal int64>"
kind="chat|task"
title="Claude Cli"
chat body="回答已完成"
task body="任务运行已结束"
route="<strict internal route>"
at="<Unix epoch seconds>"
```

FCM 不包含用户生成内容。详细内容只在打开 App 后通过已鉴权 API 获取。

边界：

- kind 必须与 route 前缀一致；
- percent-encoded route 最多 1024 UTF-8 bytes；
- title/body 各最多 64 UTF-8 bytes；
- `Buffer.byteLength(JSON.stringify(data), 'utf8')` 不超过 3500 bytes；
- 超限不调用 Firebase，delivery 转 `dead`，只记录 `payload_too_large`；
- `restrictedPackageName=com.xinwithyu.dwell`；
- 不使用顶层 Firebase `notification` payload；
- 不设置会合并不同 notification ID 的 collapse key。

## 8. API 合约

### 8.1 Bootstrap 和通知 baseline

Bootstrap 增加当前鉴权设备和通知 epoch：

```json
{
  "device_id": "device_...",
  "notification_epoch": "uuid"
}
```

新增：

```text
GET /api/v2/notifications/baseline
```

响应：

```json
{
  "ok": true,
  "device_id": "device_...",
  "notification_epoch": "uuid",
  "latest": 1234
}
```

该接口只依赖 `DwellDevice` 鉴权，与 Firebase Token 和 sender 状态无关。

Android 按 `(notification_epoch, device_id)` 保存 cursor 和 `cursor_initialized`：

- 首次启用、配对身份变化或 epoch 变化时，先取得并提交 baseline，再启动 SSE 通知展示和 Worker；
- baseline 失败时显示“等待通知初始化”，不得从 0 展示历史；
- 从 v0.6.0 受控升级时，只有 bootstrap 验证仍是同一设备和迁移 epoch，才把旧未分区 cursor 一次性迁入；否则使用 baseline；
- FCM Token 注册、刷新、轮换、sender 开关和 App 重启永远不重置 cursor。

### 8.2 注册或轮换 FCM Token

```text
PUT /api/v2/devices/me/push-token
```

只接受真实配对设备的 `DwellDevice` 鉴权。服务端只使用 `auth.deviceId`，拒绝客户端 device ID。

请求：

```json
{
  "provider": "fcm",
  "token": "<opaque FCM token>",
  "package_name": "com.xinwithyu.dwell",
  "app_version": "<BuildConfig.VERSION_NAME>",
  "firebase_app_id": "<Firebase Android app ID>"
}
```

规则：

- provider 精确为 `fcm`；
- Token 是 opaque string，拒绝控制字符，最大 4096 bytes；
- package 精确匹配；
- app version 最大 64 UTF-8 bytes；
- Firebase app ID 最大 256 UTF-8 bytes，并在 enabled 部署中与服务端预期值匹配；
- 同设备同 Token 幂等，不递增 generation；
- 真实轮换在事务中递增 `token_generation`；
- Token 被另一活跃设备持有时返回 `409 push_token_bound_elsewhere`；由已撤销设备持有的旧 binding 可在事务中清理后重绑；
- sender 未启用时仍可保存注册并返回非敏感状态；不会回填关闭期间的旧通知。

响应不含 Token 和 baseline：

```json
{
  "ok": true,
  "device_id": "device_...",
  "registered": true,
  "new_binding": true,
  "sender": {
    "enabled": false,
    "configured": false,
    "health": "unavailable",
    "project_match": true
  }
}
```

### 8.3 注销与诊断

```text
DELETE /api/v2/devices/me/push-token
GET /api/v2/devices/me/push-status
```

DELETE 幂等删除当前设备 Token，并取消该设备 nonterminal delivery。URL/body 不携带 Token。

Status 返回：

- registered；
- sender enabled/configured/health；
- project match；
- Token 更新时间；
- 最近成功时间；
- 脱敏错误码；
- quarantine 状态；
- pending 数量。

不返回原始 Token。CORS methods 增加 PUT 和 DELETE。

### 8.4 通知分页与旧 APK 兼容

兼容期：

```text
GET /api/v2/notifications?since=<id>&limit=<n>&order=asc
```

- 未传 `order`：保留 v0.6.0 行为，返回 since 后最新最多 50 条，页内 ID 升序，`next=latest`；
- `order=asc`：返回 since 后最旧一页，新 Android 必须显式使用；
- REST item 同时返回数值相同的 `id` 与 `notification_id`；
- since 只接受十进制非负 int64；
- limit 默认 50，范围 1–100；
- 只允许缺省或 `asc`；
- 空字符串、负数、小数、指数形式、溢出和未知 order 返回 400 `invalid_pagination`。

`order=asc` 查询读取 `limit+1` 条：

- 返回前 limit 条；
- 多出一条只用于计算 `has_more`；
- `next` 为页末 ID，空页等于传入 since；
- `latest` 只用于诊断，Android 不得写入 cursor。

Worker 每次最多处理 10 页。只有本页每项已经进入 inbox、识别为重复或进入 `invalid` 终态后，才提交该页 next；仍有更多时调度按 notification scope 命名的唯一 continuation work。

v0.6.x 不删除或压缩 `notification_events`。只有最低支持 APK 全部使用 `order=asc` 后，后续 major API 才能删除兼容字段或改变默认排序。

## 9. FCM outbox 状态机

### 9.1 创建规则

进程启动时固定 sender enabled/configured 状态：

- disabled：创建 notification event，不创建 delivery；
- enabled 但未配置：创建 event，不创建 delivery；
- enabled 且 configured：为当时有效、未 quarantine 的活跃设备创建 delivery；
- configured 后发生临时 unhealthy：已创建 delivery 按重试规则处理；
- 从 disabled 切到 enabled：只处理切换后新 event，不回填历史；
- disabled 启动或从 1 切到 0：停止 claim，把遗留 pending/retry/sending 事务性改为 cancelled；晚到结果不得覆盖 cancelled。

### 9.2 Claim 和 fencing

- 批量上限 100；
- 只 claim 到期、未过期的 pending/retry；
- immediate transaction 内执行 `pending|retry → sending`；
- attempts +1；
- 生成唯一 `lease_token`；
- lease 固定 120 秒；
- claim 返回实际 device ID、token generation、token hash 和 Token；
- success/retry/dead 更新必须带：

```sql
WHERE state='sending' AND lease_token=:claimedLeaseToken
```

- lease 到期且未过期：sending → retry；
- lease 到期且已过期：sending → expired；
- 终态：sent、expired、cancelled、dead。

### 9.3 Retry 和 TTL

聊天 absolute retry offset：

```text
[0, 30, 120, 600, 1800] 秒
expires_at = created_at + 3600
```

任务：

```text
[0, 30, 120, 600, 1800, 7200] 秒
expires_at = created_at + 86400
```

首次外重试 jitter 为 ±10%，绝对值不超过 30 秒；offset 始终相对 created_at，避免重启漂移。

发送前：

```text
remainingMs = (expires_at - now) * 1000
android.ttl = remainingMs
```

聊天最大 `3_600_000` ms，任务最大 `86_400_000` ms。已过期不调用 Firebase，转 expired。次数耗尽转 dead。

### 9.4 Token generation、撤销和 quarantine

永久 Token 错误：

```text
removeInvalidPushToken({deviceId, tokenGeneration, tokenHash})
```

删除条件必须同时匹配三者。影响 0 行表示 Token 已轮换，当前 delivery 返回 retry 使用新 Token；影响 1 行时取消该设备其余 nonterminal delivery。Token 级成功/错误更新也带 generation/hash guard。

设备撤销是一个 immediate transaction：

```sql
UPDATE paired_devices
SET revoked_at=:at
WHERE id=:deviceId AND revoked_at IS NULL;

DELETE FROM device_push_tokens
WHERE device_id=:deviceId;

UPDATE push_deliveries
SET state='cancelled', lease_token=NULL, lease_until=NULL, updated_at=:at
WHERE device_id=:deviceId
  AND state IN ('pending','retry','sending');
```

不得声称 soft revoke 会触发 ON DELETE cascade。

逐 Token `mismatched-credential` 或 project mismatch 只 quarantine 当前 generation，停止新建/发送其 delivery，直到匹配配置的重新注册清除。它不删除其他 generation，也不自动判定 sender-wide outage。

## 10. Android 持久通知架构

### 10.1 独立 Room 数据库

不修改现有 `dwell-mobile.sqlite`，其 `DwellDatabase` 保持 version 1，确保旧 APK 仍能打开聊天缓存。

新增独立：

```text
notification-receipts.sqlite
```

保存：

- notification scope；
- REST cursor；
- persistent inbox；
- presentation lease；
- registration cleanup state。

inbox 主键：

```text
(notification_epoch, paired_device_id, notification_id)
```

状态：

```text
pending
presenting
presented
suppressed_disabled
suppressed_permission
invalid
```

只清理已进入终态且 `received_at < now - 30天` 的记录；不按数量删除 30 天窗口内数据，也不清理 pending/presenting。

必须测试：已有数据的 `dwell-mobile.sqlite` → 新 APK 创建独立通知库 → 安装旧 APK仍能读取原聊天缓存。

### 10.2 `NotificationCoordinator`

FCM、SSE 和 REST 全部调用同一 coordinator：

1. 校验 epoch、device、envelope 和 route；
2. 通知关闭或权限缺失时，幂等写入对应 `suppressed_*` 终态；
3. 其他情况幂等插入 pending；
4. 原子 claim pending → presenting，设置有界 presentation lease；
5. 使用稳定 tag/ID 调用 `NotificationManager.notify()`；
6. notify 返回后写入 presented；
7. 过期 presenting lease 回收为 pending。

App 启动、权限恢复和 WorkManager 重试 pending/过期 presenting。若进程在 notify 后、状态提交前死亡，重试使用相同 tag/ID 和 `.setOnlyAlertOnce(true)`，避免重复响铃。

`suppressed_*` 在重新开启或恢复权限后不补响。invalid 只记录不含 Token、title、body 或 route 原文的诊断码。

`FirebaseMessagingService.onMessageReceived()` 返回前必须完成持久插入和一次有界展示尝试，不把唯一持久化交给无生命周期保证的 coroutine。

### 10.3 本地通知和 PendingIntent 身份

Tag：

```text
dwell-notification:<epoch>:<deviceId>:<notificationId>
```

Integer ID：

```kotlin
((notificationId xor (notificationId ushr 32)) and 0x7fffffffL).toInt()
```

调用：

```text
NotificationManager.notify(tag, id, notification)
```

设置 `.setOnlyAlertOnce(true)`、private lock-screen visibility 和无敏感内容的 public version。

每个 PendingIntent 除显式 component 外，还必须设置包含 epoch、device ID 和完整 notification ID 的唯一 `Intent.action` 或 `Intent.data`。Route 可以放 extra，但不得依赖 extras 或 31-bit requestCode 建立 PendingIntent 身份。

### 10.4 严格内部深链

只接受：

```text
chat/{percent-encoded-chatId}
task/{percent-encoded-taskId}/{percent-encoded-runId}
```

每个解码 ID 必须非空、无控制字符、最多 512 UTF-8 bytes；完整 route 最多 1024 bytes。拒绝 malformed encoding、未知 route、HTTP URL、任意 Intent URI 和 WebView path。

MainActivity 首先用统一 parser 校验 initial Intent，并保存至多一个 pending destination；调用 `repository.start(openRoute)`。Bootstrap/配对成功后才消费；存在 pending destination 时禁止自动 `prepareNewChat()`。`onNewIntent` 使用同一 parser 和队列。无效 destination 不改变当前聊天。

### 10.5 游标

REST cursor 只存于独立通知数据库，按 `(epoch,device)` 分区。

- SSE/FCM 只插入 inbox，不读写 cursor；
- REST 页面每项成为 pending/presented/duplicate/suppressed/invalid 后才提交页末 next；
- latest 永远不推进 cursor；
- 先收到 ID 150 的 SSE/FCM，再由 REST 返回 101–149 时，101–150 最终都进入 inbox且最多展示一次。

### 10.6 通知与注册生命周期

本地注册状态：

```text
disabled → register_pending → registered
registered → unregister_pending → disabled
disconnected_pending_revoke → disconnected
```

启用：

1. 创建 channel；
2. Android 13+ 请求权限；
3. 取得 baseline 并初始化 scope；
4. 持久化 enabled/register_pending；
5. 开启 Firebase auto-init；
6. 获取 Token 并调度注册；
7. 配对、bootstrap、reconnect 和 `onNewToken()` 触发幂等 healing。

关闭：

1. 第一时间持久化 disabled，使 coordinator 停止展示；
2. 关闭 auto-init，取消 registration/poll/continuation work；
3. 保存 unregister_pending；
4. 尝试后端 DELETE；
5. 调用 `FirebaseMessaging.deleteToken()`；
6. 网络 I/O、408、429、5xx 保持 pending 并重试；
7. 失败不得重新启用展示；
8. 重新开启前重新取得 baseline，不补响关闭期间历史。

`onNewToken()` 和 Worker 在联网紧前一刻重新读取 enabled、配对状态、credential 和 active epoch；任一不满足时不 PUT。

断开配对：

- 先进入 disconnected_pending_revoke 并本地 suppression；
- 在 Keystore 保护的 cleanup state 中保留完成 push DELETE 和 device revoke 所需的 Dwell credential；
- 只有 revoke 返回 2xx/404 后才永久删除 credential；
- 离线时 UI 仍显示已断开，但后台可继续安全清理。

用户明确 force-stop 后，Android 不投递 FCM，直到再次手动打开 App；该边界写入设置说明和验收记录。

## 11. Firebase 构建与凭据

### 11.1 双模式构建

根 Gradle 以固定版本声明 Google Services plugin。构建显式选择：

```text
-PdwellFcmMode=disabled
-PdwellFcmMode=enabled
```

Disabled：

- 不需要 `google-services.json`；
- Firebase Messaging 代码可以编译；
- App 运行时显示 FCM unavailable；
- SSE/REST WorkManager 正常；
- Debug 和 Release 均必须构建成功。

Enabled：

- 配置阶段缺少目标 variant `google-services.json` 时失败；
- 验证存在 `com.xinwithyu.dwell` Android client；
- 验证预期 Firebase app ID；
- 应用 Google Services plugin；
- Manifest 声明 `.notification.DwellFirebaseMessagingService`、`android:exported="false"` 和 `com.google.firebase.MESSAGING_EVENT` filter；
- 请求 enabled 但配置错误时停止发布，不能静默降级。

Release workflow 显式选择模式。FCM release 在 Gradle 前注入受保护配置，结束后无条件清理；artifact metadata 记录模式、package name 和非敏感 app ID。

`.gitignore` 增加 app/variant `google-services.json` 和后端 service-account 文件模式。

### 11.2 Mac 凭据

- 使用官方 Firebase Admin SDK；
- ADC 文件位于仓库、workspace 和所有 Claude `--add-dir` 之外；
- 文件权限 `0600`，父目录 `0700`；
- LaunchAgent 只保存路径、启用开关和非敏感 project/app ID；
- Android client 与 Admin project 必须匹配；
- 自动测试强制禁用真实发送并注入 fake sender；
- 不能把 Admin JSON、FCM Token 或完整 plist 打印到验证输出。

## 12. `Claude Cli` 改名

用户可见品牌精确为：

```text
Claude Cli
```

保持不变：

- `com.xinwithyu.dwell`；
- Kotlin package；
- 数据库、DataStore、Keystore 标识；
- `DwellDevice`；
- WorkManager unique names；
- channel ID `dwell-messages-v2`；
- 后端服务名、API 路径和数据目录。

统一用户可见位置：

- launcher/application label；
- 配对页产品标题；
- Drawer 产品标题；
- notification channel 名称和说明；
- generic notification title；
- 权限、崩溃恢复和 Legacy 安全模式文案；
- 本地来源使用中性“手机会话”。

不改写 `Claude 正在回复`、`Claude Code CLI` provider、Claude Desktop 任务来源或运行时模型，这些不是 App 品牌。

## 13. 暗色模式与无障碍

### 13.1 Compose 根修复

在主题根增加全屏 Material `Surface`：

```text
color = MaterialTheme.colorScheme.background
contentColor = MaterialTheme.colorScheme.onBackground
```

自定义 surface 如果前景语义不同，使用 Material `Surface` 或显式 content color，不假设 `Modifier.background()` 会改变前景。

### 13.2 原生启动主题

- 为同名 `AppTheme` 增加 `values-night/themes.xml`，或使用真实 DayNight launch theme；
- 删除或替换不会自动选择的 `AppThemeDark`；
- 验证冷启动背景、系统 action mode、第一帧和 Android 15 edge-to-edge 图标明暗；
- Compose 启动后按 DataStore 覆盖，启动窗口以系统 night resource 为首帧安全默认。

### 13.3 语义色和对比度

增加 light/dark：

- success foreground/background；
- inline-code foreground/background；
- selected chip；
- disabled content。

替换固定 Gray、固定成功绿和以品牌橙承担普通小字号文本的用法。

- 普通文字至少 4.5:1；
- 大字、重要图标和边界至少 3:1；
- 颜色不是状态唯一表达。

### 13.4 Legacy WebView

- Android 解析后的 dark boolean 传入 `LegacyFeatureScreen`；
- 首次绘制前设置有效 `data-theme`；
- Android 宿主内不允许 Legacy localStorage 覆盖原生主题；
- 直接读取 `prefers-color-scheme` 的路径改用 effective theme；
- WebView 使用与当前主题一致的不透明背景。

### 13.5 无障碍

- 所有交互 hit region 至少 48dp；
- `BasicTextField` 有明确标签；
- 模型、反馈、通知开关有 selected/toggle semantics；
- 任务状态同时有文字或语义；
- Row 与 Switch 不产生冲突 TalkBack action；
- 验证 1.3×、2.0× font scale、TalkBack 和系统高对比度文本。

## 14. Luna 模型可观测性和切换

### 14.1 统一模型 API

规范端点唯一为：

```text
GET /api/v2/model
```

Bootstrap 内嵌相同主模型视图。不存在 `/api/v2/model.runtime`。

字段：

```text
provider_mode: claude_cli | direct_api
route_kind: custom_gateway | anthropic_oauth |
            direct_anthropic | openai_compatible | other
requested_model
cli_init_model
observed_runtime_model
runtime_source: assistant.message.model |
                provider_response.model | null
runtime_verified_at
route_status: unverified | verified | mismatch | error
current_attempt_id
current_attempt_status
last_verified_model
last_verified_at
last_error
```

当前生产目标为：

```text
provider_mode=claude_cli
route_kind=custom_gateway
requested_model=claude-opus-5
```

每次主聊天创建唯一 attempt ID，置 unverified 并清空本轮 init/observed/timestamp。状态更新必须同时匹配当前 attempt 和 route fingerprint，旧异步事件不得覆盖新状态。

Claude CLI 只有在进程关闭后且同时满足以下条件才 verified：

1. 收到原始 result，`is_error===false`；
2. exit code 0，无 spawn error；
3. 未 stopped、timed out 或 superseded；
4. 至少一个非空、非 `<synthetic>` assistant model；
5. 本轮所有非 synthetic model 唯一；
6. init model 与 requested alias 匹配；
7. observed model 与批准 route bundle 匹配。

`result.subtype` 不参与成功判定。缺少模型元数据保持 unverified；init/observed/多模型不一致为 mismatch；停止、超时、失败或异常退出为 error。

`last_verified_*` 可保留历史事实，但当前 attempt 失败后不得作为“实际模型”显示。Direct API 的 observed model 只能来自成功 provider response 元数据。

v0.6.x 兼容字段：

- `model=requested_model`；
- 仅 route_status=verified 时 `runtime=observed_runtime_model`，否则 `runtime=""`。

新 APK 连接旧后端时，可把旧 model 当请求别名，但必须把 actual 标为 unverified。

Android 始终分别显示：

- 请求模型：`claude-opus-5`；
- 实际模型：验证前“尚未验证”；
- verified 后：`gpt-5.6-luna`；
- mismatch/error：“路由异常”。

### 14.2 执行路径隔离

模型状态按 execution path 独立持久化：

```text
main_chat | gong | news | desktop_task
```

主模型 API 只序列化 main_chat。Token/成本可以聚合，但 usage counter 不得成为 route 事实源。

任务状态按 `(task_id,executor)`：

```text
claude_desktop_scheduler
dwell_host_direct
dwell_claude_cli_bridge
```

`dwell_host_direct` 不调用模型时，`model_status=not_applicable`。辅助/任务状态值域：

```text
verified | unverified | unavailable | not_applicable
```

任务 API 返回 executor、model_status 和脱敏 model_error_code。

### 14.3 Route fingerprint 与专用配置

Route fingerprint 对固定键顺序 canonical JSON 做 SHA-256，输入固定包括：

```text
provider_mode
route_kind
requested_model
realpath(CLAUDE_BIN)
CLI version 或 executable hash
专用 CLI config root/settings 的非敏感 generation
规范化 endpoint scheme/host/port/path
gateway alias-map/config generation
fallback enabled 和非敏感模型配置
```

Endpoint 删除 userinfo、query 和 fragment。Fingerprint 不包含 Token、Authorization、完整 settings/plist 或凭据。

Fingerprint 改变时：

- 清空全局 resume ID；
- 清空全部 chat `resumeSessionId`；
- 清空当前模型验证状态；
- 保留 `sourceSessionId`；
- CLI 和 direct API 产生不同 fingerprint。

Luna canary 前必须建立权限 `0700` 的 Dwell 专用 Claude CLI config root；settings/credential 文件 `0600`。Canary 与生产 LaunchAgent 显式使用同一配置身份。`DWELL_CLAUDE_PROFILE` 不是 CLI 配置隔离变量，不能代替该门禁。

### 14.4 Gong、news 与任务

固定使用：

```text
DWELL_GONG_MODEL
DWELL_NEWS_MODEL
```

不再硬编码或 fallback 到 `haiku`。主 route canary 通过后，部署工具显式把批准 requested alias 写入各自进程环境，不能假设独立 news LaunchAgent 继承后端环境。

- Gong 变量缺失返回 `model_unavailable`；
- News 可以输出无模型 RSS 摘要，但 rewrite 状态为 unavailable；
- 修改 Gong fingerprint 时清空 `gongSessionId`；
- News 使用无 session persistence；
- Gong/news 只有使用 stream-json 或共享可观测 runner，并满足与主聊天相同判定，才能标为 verified；普通 text/json completion 只能 unverified；
- 任务按实际 executor 验证，不跨执行器推断。

### 14.5 Luna canary gate

并行后端使用独立端口、临时数据、临时认证、disposable workspace、生产相同 Claude executable、专用 config identity 和 route generation。

硬门禁：

- 窗口至少 30 分钟；
- 10 个独立 fresh chat，10/10 final success；
- 10/10 init alias=`claude-opus-5`；
- 10/10 observed model 唯一且=`gpt-5.6-luna`；
- 至少一项在 canary 后端重启后完成；
- disposable workspace 预置只读 fixture `DWELL_CANARY_READ_OK`；模型通过读取工具返回精确内容，workspace mtime/size/hash 不变；
- Gong 和 news 各完成一次独立 canary；
- 每个允许测试任务按实际 executor 得到 verified、unavailable 或 not_applicable；
- stop、timeout、CLI error 和 synthetic-only 各注入一次，均不得留下当前 verified；
- 0 mismatch、0 未脱敏 stderr/secret 暴露、0 后端崩溃。

任一失败即 NO-GO，切换当天不得降低阈值。

### 14.6 生产 LaunchAgent 切换

1. 确认后端 idle；
2. `umask 077`，在正式 plist 同目录创建 `0600` 备份和临时副本；
3. 只修改临时副本中的主模型、Gong 模型和专用 CLI config identity；
4. 对临时副本执行 `plutil -lint`；失败则删除临时副本，正式 plist、进程和 launchd job 不变；
5. lint 成功后用同文件系统 atomic rename 替换正式 plist；
6. 使用 `bootout` + `bootstrap` reload；
7. 只输出允许公开的模型键、新 PID、health、provider mode、route kind 和脱敏状态；
8. fresh chat 满足完整 verified 判定后才显示实际上游；
9. 完成量化观察窗口后结束切换。

### 14.7 生产 Luna 前置决策

必须满足二者之一：

A. 已验证并可恢复的独立 route bundle；或  
B. 用户在本次发布记录中明确批准 `fail_closed_only`，并已有 runbook 能停止模型入口、显示“模型服务不可用”、恢复配置并重新 fresh-session 验证。

A、B 均未满足时，生产 Luna 切换为 NO-GO。

当前状态是 `fail_closed_only`，但用户尚未针对该风险单独授权。批准本设计文档本身不等同于批准生产 fail-closed 切换。

## 15. 设置页状态

“实时 FCM”改为运行时诊断：

- 未开启手机通知；
- 等待通知 baseline；
- 系统权限阻止；
- APK 是 FCM disabled 模式；
- 正在获取 Token；
- Token 待上传；
- 手机已注册、Mac sender 未启用；
- Firebase app/project 不匹配；
- Token quarantine；
- FCM 已连接；
- 最近成功时间；
- 脱敏错误码。

“后台补偿 / WorkManager”保持独立一行。

测试通知按钮不是首个增量版本完成条件；真实聊天完成通知是端到端验收路径。

## 16. 测试和发布门禁

### 16.1 后端

覆盖：

- fresh v2；
- v1→v2、online backup、integrity check、reopen 和数据保持；
- 未 checkpoint WAL、held reader、checkpoint busy 时中止；
- DDL 故障回滚；
- unknown newer schema 无写入拒绝；
- notification epoch 创建和备份恢复轮换；
- app_state notifications 移除、taskSeen observation 保持；
- 历史 duplicate event key 去重；
- assistant completion/message/notification/delivery 原子事务；
- 停止/失败 turn 不通知；
- 停机期间超过 120 个 task run 完整补录；
- task 终态映射；
- oldest-first pagination 和旧接口兼容；
- outbox fencing、lease recovery、retry、TTL、expired 无网络调用；
- sender disabled 无历史补发；
- Token A claim 后轮换 B 的 success/permanent/transient 并发结果；
- soft revoke、rebind、quarantine、project mismatch；
- 未配置 Firebase 正常启动；
- fake sender 精确 payload；
- 子进程环境不包含 Firebase Admin 变量；
- fake Claude executable、attempt、runtime model、fingerprint 和 execution-path 隔离；
- 更新 stale smoke version assertions。

```bash
cd backend
npm run check
npm test
```

### 16.2 Android 自动化

Disabled：

```bash
cd android
./gradlew testDebugUnitTest lintDebug assembleDebug assembleRelease \
  -PdwellFcmMode=disabled --console=plain
```

Enabled fixture：

```bash
./gradlew connectedDebugAndroidTest \
  -PdwellFcmMode=enabled --console=plain
```

API 31、33、35 instrumentation 覆盖：

- 冷/热启动 chat 和 task route；
- malformed route；
- FCM/SSE/REST 同 scope 只展示一次；
- receipt crash window 和 presentation lease；
- epoch 轮换；
- 权限允许、拒绝、外部撤销；
- disabled/suppressed 不补响；
- FirebaseApp 初始化；
- OS/App 交叉主题；
- launcher label 和品牌文案；
- 旧聊天数据库升级/降级兼容。

### 16.3 真机

Samsung S25+：

- 前台 SSE；
- 后台 FCM；
- App 划走/系统回收；
- force-stop 不投递、重开恢复；
- 三路同通知只响一次；
- 人为丢弃 FCM 后 REST/Worker 补回；
- chat/task 深链；
- Token 刷新、开关、权限外部撤销；
- reboot、5G + Cloudflare；
- 暗色 Chat、Model、Settings、Tasks、Input、Dialog、Legacy；
- 请求模型始终显示 `claude-opus-5`；实际模型验证前“尚未验证”，verified 后显示 `gpt-5.6-luna`。

TalkBack、1.3×/2.0× 字体、App light/dark 各执行一次。证据保存：

```text
dist/acceptance/v0.6.1/android/<test-id>/
```

### 16.4 FCM 扩展 gate

- 只启用一个 canary 配对设备；
- 连续至少 24 小时；
- 至少 20 条真实聊天/任务通知；
- 0 重复响铃；
- 0 错误深链；
- 0 永久 Token 误删；
- 人为丢弃至少一条 FCM 后，REST/Worker 补回且只展示一次；
- sender disabled → enabled 无历史积压补发。

全部满足后才扩展其他设备。

### 16.5 凭据安全门禁

每次测试动态生成唯一 sentinel：

- FCM Token；
- fake ADC key fragment；
- DwellDevice Authorization。

断言原始字节不出现在：

- API 响应；
- stdout/stderr 和结构化日志；
- 测试报告；
- Debug/Release APK；
- Git tracked files。

扫描命中数必须为 0。完成记录只表述：“本次 sentinel 测试及 tracked-files/APK 扫描未发现凭据泄露。”不声称证明未知历史凭据从未泄露。

## 17. 滚动升级兼容矩阵

| 组合 | 支持状态与要求 |
| --- | --- |
| 新后端 + v0.6.0 APK | 保留聊天、SSE 和 legacy poll；旧 Worker 仍是 best-effort。`DWELL_FCM_ENABLED=0`，不得宣称 FCM 完成 |
| 新 APK + 旧后端 | Push API 404 显示 `backend_unsupported`，不破坏配对/SSE/legacy poll；旧 runtime 不视为真实模型 |
| 新后端 + 新 APK | 独立 inbox、epoch、order=asc、配置构建和去重测试通过后完整支持 |
| 关闭 FCM 后回滚旧 APK | 先停止 dispatcher，取消 nonterminal delivery，确认无在途发送；后端 v2 保持 |
| 后端二进制回滚 v1 | 必须同时恢复一致 v1 备份，禁止只回滚二进制 |

## 18. 上线顺序

### 阶段 A：基础代码

- schema migration framework；
- notification epoch；
- durable notification、task observation 和 outbox；
- 旧 API 兼容 + 新 order=asc；
- 模型 API、attempt、execution path 和 fingerprint；
- Android 独立 inbox、改名和主题；
- 默认 FCM sender 关闭。

### 阶段 B：后端迁移

- drain；
- WAL-aware online backup；
- integrity check；
- transactional v1→v2；
- 验证 chats、messages、devices、notifications、task observations；
- sender 保持关闭。

### 阶段 C：Android 双模式

- disabled 构建和旧后端降级通过；
- enabled 配置版 canary APK；
- 新后端 + 新 APK 验证 baseline、epoch、inbox 和 pagination；
- sender 仍关闭。

### 阶段 D：FCM 激活

- 同一 Firebase 项目的 client 与 Admin 配置；
- 单设备启用；
- 24 小时/20 通知 gate；
- 通过后扩展。

### 阶段 E：Luna

- 建立专用 CLI config root；
- 并行 canary；
- 满足 Luna gate；
- 满足独立回滚 A，或由用户明确批准 fail-closed B；
- 临时 plist lint → atomic replace → launchd reload；
- fresh production chat 验证。

## 19. 回滚

### 19.1 FCM

- 设置 `DWELL_FCM_ENABLED=0`；
- 停止 claim；
- nonterminal delivery → cancelled；
- 不回填历史；
- SSE/REST WorkManager 保持；
- 回滚旧 APK 前确认无在途发送。

### 19.2 后端数据库

- 停止服务；
- v1 binary 和一致 v1 backup 作为整体恢复；
- 恢复后轮换 notification epoch；
- 明确恢复点后产生的 v2-only 数据会丢失。

### 19.3 模型

独立 route bundle 必须固定或可恢复：

- Claude executable realpath/version；
- LaunchAgent 模型变量；
- 专用 CLI config generation；
- endpoint identity；
- gateway alias-map generation；
- fallback 配置；
- provider/route/model。

恢复后 fingerprint 变化清空 resume 和当前验证状态，fresh chat 重新验证。验证前隐藏实际模型。

当前没有独立回滚 bundle；未经用户明确批准 `fail_closed_only`，生产 Luna 不切换。Fail closed 表示停止模型入口并显示“模型服务不可用”，而不是尝试未经验证的模型。

### 19.4 主题和品牌

- 资源改名可独立回滚；
- 包名不变，不影响安装与数据；
- 根 Surface、night theme 和 WebView theme 可独立回滚，不影响后端数据。

## 20. 外部前置条件

1. Firebase Android App，包名 `com.xinwithyu.dwell`；
2. 对应真实 `google-services.json`；
3. 启用 FCM API 的 Firebase/Google Cloud 项目；
4. 最小权限 Firebase Admin 身份和仓库外 ADC 路径；
5. Android client、Admin project 和预期 app ID 匹配；
6. 可注入未提交配置的正式签名构建流程；
7. Samsung S25+ 和 API 31/33/35 设备或 emulator；
8. 权限受限的 Dwell 专用 Claude CLI config root；
9. 独立模型回滚 route bundle，或用户针对本次发布明确批准 `fail_closed_only`；
10. 对 unsupported 任务模型按实际 executor 标记 unavailable/not_applicable 的结果。

这些是发布阻塞条件，不是文档占位符。没有 Firebase 1–5 时可以完成代码和 fake sender 测试，但不能激活真实 FCM。没有第 9 项的任一分支时不能切换生产 Luna。

## 21. 完成定义

只有同时满足以下条件才完成：

1. WAL-aware v1→v2 迁移、备份、完整性验证、故障回滚和数据保持通过；
2. notification epoch、durable event、task observation 和 outbox 成为唯一事实源；
3. `app_state.payload` 不再含 notifications；
4. 聊天成功提交与 notification 创建原子化；
5. 任务 oldest-first 增量扫描不受最新 N 条上限影响；
6. Android FCM/SSE/REST 进入独立 persistent inbox，崩溃后不永久漏通知且三路只提醒一次；
7. REST oldest-first pagination 不丢积压，旧 APK 默认行为保持兼容；
8. 无 Firebase 配置的 disabled APK 可构建并正常使用 SSE/REST；
9. enabled APK 配置缺失或不匹配时构建失败；
10. 真实 Firebase canary 通过 24 小时/20 通知 gate；
11. launcher 和主要品牌为 `Claude Cli`，包名仍为 `com.xinwithyu.dwell`；
12. 暗色主要文字、图标、输入框、Dialog、Model、Tasks 和 Legacy 页面可读且满足对比度；
13. 模型 API 区分 executor、route、requested、current attempt 和 actually observed model；
14. 10/10 Luna canary 请求通过完整 verified 判定；
15. 实际模型只在 verified 后显示 `gpt-5.6-luna`；
16. 生产 Luna 只有满足独立回滚或用户明确批准 `fail_closed_only` 后才能切换；
17. Backend check/test、Android unit/Lint/build、API 31/33/35 instrumentation 全部通过；
18. Samsung S25+ 完成通知、深链、5G/Cloudflare、主题、权限和模型验收；
19. 本次 sentinel 与 tracked-files/APK 扫描未发现凭据泄露；
20. `night/` 和其他未跟踪用户文件未被修改或提交。
