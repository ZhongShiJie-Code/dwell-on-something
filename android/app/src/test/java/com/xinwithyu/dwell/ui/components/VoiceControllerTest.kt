package com.xinwithyu.dwell.ui.components

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceControllerTest {
    @Test
    fun markdownSymbolsAndUrlsAreNotReadAloud() {
        val result = sanitizeForSpeech("**重点**：看 [说明](https://example.com)，不要读 * 星号。")
        assertTrue(result.contains("重点"))
        assertTrue(result.contains("说明"))
        assertFalse(result.contains("*"))
        assertFalse(result.contains("https://"))
    }

    @Test
    fun codeBlocksBecomeOneShortDescription() {
        val result = sanitizeForSpeech("前面\n```kotlin\nval hidden = \"secret\"\n```\n后面")
        assertTrue(result.contains("代码段"))
        assertFalse(result.contains("hidden"))
    }
}
