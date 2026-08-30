package com.xinwithyu.dwell.core.time

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

private val taskDisplayFormatter = DateTimeFormatter
    .ofPattern("yyyy-MM-dd HH:mm:ss", Locale.ROOT)
    .withZone(ZoneId.of("Asia/Shanghai"))

private val embeddedIsoTimestamp = Regex(
    """\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z""",
)

fun formatTaskTimestamp(raw: String?): String {
    val instant = raw
        ?.takeIf { it.isNotBlank() }
        ?.let { runCatching { Instant.parse(it) }.getOrNull() }
        ?: return ""

    return taskDisplayFormatter.format(instant)
}

fun formatTaskSchedule(raw: String): String = embeddedIsoTimestamp.replace(raw) { match ->
    formatTaskTimestamp(match.value).ifBlank { match.value }
}
