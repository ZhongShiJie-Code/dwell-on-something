package com.xinwithyu.dwell.ui.components

import org.junit.Assert.assertEquals
import org.junit.Test

class AssistantAnswerPresentationTest {
    @Test
    fun extractsUniqueRealHttpSourcesAndRemovesTrailingPunctuation() {
        assertEquals(
            listOf(
                AnswerSource("https://example.com/research"),
                AnswerSource("https://news.example.org/path?q=1"),
            ),
            answerSources(
                "详情见 https://example.com/research，另见 https://news.example.org/path?q=1。\n" +
                    "重复来源：https://example.com/research",
            ),
        )
    }

    @Test
    fun offersReusableFollowUpsOnlyWhenAnAnswerHasText() {
        assertEquals(emptyList<String>(), answerFollowUps("   "))
        assertEquals(
            listOf("请继续展开说明。", "请给出一个具体例子。"),
            answerFollowUps("这是一条完整回答。"),
        )
    }
}
