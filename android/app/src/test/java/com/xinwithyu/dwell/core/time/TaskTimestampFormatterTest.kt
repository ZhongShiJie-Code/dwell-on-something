package com.xinwithyu.dwell.core.time

import org.junit.Assert.assertEquals
import org.junit.Test

class TaskTimestampFormatterTest {
    @Test
    fun convertsUtcToBeijingTime() {
        assertEquals(
            "2026-08-24 08:00:00",
            formatTaskTimestamp("2026-08-24T00:00:00.000Z"),
        )
    }

    @Test
    fun rollsOverToTheNextBeijingDay() {
        assertEquals(
            "2026-08-25 00:00:00",
            formatTaskTimestamp("2026-08-24T16:00:00.000Z"),
        )
    }

    @Test
    fun convertsTheScreenshotInstantAndDropsOnlyDisplayPrecision() {
        assertEquals(
            "2026-08-30 09:20:18",
            formatTaskTimestamp("2026-08-30T01:20:18.526Z"),
        )
    }

    @Test
    fun returnsEmptyForNullBlankAndMalformedStandaloneValues() {
        assertEquals("", formatTaskTimestamp(null))
        assertEquals("", formatTaskTimestamp("   "))
        assertEquals("", formatTaskTimestamp("not-a-timestamp"))
    }

    @Test
    fun leavesTheWireValueUntouchedAndFormatsOnlyTheDisplayCopy() {
        val raw = "2026-08-30T01:20:18.526Z"
        assertEquals("2026-08-30 09:20:18", formatTaskTimestamp(raw))
        assertEquals("2026-08-30T01:20:18.526Z", raw)
    }

    @Test
    fun convertsAnEmbeddedOneShotScheduleInstant() {
        assertEquals(
            "一次性 · 2026-08-30 09:20:18",
            formatTaskSchedule("一次性 · 2026-08-30T01:20:18.526Z"),
        )
    }

    @Test
    fun leavesNonIsoSchedulesUnchanged() {
        assertEquals("每天 09:00", formatTaskSchedule("每天 09:00"))
    }
}
