package com.xinwithyu.dwell.core.repository

import android.content.Context
import com.xinwithyu.dwell.core.database.DraftEntity
import com.xinwithyu.dwell.core.database.DwellDatabase
import com.xinwithyu.dwell.core.database.toDto
import com.xinwithyu.dwell.core.database.toEntity
import com.xinwithyu.dwell.core.model.ChatDto
import com.xinwithyu.dwell.core.model.MessageDto
import com.xinwithyu.dwell.core.model.ModelView
import com.xinwithyu.dwell.core.model.NotificationResponse
import com.xinwithyu.dwell.core.model.TaskDetailResponse
import com.xinwithyu.dwell.core.model.TaskListResponse
import com.xinwithyu.dwell.core.model.TaskRunResponse
import com.xinwithyu.dwell.core.network.ApiException
import com.xinwithyu.dwell.core.network.DwellApi
import com.xinwithyu.dwell.core.security.DeviceTokenStore
import com.xinwithyu.dwell.core.settings.AppSettings
import com.xinwithyu.dwell.core.settings.SettingsStore
import com.xinwithyu.dwell.core.settings.ThemeMode
import com.xinwithyu.dwell.worker.DwellNotifier
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject

enum class ConnectionState { NEEDS_PAIRING, CONNECTING, CONNECTED, OFFLINE }

data class RepositoryState(
    val connection: ConnectionState = ConnectionState.CONNECTING,
    val endpoint: String = "",
    val backendVersion: String = "",
    val activeChatId: String = "__new__",
    val busy: Boolean = false,
    val armed: Boolean = true,
    val model: ModelView = ModelView(),
    val streamingText: String = "",
    val streamingThought: String = "",
    val error: String = "",
)

data class PendingAttachment(val name: String, val payload: JsonObject)

@OptIn(ExperimentalCoroutinesApi::class)
class DwellRepository private constructor(context: Context) {
    private val appContext = context.applicationContext
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val dao = DwellDatabase.get(appContext).dao()
    private val api = DwellApi()
    private val tokenStore = DeviceTokenStore(appContext)
    val settingsStore = SettingsStore(appContext)

    private val _state = MutableStateFlow(RepositoryState())
    val state: StateFlow<RepositoryState> = _state.asStateFlow()
    val settings: StateFlow<AppSettings> = settingsStore.settings.stateIn(
        scope, SharingStarted.Eagerly, AppSettings(),
    )
    val chats: StateFlow<List<ChatDto>> = dao.observeChats().map { rows -> rows.map { it.toDto() } }
        .stateIn(scope, SharingStarted.Eagerly, emptyList())
    val messages: Flow<List<MessageDto>> = _state.map { it.activeChatId }.distinctUntilChanged()
        .flatMapLatest { chatId -> dao.observeMessages(chatId).map { rows -> rows.map { it.toDto() } } }

    private var eventJob: Job? = null
    private var bootstrapJob: Job? = null
    private val started = AtomicBoolean(false)
    private var initialNewChatPrepared = false
    private var lastEventId = 0L
    private val pendingText = StringBuilder()
    private val pendingThought = StringBuilder()
    private val streamLock = Any()

    init {
        scope.launch {
            while (isActive) {
                delay(40)
                flushStreamBuffers()
            }
        }
    }

    fun start(openRoute: String = "") {
        if (started.compareAndSet(false, true)) reconnect(openRoute)
        else if (openRoute.isNotBlank()) openRoute(openRoute)
    }

    fun reconnect(openRoute: String = "") {
        bootstrapJob?.cancel()
        bootstrapJob = scope.launch {
            val token = tokenStore.read()
            if (token.isBlank()) {
                _state.value = _state.value.copy(connection = ConnectionState.NEEDS_PAIRING, error = "")
                return@launch
            }
            _state.value = _state.value.copy(connection = ConnectionState.CONNECTING, error = "")
            runCatching {
                val response = callWithFallback { endpoint -> api.bootstrap(endpoint, token) }
                dao.upsertChats(response.chats.map { it.toEntity() })
                dao.replaceMessages(response.messages.chatId, response.messages.items.map { it.toEntity(response.messages.chatId) })
                _state.value = _state.value.copy(
                    connection = ConnectionState.CONNECTED,
                    backendVersion = response.version,
                    activeChatId = response.status.activeChatId.ifBlank { response.messages.chatId },
                    busy = response.status.busy,
                    armed = response.status.armed,
                    model = response.model,
                    error = "",
                )
                startEvents(token)
                when {
                    openRoute.isNotBlank() -> openRoute(openRoute)
                    !initialNewChatPrepared -> prepareNewChat()
                }
                initialNewChatPrepared = true
            }.onFailure { error ->
                if (error !is CancellationException) {
                    _state.value = _state.value.copy(connection = ConnectionState.OFFLINE, error = friendly(error))
                }
            }
        }
    }

    suspend fun pair(code: String, localUrl: String, remoteUrl: String, preferRemote: Boolean): Result<Unit> = runCatching {
        settingsStore.saveConnection(localUrl, remoteUrl, preferRemote)
        val fresh = settingsStore.settings.first()
        val endpoints = probeEndpoints(fresh)
        var last: Throwable? = null
        for (endpoint in endpoints) {
            try {
                val response = api.pair(endpoint, code, "Samsung S25+")
                if (!response.ok || response.token.isBlank()) throw IllegalStateException("配对没有返回设备令牌")
                tokenStore.write(response.token)
                _state.value = _state.value.copy(endpoint = endpoint, connection = ConnectionState.CONNECTING, error = "")
                initialNewChatPrepared = false
                reconnect()
                return@runCatching
            } catch (error: Throwable) { last = error }
        }
        throw last ?: IllegalStateException("没有可用的后端地址")
    }

    fun disconnect() {
        eventJob?.cancel()
        tokenStore.clear()
        _state.value = RepositoryState(connection = ConnectionState.NEEDS_PAIRING)
    }

    fun deviceTokenForLegacy(): String = tokenStore.read()

    fun prepareNewChat() {
        scope.launch {
            val token = tokenStore.read()
            if (token.isBlank()) return@launch
            runCatching {
                callActive { endpoint -> api.newChat(endpoint, token, mutation()) }
                _state.value = _state.value.copy(activeChatId = "__new__", armed = true, busy = false, streamingText = "", streamingThought = "")
            }.onFailure { setError(it) }
        }
    }

    fun openChat(chatId: String) {
        _state.value = _state.value.copy(activeChatId = chatId, armed = false, error = "")
        scope.launch { dao.selectChat(chatId) }
        scope.launch {
            val token = tokenStore.read()
            runCatching {
                callActive { endpoint -> api.activateChat(endpoint, token, chatId) }
                val page = callActive { endpoint -> api.messages(endpoint, token, chatId) }
                dao.replaceMessages(chatId, page.items.map { it.toEntity(chatId) })
            }.onFailure { setError(it) }
        }
    }

    fun refreshChats() {
        scope.launch {
            val token = tokenStore.read()
            runCatching {
                val response = callActive { endpoint -> api.chats(endpoint, token) }
                dao.upsertChats(response.items.map { it.toEntity() })
            }.onFailure { setError(it) }
        }
    }

    fun send(text: String, webSearch: Boolean, attachments: List<PendingAttachment> = emptyList()) {
        val clean = text.trim()
        if ((clean.isEmpty() && attachments.isEmpty()) || _state.value.busy) return
        scope.launch {
            val token = tokenStore.read()
            _state.value = _state.value.copy(busy = true, streamingText = "", streamingThought = "", error = "")
            runCatching {
                val response = callActive { endpoint ->
                    api.sendMessage(endpoint, token, clean, webSearch, mutation(), JsonArray(attachments.map { it.payload }))
                }
                if (response.chatId.isNotBlank() && response.chatId != _state.value.activeChatId) {
                    _state.value = _state.value.copy(activeChatId = response.chatId, armed = false)
                }
                dao.clearDraft(_state.value.activeChatId)
                refreshActiveMessages()
            }.onFailure {
                _state.value = _state.value.copy(busy = false, error = friendly(it))
            }
        }
    }

    fun stop() {
        scope.launch {
            val token = tokenStore.read()
            runCatching { callActive { endpoint -> api.stop(endpoint, token) } }
                .onFailure { setError(it) }
        }
    }

    fun regenerate(messageId: Long) {
        scope.launch {
            val token = tokenStore.read()
            _state.value = _state.value.copy(busy = true, streamingText = "", streamingThought = "")
            runCatching { callActive { endpoint -> api.regenerate(endpoint, token, messageId, mutation()) } }
                .onFailure { _state.value = _state.value.copy(busy = false, error = friendly(it)) }
        }
    }

    fun feedback(messageId: Long, value: String) {
        scope.launch {
            val token = tokenStore.read()
            dao.setFeedback(messageId, value)
            runCatching { callActive { endpoint -> api.feedback(endpoint, token, messageId, value) } }
                .onFailure {
                    refreshActiveMessages()
                    setError(it)
                }
        }
    }

    fun archiveChat(chatId: String, archived: Boolean) {
        scope.launch {
            val token = tokenStore.read()
            runCatching {
                val response = callActive { endpoint -> api.chatAction(endpoint, token, chatId, if (archived) "archive" else "restore") }
                dao.upsertChats(response.items.map { it.toEntity() })
                if (archived && chatId == _state.value.activeChatId) {
                    _state.value = _state.value.copy(activeChatId = "__new__", armed = true, busy = false, streamingText = "", streamingThought = "")
                }
            }.onFailure { setError(it) }
        }
    }

    fun renameChat(chatId: String, name: String) {
        scope.launch {
            val token = tokenStore.read()
            runCatching {
                val response = callActive { endpoint -> api.chatAction(endpoint, token, chatId, "rename", name) }
                dao.upsertChats(response.items.map { it.toEntity() })
            }.onFailure { setError(it) }
        }
    }

    fun selectModel(model: String, effort: String) {
        scope.launch {
            val token = tokenStore.read()
            runCatching { callActive { endpoint -> api.selectModel(endpoint, token, model, effort) } }
                .onSuccess { _state.value = _state.value.copy(model = it) }
                .onFailure { setError(it) }
        }
    }

    suspend fun loadTasks(): Result<TaskListResponse> = runCatching {
        val token = tokenStore.read()
        callActive { endpoint -> api.tasks(endpoint, token) }
    }

    suspend fun loadTask(taskId: String): Result<TaskDetailResponse> = runCatching {
        val token = tokenStore.read()
        callActive { endpoint -> api.task(endpoint, token, taskId) }
    }

    suspend fun loadTaskRun(taskId: String, runId: String): Result<TaskRunResponse> = runCatching {
        val token = tokenStore.read()
        callActive { endpoint -> api.taskRun(endpoint, token, taskId, runId) }
    }

    suspend fun taskAction(taskId: String, action: String): Result<Unit> = runCatching {
        val token = tokenStore.read()
        callActive { endpoint -> api.taskAction(endpoint, token, taskId, action) }
        Unit
    }

    suspend fun notifications(since: Long): Result<NotificationResponse> = runCatching {
        val token = tokenStore.read()
        callWithFallback { endpoint -> api.notifications(endpoint, token, since) }
    }

    fun observeDraft(chatId: String) = dao.observeDraft(chatId)

    fun saveDraft(chatId: String, text: String) {
        scope.launch { dao.saveDraft(DraftEntity(chatId, text, System.currentTimeMillis())) }
    }

    suspend fun saveConnection(localUrl: String, remoteUrl: String, preferRemote: Boolean) {
        settingsStore.saveConnection(localUrl, remoteUrl, preferRemote)
    }

    suspend fun setTheme(mode: ThemeMode) = settingsStore.setTheme(mode)
    suspend fun setNotifications(enabled: Boolean) = settingsStore.setNotifications(enabled)
    suspend fun setWebSearch(enabled: Boolean) = settingsStore.setWebSearch(enabled)
    fun updateWebSearch(enabled: Boolean) { scope.launch { settingsStore.setWebSearch(enabled) } }

    private fun startEvents(token: String) {
        eventJob?.cancel()
        eventJob = scope.launch {
            var delayMs = 800L
            while (isActive && tokenStore.read().isNotBlank()) {
                val endpoint = _state.value.endpoint
                if (endpoint.isBlank()) break
                try {
                    api.events(endpoint, token, lastEventId).collect { event ->
                        lastEventId = maxOf(lastEventId, event.id)
                        delayMs = 800L
                        when (event.type) {
                            "assistant.delta" -> synchronized(streamLock) { pendingText.append(event.data["text"]?.jsonPrimitive?.content.orEmpty()) }
                            "thought.delta" -> synchronized(streamLock) { pendingThought.append(event.data["text"]?.jsonPrimitive?.content.orEmpty()) }
                            "message.created", "assistant.message", "assistant.completed", "assistant.regenerated", "chat.started", "chat.switched" -> {
                                val eventChatId = event.chatId.ifBlank { _state.value.activeChatId }
                                if (eventChatId.isNotBlank() && eventChatId != "__new__") _state.value = _state.value.copy(activeChatId = eventChatId, armed = false)
                                if (event.type == "assistant.completed") {
                                    syncActiveMessages()
                                    synchronized(streamLock) { pendingText.clear(); pendingThought.clear() }
                                    _state.value = _state.value.copy(busy = false, streamingText = "", streamingThought = "")
                                } else refreshActiveMessages()
                                refreshChats()
                            }
                            "assistant.failed" -> {
                                val detail = event.data["text"]?.jsonPrimitive?.content.orEmpty()
                                _state.value = _state.value.copy(busy = false, error = detail.ifBlank { "回答失败" })
                            }
                            "assistant.stopped" -> _state.value = _state.value.copy(busy = false)
                            "model.changed" -> scope.launch { refreshModel() }
                            "notification.created" -> {
                                val id = event.data["id"]?.jsonPrimitive?.longOrNull ?: event.id
                                val title = event.data["title"]?.jsonPrimitive?.contentOrNull.orEmpty()
                                val body = event.data["body"]?.jsonPrimitive?.contentOrNull.orEmpty()
                                val route = event.data["route"]?.jsonPrimitive?.contentOrNull.orEmpty()
                                if (settings.value.notificationsEnabled) DwellNotifier.show(appContext, title, body, id, route)
                                settingsStore.setNotificationCursor(maxOf(settings.value.notificationCursor, id))
                            }
                            "resync.required" -> reconnect()
                        }
                    }
                } catch (error: Throwable) {
                    if (error is CancellationException) throw error
                    _state.value = _state.value.copy(connection = ConnectionState.OFFLINE, error = friendly(error))
                    delay(delayMs)
                    delayMs = (delayMs * 2).coerceAtMost(12_000L)
                    runCatching { callWithFallback { endpoint -> api.bootstrap(endpoint, token) } }
                        .onSuccess { _state.value = _state.value.copy(connection = ConnectionState.CONNECTED, error = "") }
                }
            }
        }
    }

    private fun refreshActiveMessages() {
        scope.launch {
            runCatching { syncActiveMessages() }
        }
    }

    private suspend fun syncActiveMessages() {
        val chatId = _state.value.activeChatId
        if (chatId.isBlank() || chatId == "__new__") return
        val token = tokenStore.read()
        val page = callActive { endpoint -> api.messages(endpoint, token, chatId) }
        dao.replaceMessages(chatId, page.items.map { it.toEntity(chatId) })
    }

    private suspend fun refreshModel() {
        val token = tokenStore.read()
        runCatching { callActive { endpoint -> api.model(endpoint, token) } }
            .onSuccess { _state.value = _state.value.copy(model = it) }
    }

    private fun flushStreamBuffers() {
        var text = ""
        var thought = ""
        synchronized(streamLock) {
            if (pendingText.isNotEmpty()) { text = pendingText.toString(); pendingText.clear() }
            if (pendingThought.isNotEmpty()) { thought = pendingThought.toString(); pendingThought.clear() }
        }
        if (text.isNotEmpty() || thought.isNotEmpty()) {
            _state.value = _state.value.copy(
                streamingText = _state.value.streamingText + text,
                streamingThought = _state.value.streamingThought + thought,
                busy = true,
            )
        }
    }

    private fun openRoute(route: String) {
        val pieces = route.split('/').filter { it.isNotBlank() }
        if (pieces.firstOrNull() == "chat" && pieces.size >= 2) openChat(pieces[1])
    }

    private suspend fun <T> callActive(block: suspend (String) -> T): T {
        val current = _state.value.endpoint
        if (current.isNotBlank()) {
            try { return block(current) } catch (error: Throwable) {
                if (error is ApiException && error.status in 400..499 && error.status != 408) throw error
            }
        }
        return callWithFallback(block)
    }

    private suspend fun <T> callWithFallback(block: suspend (String) -> T): T {
        val configured = settingsStore.settings.first()
        var last: Throwable? = null
        for (endpoint in probeEndpoints(configured)) {
            try {
                val value = block(endpoint)
                _state.value = _state.value.copy(endpoint = endpoint, connection = ConnectionState.CONNECTED)
                return value
            } catch (error: Throwable) {
                if (error is CancellationException) throw error
                last = error
                if (error is ApiException && error.status in 400..499 && error.status != 408) throw error
            }
        }
        throw last ?: IllegalStateException("请先填写局域网或 Cloudflare 地址")
    }

    private fun endpoints(configured: AppSettings): List<String> {
        val local = configured.localUrl.trim().trimEnd('/')
        val remote = configured.remoteUrl.trim().trimEnd('/')
        return (if (configured.preferRemote) listOf(remote, local) else listOf(local, remote))
            .filter { it.startsWith("http://") || it.startsWith("https://") }
            .distinct()
    }

    private suspend fun probeEndpoints(configured: AppSettings): List<String> = coroutineScope {
        val ordered = endpoints(configured)
        if (ordered.size < 2) return@coroutineScope ordered
        val health = ordered.map { endpoint -> endpoint to async(Dispatchers.IO) { runCatching { api.health(endpoint) }.getOrDefault(false) } }
            .map { (endpoint, result) -> endpoint to result.await() }
            .toMap()
        val healthy = ordered.filter { health[it] == true }
        if (healthy.isEmpty()) ordered else healthy + ordered.filterNot(healthy::contains)
    }

    private fun setError(error: Throwable) {
        _state.value = _state.value.copy(error = friendly(error))
    }

    private fun friendly(error: Throwable): String = when (error) {
        is ApiException -> when (error.status) {
            401 -> "连接令牌失效，请重新配对"
            404 -> "Mac 上没有找到这条记录"
            409 -> "上一条消息还在生成"
            else -> error.message ?: "请求失败"
        }
        else -> error.message?.replace("Failed to connect to", "连接不到") ?: "连接失败"
    }

    private fun mutation(): String = "android:${UUID.randomUUID()}"

    companion object {
        @Volatile private var instance: DwellRepository? = null
        fun get(context: Context): DwellRepository = instance ?: synchronized(this) {
            instance ?: DwellRepository(context).also { instance = it }
        }
    }
}
