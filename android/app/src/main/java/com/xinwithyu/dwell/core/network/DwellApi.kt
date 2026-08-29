package com.xinwithyu.dwell.core.network

import com.xinwithyu.dwell.core.model.ActionResponse
import com.xinwithyu.dwell.core.model.BootstrapResponse
import com.xinwithyu.dwell.core.model.ChatsResponse
import com.xinwithyu.dwell.core.model.MessagePage
import com.xinwithyu.dwell.core.model.ModelView
import com.xinwithyu.dwell.core.model.NotificationBaselineResponse
import com.xinwithyu.dwell.core.model.NotificationResponse
import com.xinwithyu.dwell.core.model.PairResponse
import com.xinwithyu.dwell.core.model.PushStatusResponse
import com.xinwithyu.dwell.core.model.PushTokenResponse
import com.xinwithyu.dwell.core.model.SseEnvelope
import com.xinwithyu.dwell.core.model.TaskDetailResponse
import com.xinwithyu.dwell.core.model.TaskListResponse
import com.xinwithyu.dwell.core.model.TaskRunResponse
import java.io.IOException
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.serializer
import okhttp3.Call
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

class ApiException(val status: Int, message: String) : IOException(message)

class DwellApi {
    val json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
        encodeDefaults = true
    }
    private val client = OkHttpClient.Builder()
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(25, TimeUnit.SECONDS)
        .writeTimeout(25, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()
    private val streamClient = client.newBuilder().readTimeout(0, TimeUnit.MILLISECONDS).build()
    private val probeClient = client.newBuilder()
        .connectTimeout(900, TimeUnit.MILLISECONDS)
        .readTimeout(900, TimeUnit.MILLISECONDS)
        .callTimeout(1_200, TimeUnit.MILLISECONDS)
        .build()

    suspend fun health(baseUrl: String): Boolean {
        val request = requestBuilder(baseUrl, "", "/api/v2/health").get().build()
        return kotlinx.coroutines.withContext(Dispatchers.IO) {
            probeClient.newCall(request).execute().use { it.isSuccessful }
        }
    }

    suspend fun pair(baseUrl: String, code: String, name: String): PairResponse = post(
        baseUrl, "", "/api/v2/pair", buildJsonObject { put("code", code); put("name", name) }, PairResponse.serializer(),
    )

    suspend fun bootstrap(baseUrl: String, token: String): BootstrapResponse = get(
        baseUrl, token, "/api/v2/bootstrap", BootstrapResponse.serializer(),
    )

    suspend fun chats(baseUrl: String, token: String): ChatsResponse = get(
        baseUrl, token, "/api/v2/chats", ChatsResponse.serializer(),
    )

    suspend fun messages(baseUrl: String, token: String, chatId: String, before: Long = 0): MessagePage = get(
        baseUrl, token, "/api/v2/chats/${encode(chatId)}/messages?limit=240${if (before > 0) "&before=$before" else ""}", MessagePage.serializer(),
    )

    suspend fun activateChat(baseUrl: String, token: String, chatId: String): JsonObject = post(
        baseUrl, token, "/api/v2/chats/${encode(chatId)}/activate", JsonObject(emptyMap()), JsonObject.serializer(),
    )

    suspend fun newChat(baseUrl: String, token: String, mutationId: String): ActionResponse = post(
        baseUrl, token, "/api/v2/chats/new", buildJsonObject { put("mutation_id", mutationId) }, ActionResponse.serializer(),
    )

    suspend fun sendMessage(
        baseUrl: String,
        token: String,
        text: String,
        webSearch: Boolean,
        mutationId: String,
        attachments: JsonArray = JsonArray(emptyList()),
    ): ActionResponse = post(
        baseUrl, token, "/api/v2/chat/send",
        buildJsonObject {
            put("text", text)
            put("web_search", webSearch)
            put("mutation_id", mutationId)
            put("attachments", attachments)
        },
        ActionResponse.serializer(),
    )

    suspend fun stop(baseUrl: String, token: String): ActionResponse = post(
        baseUrl, token, "/api/v2/chat/stop", JsonObject(emptyMap()), ActionResponse.serializer(),
    )

    suspend fun regenerate(baseUrl: String, token: String, messageId: Long, mutationId: String): ActionResponse = post(
        baseUrl, token, "/api/v2/chat/regenerate",
        buildJsonObject { put("message_id", messageId); put("mutation_id", mutationId) }, ActionResponse.serializer(),
    )

    suspend fun feedback(baseUrl: String, token: String, messageId: Long, value: String): JsonObject = post(
        baseUrl, token, "/api/v2/message-feedback",
        buildJsonObject { put("message_id", messageId); put("value", value) }, JsonObject.serializer(),
    )

    suspend fun chatAction(baseUrl: String, token: String, chatId: String, action: String, name: String = ""): ChatsResponse = post(
        baseUrl, token, "/api/v2/chats/${encode(chatId)}",
        buildJsonObject { put("action", action); if (name.isNotBlank()) put("name", name) }, ChatsResponse.serializer(),
    )

    suspend fun model(baseUrl: String, token: String): ModelView = get(
        baseUrl, token, "/api/v2/model", ModelView.serializer(),
    )

    suspend fun selectModel(baseUrl: String, token: String, model: String, effort: String): ModelView = post(
        baseUrl, token, "/api/v2/model", buildJsonObject { put("model", model); put("effort", effort) }, ModelView.serializer(),
    )

    suspend fun tasks(baseUrl: String, token: String): TaskListResponse = get(
        baseUrl, token, "/api/v2/tasks", TaskListResponse.serializer(),
    )

    suspend fun task(baseUrl: String, token: String, taskId: String): TaskDetailResponse = get(
        baseUrl, token, "/api/v2/tasks/${encode(taskId)}", TaskDetailResponse.serializer(),
    )

    suspend fun taskRun(baseUrl: String, token: String, taskId: String, runId: String): TaskRunResponse = get(
        baseUrl, token, "/api/v2/tasks/${encode(taskId)}/runs/${encode(runId)}", TaskRunResponse.serializer(),
    )

    suspend fun taskAction(baseUrl: String, token: String, taskId: String, action: String): JsonObject = post(
        baseUrl, token, "/api/v2/tasks/${encode(taskId)}/actions/${encode(action)}", JsonObject(emptyMap()), JsonObject.serializer(),
    )

    suspend fun notifications(baseUrl: String, token: String, since: Long, limit: Int = 100): NotificationResponse = get(
        baseUrl,
        token,
        "/api/v2/notifications?since=${since.coerceAtLeast(0)}&limit=${limit.coerceIn(1, 100)}&order=asc",
        NotificationResponse.serializer(),
    )

    suspend fun notificationBaseline(baseUrl: String, token: String): NotificationBaselineResponse = get(
        baseUrl, token, "/api/v2/notifications/baseline", NotificationBaselineResponse.serializer(),
    )

    suspend fun registerPushToken(
        baseUrl: String,
        token: String,
        fcmToken: String,
        appVersion: String,
        firebaseAppId: String,
    ): PushTokenResponse = put(
        baseUrl,
        token,
        "/api/v2/devices/me/push-token",
        buildJsonObject {
            put("provider", "fcm")
            put("token", fcmToken)
            put("package_name", "com.xinwithyu.dwell")
            put("app_version", appVersion)
            put("firebase_app_id", firebaseAppId)
        },
        PushTokenResponse.serializer(),
    )

    suspend fun unregisterPushToken(baseUrl: String, token: String): PushTokenResponse = delete(
        baseUrl, token, "/api/v2/devices/me/push-token", PushTokenResponse.serializer(),
    )

    suspend fun pushStatus(baseUrl: String, token: String): PushStatusResponse = get(
        baseUrl, token, "/api/v2/devices/me/push-status", PushStatusResponse.serializer(),
    )

    fun events(baseUrl: String, token: String, since: Long): Flow<SseEnvelope> = callbackFlow {
        val request = requestBuilder(baseUrl, token, "/api/v2/events?since=$since")
            .header("Accept", "text/event-stream")
            .apply { if (since > 0) header("Last-Event-ID", since.toString()) }
            .build()
        val call: Call = streamClient.newCall(request)
        val job = launch(Dispatchers.IO) {
            try {
                call.execute().use { response ->
                    if (!response.isSuccessful) throw ApiException(response.code, response.body?.string().orEmpty())
                    val source = response.body?.source() ?: throw IOException("SSE response body is empty")
                    var data = StringBuilder()
                    while (!source.exhausted()) {
                        val line = source.readUtf8Line() ?: break
                        if (line.isEmpty()) {
                            if (data.isNotEmpty()) {
                                val value = data.toString().trimEnd('\n')
                                runCatching { json.decodeFromString(SseEnvelope.serializer(), value) }
                                    .onSuccess { trySend(it) }
                                data = StringBuilder()
                            }
                        } else if (line.startsWith("data:")) {
                            data.append(line.removePrefix("data:").trimStart()).append('\n')
                        }
                    }
                }
                close()
            } catch (error: Throwable) {
                if (!call.isCanceled()) close(error)
            }
        }
        awaitClose { call.cancel(); job.cancel() }
    }

    private suspend fun <T> get(baseUrl: String, token: String, path: String, serializer: KSerializer<T>): T {
        val request = requestBuilder(baseUrl, token, path).get().build()
        return execute(request, serializer)
    }

    private suspend fun <T> post(
        baseUrl: String,
        token: String,
        path: String,
        body: JsonObject,
        serializer: KSerializer<T>,
    ): T {
        val raw = json.encodeToString(JsonObject.serializer(), body)
        val request = requestBuilder(baseUrl, token, path)
            .post(raw.toRequestBody("application/json; charset=utf-8".toMediaType()))
            .build()
        return execute(request, serializer)
    }

    private suspend fun <T> put(
        baseUrl: String,
        token: String,
        path: String,
        body: JsonObject,
        serializer: KSerializer<T>,
    ): T {
        val raw = json.encodeToString(JsonObject.serializer(), body)
        val request = requestBuilder(baseUrl, token, path)
            .put(raw.toRequestBody("application/json; charset=utf-8".toMediaType()))
            .build()
        return execute(request, serializer)
    }

    private suspend fun <T> delete(
        baseUrl: String,
        token: String,
        path: String,
        serializer: KSerializer<T>,
    ): T {
        val request = requestBuilder(baseUrl, token, path).delete().build()
        return execute(request, serializer)
    }

    private suspend fun <T> execute(request: Request, serializer: KSerializer<T>): T = kotlinx.coroutines.withContext(Dispatchers.IO) {
        client.newCall(request).execute().use { response ->
            val raw = response.body?.string().orEmpty()
            if (!response.isSuccessful) {
                val detail = runCatching {
                    val objectValue = json.parseToJsonElement(raw) as? JsonObject
                    (objectValue?.get("detail") as? JsonPrimitive)?.content
                        ?: (objectValue?.get("error") as? JsonPrimitive)?.content
                }.getOrNull().orEmpty()
                throw ApiException(response.code, detail.ifBlank { "HTTP ${response.code}" })
            }
            json.decodeFromString(serializer, raw)
        }
    }

    private fun requestBuilder(baseUrl: String, token: String, path: String): Request.Builder {
        require(baseUrl.startsWith("http://") || baseUrl.startsWith("https://")) { "接口地址必须以 http:// 或 https:// 开头" }
        return Request.Builder()
            .url(baseUrl.trimEnd('/') + path)
            .header("Accept", "application/json")
            .apply { if (token.isNotBlank()) header("Authorization", "DwellDevice $token") }
    }

    private fun encode(value: String): String = URLEncoder.encode(value, StandardCharsets.UTF_8.toString()).replace("+", "%20")
}
