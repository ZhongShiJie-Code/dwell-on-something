package com.xinwithyu.dwell.core.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

@Serializable
data class ChatDto(
    val id: String,
    val name: String = "新会话",
    val preview: String = "",
    val created: Long = 0,
    val last: Long = 0,
    val current: Boolean = false,
    val archived: Boolean = false,
    val source: String = "dwell",
    val sourceLabel: String = "",
    val readOnly: Boolean = false,
)

@Serializable
data class MessageDto(
    val seq: Long,
    val at: Long = 0,
    val chatId: String = "",
    val kind: String = "system",
    val text: String = "",
    val extra: String? = null,
    val feedback: String = "",
    val replyTo: Long? = null,
    val variantOf: Long? = null,
    val version: Int? = null,
)

@Serializable
data class MessagePage(
    val ok: Boolean = true,
    @SerialName("chat_id") val chatId: String = "",
    val items: List<MessageDto> = emptyList(),
    val more: Boolean = false,
    @SerialName("next_before") val nextBefore: Long = 0,
    val upto: Long = 0,
)

@Serializable
data class ModelOption(
    val id: String,
    val name: String,
    val desc: String = "",
)

@Serializable
data class ModelView(
    val ok: Boolean = true,
    val model: String = "default",
    val runtime: String = "",
    val effort: String = "high",
    val efforts: List<String> = emptyList(),
    val provider: String = "Claude Code CLI",
    val locked: Boolean = false,
    val supportsEffort: Boolean = true,
    val items: List<ModelOption> = emptyList(),
    val resolved: String = "",
    @SerialName("requested_model") val requestedModel: String = "",
    @SerialName("pre_verification_model") val preVerificationModel: String = "",
    @SerialName("observed_runtime_model") val observedRuntimeModel: String = "",
    @SerialName("route_status") val routeStatus: String = "",
    @SerialName("verification_status") val verificationStatus: String = "",
)

@Serializable
data class BackendStatus(
    val busy: Boolean = false,
    val armed: Boolean = false,
    @SerialName("active_chat_id") val activeChatId: String = "",
    val workspace: String = "",
    val claude: String = "",
)

@Serializable
data class Capabilities(
    val sse: Boolean = true,
    val pairing: Boolean = true,
    val tasks: Boolean = true,
    val voice: String = "android-native",
    val notifications: String = "workmanager",
    val fcm: Boolean = false,
)

@Serializable
data class BootstrapResponse(
    val ok: Boolean,
    val version: String = "",
    @SerialName("server_time") val serverTime: Long = 0,
    @SerialName("device_id") val deviceId: String = "",
    @SerialName("notification_epoch") val notificationEpoch: String = "",
    val status: BackendStatus = BackendStatus(),
    val model: ModelView = ModelView(),
    val chats: List<ChatDto> = emptyList(),
    val messages: MessagePage = MessagePage(),
    val capabilities: Capabilities = Capabilities(),
)

@Serializable
data class ChatsResponse(
    val ok: Boolean,
    @SerialName("active_chat_id") val activeChatId: String = "",
    val armed: Boolean = false,
    val items: List<ChatDto> = emptyList(),
)

@Serializable
data class PairResponse(
    val ok: Boolean,
    val token: String = "",
    val device: PairedDevice = PairedDevice(),
)

@Serializable
data class PairedDevice(
    val id: String = "",
    val name: String = "",
    @SerialName("created_at") val createdAt: Long = 0,
)

@Serializable
data class TaskDto(
    val id: String,
    val name: String = "",
    val description: String = "",
    val enabled: Boolean = false,
    val schedule: String = "未设置周期",
    val model: String = "",
    val lastRunAt: String? = null,
    val lastResult: String = "unknown",
    val running: Boolean = false,
    val runSummary: String = "",
)

@Serializable
data class TaskControl(
    val available: Boolean = false,
    val source: String = "",
    val reason: String = "",
)

@Serializable
data class TaskListResponse(
    val ok: Boolean,
    val source: String = "unavailable",
    val control: TaskControl = TaskControl(),
    val items: List<TaskDto> = emptyList(),
)

@Serializable
data class TaskRun(
    val id: String,
    val taskId: String = "",
    val source: String = "",
    val sourceLabel: String = "",
    val startedAt: String? = null,
    val completedAt: String? = null,
    val status: String = "unknown",
    val summary: String = "",
    val steps: List<TaskRunStep> = emptyList(),
    val outputs: List<TaskOutput> = emptyList(),
)

@Serializable
data class TaskRunStep(
    val type: String = "event",
    val title: String = "运行进度",
    val detail: String = "",
    val at: String? = null,
    val status: String = "done",
)

@Serializable
data class TaskOutput(
    val name: String = "",
    val path: String = "",
    val size: Long = 0,
    val updatedAt: String? = null,
)

@Serializable
data class TaskDetailResponse(
    val ok: Boolean,
    val task: TaskDto,
    val control: TaskControl = TaskControl(),
    val runs: List<TaskRun> = emptyList(),
)

@Serializable
data class TaskRunResponse(
    val ok: Boolean,
    val task: TaskDto,
    val run: TaskRun,
)

@Serializable
data class NotificationDto(
    val id: Long = 0,
    val kind: String = "",
    val title: String = "Claude Cli",
    val body: String = "",
    val at: Long = 0,
    val route: String = "",
    @SerialName("notification_epoch") val notificationEpoch: String = "",
    @SerialName("device_id") val deviceId: String = "",
    @SerialName("notification_id") val notificationId: Long = 0,
)

@Serializable
data class NotificationResponse(
    val ok: Boolean,
    @SerialName("notification_epoch") val notificationEpoch: String = "",
    val next: Long = 0,
    val latest: Long = 0,
    @SerialName("has_more") val hasMore: Boolean = false,
    val items: List<NotificationDto> = emptyList(),
)

@Serializable
data class NotificationBaselineResponse(
    val ok: Boolean,
    @SerialName("device_id") val deviceId: String = "",
    @SerialName("notification_epoch") val notificationEpoch: String = "",
    val latest: Long = 0,
)

@Serializable
data class PushSenderStatus(
    val enabled: Boolean = false,
    val configured: Boolean = false,
    val health: String = "unknown",
    @SerialName("project_match") val projectMatch: Boolean = false,
)

@Serializable
data class PushTokenResponse(
    val ok: Boolean = false,
    @SerialName("device_id") val deviceId: String = "",
    val registered: Boolean = false,
    @SerialName("new_binding") val newBinding: Boolean = false,
    val sender: PushSenderStatus = PushSenderStatus(),
    val error: String = "",
)

@Serializable
data class PushStatusResponse(
    val ok: Boolean = false,
    @SerialName("device_id") val deviceId: String = "",
    val registered: Boolean = false,
    val sender: PushSenderStatus = PushSenderStatus(),
    val token: PushTokenStatus? = null,
    val pending: Int = 0,
    val error: String = "",
)

@Serializable
data class PushTokenStatus(
    val updatedAt: Long = 0,
    val lastSuccessAt: Long = 0,
    val lastErrorCode: String = "",
    val lastErrorAt: Long = 0,
    val quarantinedAt: Long = 0,
    val quarantineCode: String = "",
)

@Serializable
data class SseEnvelope(
    val id: Long,
    val at: Long = 0,
    val type: String,
    @SerialName("chat_id") val chatId: String = "",
    val data: JsonObject = JsonObject(emptyMap()),
)

@Serializable
data class ActionResponse(
    val ok: Boolean,
    val error: String = "",
    val detail: String = "",
    val replayed: Boolean = false,
    @SerialName("chat_id") val chatId: String = "",
    val stopped: Boolean = false,
    val version: Int = 0,
)

data class ConnectionConfig(
    val localUrl: String = "http://192.168.1.10:8787",
    val remoteUrl: String = "",
    val useRemote: Boolean = false,
    val deviceToken: String = "",
) {
    val activeUrl: String
        get() = (if (useRemote && remoteUrl.isNotBlank()) remoteUrl else localUrl).trimEnd('/')
}
