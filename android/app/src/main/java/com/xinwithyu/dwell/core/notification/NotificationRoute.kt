package com.xinwithyu.dwell.core.notification

import android.net.Uri
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets

sealed interface NotificationRoute {
    val raw: String
    val kind: String

    data class Chat(val chatId: String, override val raw: String) : NotificationRoute {
        override val kind: String = "chat"
    }

    data class Task(val taskId: String, val runId: String, override val raw: String) : NotificationRoute {
        override val kind: String = "task"
    }

    fun navigationRoute(): String = when (this) {
        is Chat -> "chat/${Uri.encode(chatId)}"
        is Task -> "task/${Uri.encode(taskId)}/${Uri.encode(runId)}"
    }
}

object NotificationRouteParser {
    private const val MAX_ROUTE_BYTES = 1024
    private const val MAX_ID_BYTES = 512

    fun parse(raw: String, expectedKind: String = ""): NotificationRoute? {
        if (raw.isBlank() || raw.toByteArray(StandardCharsets.UTF_8).size > MAX_ROUTE_BYTES) return null
        if (raw.startsWith('/') || raw.endsWith('/') || raw.contains("//")) return null
        if (raw.any { it.isISOControl() || it == '?' || it == '#' || it == '\\' }) return null

        val parts = raw.split('/')
        val route = when (parts.size) {
            2 -> {
                if (parts[0] != "chat") return null
                decodeSegment(parts[1])?.let { NotificationRoute.Chat(it, raw) }
            }
            3 -> {
                if (parts[0] != "task") return null
                val taskId = decodeSegment(parts[1]) ?: return null
                val runId = decodeSegment(parts[2]) ?: return null
                NotificationRoute.Task(taskId, runId, raw)
            }
            else -> null
        } ?: return null

        return if (expectedKind.isBlank() || route.kind == expectedKind) route else null
    }

    private fun decodeSegment(raw: String): String? {
        if (raw.isEmpty()) return null
        val bytes = ByteArrayOutputStream(raw.length)
        var index = 0
        while (index < raw.length) {
            val character = raw[index]
            if (character == '%') {
                if (index + 2 >= raw.length) return null
                val high = raw[index + 1].hexDigit() ?: return null
                val low = raw[index + 2].hexDigit() ?: return null
                bytes.write((high shl 4) or low)
                index += 3
            } else {
                if (character.code > 0x7F) return null
                bytes.write(character.code)
                index += 1
            }
        }

        val decoded = runCatching {
            StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(bytes.toByteArray()))
                .toString()
        }.getOrNull() ?: return null

        if (decoded.isBlank() || decoded == "." || decoded == "..") return null
        if (decoded.toByteArray(StandardCharsets.UTF_8).size > MAX_ID_BYTES) return null
        if (decoded.any { it.isISOControl() || it.isWhitespace() || it == '/' || it == '\\' || it == '?' || it == '#' }) return null
        return decoded
    }

    private fun Char.hexDigit(): Int? = when (this) {
        in '0'..'9' -> code - '0'.code
        in 'a'..'f' -> code - 'a'.code + 10
        in 'A'..'F' -> code - 'A'.code + 10
        else -> null
    }
}
