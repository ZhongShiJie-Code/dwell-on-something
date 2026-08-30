package com.xinwithyu.dwell.core.repository

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AssistantResponseFallbackTest {
    @Test
    fun keepsPollingOnlyWhileTheBackendIsBusyAndWithinTheTimeout() {
        assertTrue(shouldPollAssistantResponse(isBusy = true, elapsedMillis = 0))
        assertTrue(
            shouldPollAssistantResponse(
                isBusy = true,
                elapsedMillis = ASSISTANT_RESPONSE_FALLBACK_TIMEOUT_MS - 1,
            ),
        )
        assertFalse(shouldPollAssistantResponse(isBusy = false, elapsedMillis = 0))
        assertFalse(
            shouldPollAssistantResponse(
                isBusy = true,
                elapsedMillis = ASSISTANT_RESPONSE_FALLBACK_TIMEOUT_MS,
            ),
        )
    }

    @Test
    fun backsOffPollingWithoutLeavingTheUserWaitingTooLong() {
        assertEquals(750L, assistantResponsePollDelayMillis(0))
        assertEquals(1_500L, assistantResponsePollDelayMillis(1))
        assertEquals(4_000L, assistantResponsePollDelayMillis(10))
    }
}
