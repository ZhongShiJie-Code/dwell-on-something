# Task Timestamps in Asia/Shanghai Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep task timestamps as UTC ISO-8601 strings in backend/API transport while rendering every visible task-run timestamp, including the screenshot instant, in the fixed `Asia/Shanghai` time zone.

**Architecture:** Add a small pure Kotlin formatter at the UI boundary. It parses backend ISO instants with `Instant.parse`, converts them with `ZoneId.of("Asia/Shanghai")`, and formats with a fixed `Locale.ROOT` pattern; models, repository, API JSON, backend normalization, and storage remain unchanged. Replace the two raw run-time renderings and the two one-shot schedule renderings in `TasksScreens.kt`, because the backend can embed `fireAt` inside `TaskDto.schedule`.

**Tech Stack:** Kotlin, `java.time.Instant`, `java.time.ZoneId`, `java.time.format.DateTimeFormatter`, Jetpack Compose UI tests, JUnit 4, Android Gradle Plugin.

## Global Constraints

- Preserve UTC timestamps in storage and API; do not change backend `toISOString()` normalization or Kotlin model field types.
- Render task timestamps in `ZoneId.of("Asia/Shanghai")`, never `ZoneId.systemDefault()`.
- Use a deterministic `yyyy-MM-dd HH:mm:ss` pattern and `Locale.ROOT`; do not use device-locale formatting or manual `+08:00` arithmetic.
- Support the backend's millisecond `Z` form, including `2026-08-30T01:20:18.526Z`.
- Keep the production change at the Android presentation boundary; do not modify `Models.kt`, `DwellApi.kt`, `DwellRepository.kt`, or backend files.
- A null, blank, or malformed standalone run timestamp renders as the existing empty fallback rather than exposing an unparseable wire value.
- A schedule string with no embedded backend ISO instant remains unchanged.

## File Map

- Create `/Users/tom/Documents/Codex/2026-08-08/https-github-com-xinwithyu-dwell-on/work/dwell-on-something/android/app/src/main/java/com/xinwithyu/dwell/core/time/TaskTimestampFormatter.kt` — pure presentation helpers for standalone ISO timestamps and one-shot schedule strings.
- Modify `/Users/tom/Documents/Codex/2026-08-08/https-github-com-xinwithyu-dwell-on/work/dwell-on-something/android/app/src/main/java/com/xinwithyu/dwell/ui/screens/TasksScreens.kt:111,146,185,199` — route all currently visible task ISO values through the helpers.
- Create `/Users/tom/Documents/Codex/2026-08-08/https-github-com-xinwithyu-dwell-on/work/dwell-on-something/android/app/src/test/java/com/xinwithyu/dwell/core/time/TaskTimestampFormatterTest.kt` — deterministic conversion, rollover, fallback, raw-value preservation, and embedded-schedule unit coverage.
- Create `/Users/tom/Documents/Codex/2026-08-08/https-github-com-xinwithyu-dwell-on/work/dwell-on-something/android/app/src/androidTest/java/com/xinwithyu/dwell/ui/screens/TasksScreensTest.kt` — Compose regression coverage for the actual run-detail rendering path and the screenshot instant.

### Task 1: Add the failing regression test first

**Files:**
- Create: `/Users/tom/Documents/Codex/2026-08-08/https-github-com-xinwithyu-dwell-on/work/dwell-on-something/android/app/src/androidTest/java/com/xinwithyu/dwell/ui/screens/TasksScreensTest.kt`

**Interfaces:**
- Consumes the existing `TaskRunScreen(taskId, runId, onBack, load)` composable from `TasksScreens.kt`.
- Produces a test named `runDetailRendersScreenshotInstantInAsiaShanghai` that fails against the current raw-string implementation and passes once the UI formatter is wired.

- [ ] **Step 1: Write the exact failing Compose test**

```kotlin
package com.xinwithyu.dwell.ui.screens

import androidx.compose.ui.test.assertDoesNotExist
import androidx.compose.ui.test.assertExists
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.xinwithyu.dwell.core.model.TaskDto
import com.xinwithyu.dwell.core.model.TaskRun
import com.xinwithyu.dwell.core.model.TaskRunResponse
import com.xinwithyu.dwell.core.settings.ThemeMode
import com.xinwithyu.dwell.ui.theme.DwellTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class TasksScreensTest {
    @get:Rule
    val composeRule = createComposeRule()

    @Test
    fun runDetailRendersScreenshotInstantInAsiaShanghai() {
        val raw = "2026-08-30T01:20:18.526Z"
        val expected = "2026-08-30 09:20:18"

        composeRule.setContent {
            DwellTheme(ThemeMode.LIGHT) {
                TaskRunScreen(
                    taskId = "task-1",
                    runId = "run-1",
                    onBack = {},
                    load = {
                        Result.success(
                            TaskRunResponse(
                                ok = true,
                                task = TaskDto(id = "task-1", name = "日报任务"),
                                run = TaskRun(
                                    id = "run-1",
                                    taskId = "task-1",
                                    sourceLabel = "定时任务",
                                    startedAt = raw,
                                    status = "success",
                                ),
                            ),
                        )
                    },
                )
            }
        }

        composeRule.waitUntil(5_000) {
            composeRule
                .onAllNodesWithText(expected, substring = true)
                .fetchSemanticsNodes()
                .isNotEmpty()
        }
        composeRule.onNodeWithText(expected, substring = true).assertExists()
        composeRule.onNodeWithText(raw, substring = true).assertDoesNotExist()
    }
}
```

Add the missing import required by the test body:

```kotlin
import androidx.compose.ui.test.onAllNodesWithText
```

- [ ] **Step 2: Run only this test before changing production code**

Run from `/Users/tom/Documents/Codex/2026-08-08/https-github-com-xinwithyu-dwell-on/work/dwell-on-something/android`:

```bash
./gradlew :app:connectedDebugAndroidTest \
  -Pandroid.testInstrumentationRunnerArguments.class=com.xinwithyu.dwell.ui.screens.TasksScreensTest
```

Expected result before production edits: **FAIL**. The existing `TaskRunScreen` emits `定时任务 · 2026-08-30T01:20:18.526Z`, so the expected `2026-08-30 09:20:18` node never appears and the test times out. This is the exact test that must fail before the production change.

- [ ] **Step 3: Commit the red test**

```bash
git add android/app/src/androidTest/java/com/xinwithyu/dwell/ui/screens/TasksScreensTest.kt
git commit -m "test: reproduce raw task timestamp rendering"
```

### Task 2: Implement the pure fixed-zone formatter

**Files:**
- Create: `/Users/tom/Documents/Codex/2026-08-08/https-github-com-xinwithyu-dwell-on/work/dwell-on-something/android/app/src/main/java/com/xinwithyu/dwell/core/time/TaskTimestampFormatter.kt`
- Create: `/Users/tom/Documents/Codex/2026-08-08/https-github-com-xinwithyu-dwell-on/work/dwell-on-something/android/app/src/test/java/com/xinwithyu/dwell/core/time/TaskTimestampFormatterTest.kt`

**Interfaces:**
- Produces `fun formatTaskTimestamp(raw: String?): String` for a nullable standalone backend ISO instant.
- Produces `fun formatTaskSchedule(raw: String): String` for a task schedule that may contain the backend's ISO `fireAt` value.

- [ ] **Step 1: Write the unit tests**

Create `/Users/tom/Documents/Codex/2026-08-08/https-github-com-xinwithyu-dwell-on/work/dwell-on-something/android/app/src/test/java/com/xinwithyu/dwell/core/time/TaskTimestampFormatterTest.kt` with:

```kotlin
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
```

- [ ] **Step 2: Run the unit test to verify the formatter is not implemented yet**

```bash
./gradlew :app:testDebugUnitTest --tests com.xinwithyu.dwell.core.time.TaskTimestampFormatterTest
```

Expected result before the formatter is added: **FAIL** because `TaskTimestampFormatter.kt` and its two functions do not yet exist.

- [ ] **Step 3: Add the minimal formatter implementation**

Create `/Users/tom/Documents/Codex/2026-08-08/https-github-com-xinwithyu-dwell-on/work/dwell-on-something/android/app/src/main/java/com/xinwithyu/dwell/core/time/TaskTimestampFormatter.kt`:

```kotlin
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
```

This is compatible with the existing `minSdk 26` and Java/Kotlin 17 configuration; no dependency or desugaring change is needed.

- [ ] **Step 4: Run the unit tests to verify they pass**

```bash
./gradlew :app:testDebugUnitTest --tests com.xinwithyu.dwell.core.time.TaskTimestampFormatterTest
```

Expected result: **PASS**, including `2026-08-30T01:20:18.526Z` → `2026-08-30 09:20:18` and the day rollover case.

- [ ] **Step 5: Commit the formatter and unit tests**

```bash
git add android/app/src/main/java/com/xinwithyu/dwell/core/time/TaskTimestampFormatter.kt \
  android/app/src/test/java/com/xinwithyu/dwell/core/time/TaskTimestampFormatterTest.kt
git commit -m "feat: add fixed Asia Shanghai task timestamp formatter"
```

### Task 3: Wire every visible task timestamp through the formatter

**Files:**
- Modify: `/Users/tom/Documents/Codex/2026-08-08/https-github-com-xinwithyu-dwell-on/work/dwell-on-something/android/app/src/main/java/com/xinwithyu/dwell/ui/screens/TasksScreens.kt:111,146,185,199`

**Interfaces:**
- Consumes `formatTaskTimestamp(String?): String` and `formatTaskSchedule(String): String` from `com.xinwithyu.dwell.core.time`.
- Leaves all API/model values unchanged; only the four Compose `Text` expressions change.

- [ ] **Step 1: Import the two helpers**

Add this import with the other project imports in `TasksScreens.kt`:

```kotlin
import com.xinwithyu.dwell.core.time.formatTaskSchedule
import com.xinwithyu.dwell.core.time.formatTaskTimestamp
```

- [ ] **Step 2: Replace the four raw renderings**

Change the task-detail header at line 111 from:

```kotlin
Text("${if (detail.task.enabled) "已启用" else "已暂停"} · ${detail.task.schedule}", color = if (detail.task.enabled) ColorSuccess else MaterialTheme.colorScheme.onSurfaceVariant)
```

to:

```kotlin
Text("${if (detail.task.enabled) "已启用" else "已暂停"} · ${formatTaskSchedule(detail.task.schedule)}", color = if (detail.task.enabled) ColorSuccess else MaterialTheme.colorScheme.onSurfaceVariant)
```

Change the task-list card at line 185 from:

```kotlin
Text("${task.schedule} · ${task.lastResult}", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
```

to:

```kotlin
Text("${formatTaskSchedule(task.schedule)} · ${task.lastResult}", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
```

Change the run-detail header at line 146 from:

```kotlin
Text("${data.run.sourceLabel} · ${data.run.startedAt.orEmpty()}", color = MaterialTheme.colorScheme.onSurfaceVariant)
```

to:

```kotlin
Text("${data.run.sourceLabel} · ${formatTaskTimestamp(data.run.startedAt)}", color = MaterialTheme.colorScheme.onSurfaceVariant)
```

Change the run-history card at line 199 from:

```kotlin
Text(run.startedAt.orEmpty(), style = MaterialTheme.typography.titleMedium)
```

to:

```kotlin
Text(formatTaskTimestamp(run.startedAt), style = MaterialTheme.typography.titleMedium)
```

Do not convert `completedAt`, `TaskRunStep.at`, or `TaskOutput.updatedAt` in this change because they are not rendered by `TasksScreens.kt`; route them through the same helper if a later UI adds those fields.

- [ ] **Step 3: Re-run the exact regression test**

```bash
./gradlew :app:connectedDebugAndroidTest \
  -Pandroid.testInstrumentationRunnerArguments.class=com.xinwithyu.dwell.ui.screens.TasksScreensTest
```

Expected result: **PASS**. The run-detail screen contains `2026-08-30 09:20:18` and no longer contains `2026-08-30T01:20:18.526Z`.

- [ ] **Step 4: Run the complete Android test suites**

```bash
./gradlew :app:testDebugUnitTest
./gradlew :app:connectedDebugAndroidTest
```

Expected result: **PASS** for all JVM unit tests and all connected Android instrumentation tests.

- [ ] **Step 5: Verify the wire/storage boundary did not change**

Inspect the final diff and confirm it contains no changes to:

- `/Users/tom/Documents/Codex/2026-08-08/https-github-com-xinwithyu-dwell-on/work/dwell-on-something/backend/desktop-task-history.mjs`
- `/Users/tom/Documents/Codex/2026-08-08/https-github-com-xinwithyu-dwell-on/work/dwell-on-something/backend/desktop-tasks.mjs`
- `/Users/tom/Documents/Codex/2026-08-08/https-github-com-xinwithyu-dwell-on/work/dwell-on-something/android/app/src/main/java/com/xinwithyu/dwell/core/model/Models.kt`
- `/Users/tom/Documents/Codex/2026-08-08/https-github-com-xinwithyu-dwell-on/work/dwell-on-something/android/app/src/main/java/com/xinwithyu/dwell/core/network/DwellApi.kt`
- `/Users/tom/Documents/Codex/2026-08-08/https-github-com-xinwithyu-dwell-on/work/dwell-on-something/android/app/src/main/java/com/xinwithyu/dwell/core/repository/DwellRepository.kt`

The expected production diff is one new formatter file plus the import and four display substitutions in `TasksScreens.kt`; the expected API fixture remains `2026-08-30T01:20:18.526Z`.

- [ ] **Step 6: Commit the UI wiring**

```bash
git add android/app/src/main/java/com/xinwithyu/dwell/ui/screens/TasksScreens.kt \
  android/app/src/androidTest/java/com/xinwithyu/dwell/ui/screens/TasksScreensTest.kt
git commit -m "fix: render task times in Asia Shanghai"
```

## Acceptance Checklist

- `2026-08-30T01:20:18.526Z` renders as `2026-08-30 09:20:18` on run detail and run history.
- A one-shot schedule containing that ISO value renders `一次性 · 2026-08-30 09:20:18` in both task list and task detail.
- The raw ISO value is absent from the rendered task-run UI.
- The conversion is invariant across device time zones and locales because the formatter uses an explicit `Asia/Shanghai` zone and `Locale.ROOT`.
- Backend/API/storage values remain UTC ISO strings and are not rewritten.
- The named Compose regression test fails before production edits and passes after the minimal UI-boundary change.
