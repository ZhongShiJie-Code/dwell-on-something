package com.xinwithyu.dwell.core.notification

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class NotificationRouteParserTest {
    @Test
    fun acceptsOnlyStrictChatAndTaskRoutes() {
        assertEquals("main", (NotificationRouteParser.parse("chat/main", "chat") as NotificationRoute.Chat).chatId)
        assertEquals(
            NotificationRoute.Task("task-1", "run-1", "task/task-1/run-1"),
            NotificationRouteParser.parse("task/task-1/run-1", "task"),
        )
    }

    @Test
    fun rejectsMalformedOrExternalRoutes() {
        listOf(
            "chat/a%2Fb",
            "chat/%ZZ",
            "chat/",
            "chat//x",
            "task/task-1",
            "http://example.com",
            "intent://foo",
            "chat/main?x=1",
            "chat/%00",
        ).forEach { route -> assertNull(route, NotificationRouteParser.parse(route)) }
    }

    @Test
    fun enforcesDecodedIdentifierUtf8Boundary() {
        val accepted = "a".repeat(512)
        val rejected = "a".repeat(513)

        assertEquals("chat/$accepted", NotificationRouteParser.parse("chat/$accepted", "chat")!!.raw)
        assertNull(NotificationRouteParser.parse("chat/$rejected", "chat"))
    }

    @Test
    fun rejectsKindMismatch() {
        assertNull(NotificationRouteParser.parse("chat/main", "task"))
        assertNull(NotificationRouteParser.parse("task/task-1/run-1", "chat"))
    }
}
