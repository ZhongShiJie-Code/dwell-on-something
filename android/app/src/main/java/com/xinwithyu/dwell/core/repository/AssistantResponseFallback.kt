package com.xinwithyu.dwell.core.repository

const val ASSISTANT_RESPONSE_FALLBACK_TIMEOUT_MS = 16 * 60 * 1000L

fun shouldPollAssistantResponse(isBusy: Boolean, elapsedMillis: Long): Boolean =
    isBusy && elapsedMillis < ASSISTANT_RESPONSE_FALLBACK_TIMEOUT_MS

fun assistantResponsePollDelayMillis(failedAttempts: Int): Long =
    (750L * (1L shl failedAttempts.coerceIn(0, 3))).coerceAtMost(4_000L)
