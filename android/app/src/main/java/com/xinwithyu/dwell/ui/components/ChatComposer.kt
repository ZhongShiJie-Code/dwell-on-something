package com.xinwithyu.dwell.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Mic
import androidx.compose.material.icons.outlined.Stop
import androidx.compose.material.icons.outlined.Waves
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

@Composable
fun ChatComposer(
    text: String,
    modelName: String,
    busy: Boolean,
    listening: Boolean,
    attachmentNames: List<String>,
    onTextChange: (String) -> Unit,
    onAdd: () -> Unit,
    onModel: () -> Unit,
    onVoice: () -> Unit,
    onSend: () -> Unit,
    onStop: () -> Unit,
    onRemoveAttachment: (Int) -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 20.dp, vertical = 8.dp)
            .background(MaterialTheme.colorScheme.surface, RoundedCornerShape(28.dp))
            .padding(start = 18.dp, end = 12.dp, top = 14.dp, bottom = 12.dp),
    ) {
        if (attachmentNames.isNotEmpty()) {
            Row(horizontalArrangement = Arrangement.spacedBy(7.dp), modifier = Modifier.padding(bottom = 8.dp)) {
                attachmentNames.take(3).forEachIndexed { index, name ->
                    Text(
                        name,
                        modifier = Modifier.defaultMinSize(minHeight = 48.dp)
                            .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(10.dp))
                            .clickable(role = Role.Button) { onRemoveAttachment(index) }
                            .padding(horizontal = 9.dp, vertical = 6.dp),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        style = MaterialTheme.typography.labelMedium,
                    )
                }
            }
        }
        Box(Modifier.fillMaxWidth().heightIn(min = 38.dp, max = 132.dp), contentAlignment = Alignment.TopStart) {
            if (text.isEmpty()) Text(
                if (busy) "Claude 正在回复…" else "Chat with Claude…",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodyLarge,
                modifier = Modifier.padding(top = 1.dp),
            )
            BasicTextField(
                value = text,
                onValueChange = onTextChange,
                enabled = !busy,
                textStyle = MaterialTheme.typography.bodyLarge.merge(TextStyle(color = MaterialTheme.colorScheme.onSurface)),
                cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                modifier = Modifier.fillMaxWidth().semantics {
                    contentDescription = "消息输入框"
                },
            )
        }
        Spacer(Modifier.size(6.dp))
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            RoundAction(onAdd) { Icon(Icons.Outlined.Add, "添加", Modifier.size(23.dp)) }
            Spacer(Modifier.width(8.dp))
            Row(
                Modifier.defaultMinSize(minHeight = 48.dp)
                    .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(999.dp))
                    .clickable(role = Role.Button, onClick = onModel).padding(horizontal = 14.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(modelName, style = MaterialTheme.typography.labelLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Spacer(Modifier.weight(1f))
            if (!busy) {
                val micColor by animateColorAsState(
                    if (listening) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceVariant,
                    label = "mic",
                )
                RoundAction(onVoice, micColor) {
                    Icon(Icons.Outlined.Mic, if (listening) "停止听写" else "语音输入", Modifier.size(21.dp), tint = if (listening) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurface)
                }
                Spacer(Modifier.width(8.dp))
            }
            val canSend = text.isNotBlank() || attachmentNames.isNotEmpty()
            Box(
                Modifier.size(48.dp)
                    .background(if (busy || canSend) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.surfaceVariant, CircleShape)
                    .clickable(role = Role.Button, enabled = busy || canSend, onClick = if (busy) onStop else onSend),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    if (busy) Icons.Outlined.Stop else Icons.Outlined.Waves,
                    if (busy) "停止" else "发送",
                    Modifier.size(if (busy) 20.dp else 23.dp),
                    tint = if (busy || canSend) MaterialTheme.colorScheme.surface else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun RoundAction(onClick: () -> Unit, color: androidx.compose.ui.graphics.Color = MaterialTheme.colorScheme.surfaceVariant, content: @Composable () -> Unit) {
    Box(Modifier.size(48.dp).background(color, CircleShape).clickable(role = Role.Button, onClick = onClick), contentAlignment = Alignment.Center) { content() }
}
