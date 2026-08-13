package com.xinwithyu.dwell.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Memory
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.xinwithyu.dwell.core.model.ModelView

@Composable
fun ModelSheet(visible: Boolean, model: ModelView, onSelect: (String, String) -> Unit, onDismiss: () -> Unit) {
    DwellSheet(visible, onDismiss) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp)) {
            Text("选择模型", style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(vertical = 10.dp))
            Text(
                if (model.runtime.isNotBlank()) "实际运行：${model.runtime}" else "${model.provider} · ${model.resolved}",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(14.dp))
            model.items.forEach { item ->
                val selected = item.id == model.model
                Row(
                    Modifier.fillMaxWidth().clickable(enabled = !model.locked && !selected) {
                        onSelect(item.id, model.effort); onDismiss()
                    }.padding(vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    androidx.compose.foundation.layout.Box(
                        Modifier.size(42.dp).background(MaterialTheme.colorScheme.surfaceVariant, CircleShape),
                        contentAlignment = Alignment.Center,
                    ) { Icon(Icons.Outlined.Memory, null, Modifier.size(21.dp)) }
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) {
                        Text(item.name, style = MaterialTheme.typography.bodyLarge)
                        if (item.desc.isNotBlank()) Text(item.desc, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    if (selected) Icon(Icons.Outlined.Check, "已选择", tint = MaterialTheme.colorScheme.primary)
                }
            }
            if (model.supportsEffort && model.efforts.isNotEmpty()) {
                Spacer(Modifier.height(10.dp))
                Text("思考强度", style = MaterialTheme.typography.titleMedium)
                Row(Modifier.fillMaxWidth().padding(vertical = 12.dp)) {
                    model.efforts.forEach { effort ->
                        val selected = effort == model.effort
                        Text(
                            effort,
                            modifier = Modifier.padding(end = 8.dp)
                                .background(if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(999.dp))
                                .clickable(enabled = !model.locked && !selected) { onSelect(model.model, effort); onDismiss() }
                                .padding(horizontal = 12.dp, vertical = 8.dp),
                            color = if (selected) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurface,
                            style = MaterialTheme.typography.labelLarge,
                        )
                    }
                }
            }
            Spacer(Modifier.height(16.dp))
        }
    }
}
