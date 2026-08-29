package com.xinwithyu.dwell.ui.components

import androidx.compose.ui.test.assertHeightIsAtLeast
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.xinwithyu.dwell.core.settings.ThemeMode
import com.xinwithyu.dwell.ui.theme.DwellTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ChatComposerInputTest {
    @get:Rule
    val composeRule = createComposeRule()

    @Test
    fun messageInputCoversItsFullVisualTouchArea() {
        composeRule.setContent {
            DwellTheme(ThemeMode.DARK) {
                ChatComposer(
                    text = "",
                    modelName = "claude-opus-5",
                    busy = false,
                    listening = false,
                    attachmentNames = emptyList(),
                    onTextChange = {},
                    onAdd = {},
                    onModel = {},
                    onVoice = {},
                    onSend = {},
                    onStop = {},
                    onRemoveAttachment = {},
                )
            }
        }

        composeRule
            .onNodeWithContentDescription("消息输入框", useUnmergedTree = true)
            .assertHeightIsAtLeast(38.dp)
    }
}
