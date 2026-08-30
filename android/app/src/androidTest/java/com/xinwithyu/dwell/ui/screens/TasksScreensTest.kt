package com.xinwithyu.dwell.ui.screens

import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
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
        assert(composeRule.onAllNodesWithText(expected, substring = true).fetchSemanticsNodes().isNotEmpty())
        assert(composeRule.onAllNodesWithText(raw, substring = true).fetchSemanticsNodes().isEmpty())
    }
}
