package com.xinwithyu.dwell.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AttachFile
import androidx.compose.material.icons.outlined.BusinessCenter
import androidx.compose.material.icons.outlined.CameraAlt
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.FolderOpen
import androidx.compose.material.icons.outlined.Language
import androidx.compose.material.icons.outlined.PhotoLibrary
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp

@Composable
fun AddToChatSheet(
    visible: Boolean,
    webSearch: Boolean,
    onWebSearch: (Boolean) -> Unit,
    onCamera: () -> Unit,
    onPhotos: () -> Unit,
    onFiles: () -> Unit,
    onProject: () -> Unit,
    onToolAccess: () -> Unit,
    onConnectors: () -> Unit,
    onDismiss: () -> Unit,
) {
    DwellSheet(visible = visible, onDismiss = onDismiss) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 18.dp)) {
            Box(Modifier.fillMaxWidth().defaultMinSize(minHeight = 48.dp).padding(vertical = 4.dp)) {
                IconButton(onClick = onDismiss, modifier = Modifier.align(Alignment.CenterStart).size(48.dp)) {
                    Icon(Icons.Outlined.Close, "关闭", Modifier.size(23.dp))
                }
                Text("Add to chat", style = MaterialTheme.typography.titleLarge, modifier = Modifier.align(Alignment.Center))
            }
            Spacer(Modifier.height(14.dp))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                AttachmentTile(Icons.Outlined.CameraAlt, "Camera", onCamera, Modifier.weight(1f))
                AttachmentTile(Icons.Outlined.PhotoLibrary, "Photos", onPhotos, Modifier.weight(1f))
                AttachmentTile(Icons.Outlined.AttachFile, "Files", onFiles, Modifier.weight(1f))
            }
            Spacer(Modifier.height(12.dp))
            SheetGroup {
                SheetRow(Icons.Outlined.Language, "Web search", trailing = {
                    Switch(checked = webSearch, onCheckedChange = onWebSearch)
                }) { onWebSearch(!webSearch) }
            }
            Spacer(Modifier.height(12.dp))
            SheetGroup {
                SheetRow(Icons.Outlined.FolderOpen, "Add to project", "当前项目", onClick = onProject)
                DividerLine()
                SheetRow(Icons.Outlined.BusinessCenter, "Tool access", "Auto", onClick = onToolAccess)
            }
            Spacer(Modifier.height(12.dp))
            SheetGroup {
                SheetRow(Icons.Outlined.AttachFile, "Connectors", onClick = onConnectors)
            }
            Spacer(Modifier.height(18.dp))
        }
    }
}

@Composable
private fun AttachmentTile(icon: ImageVector, label: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Column(
        modifier = modifier
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.48f), RoundedCornerShape(24.dp))
            .clickable(role = Role.Button, onClick = onClick)
            .defaultMinSize(minHeight = 48.dp)
            .padding(vertical = 20.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(Modifier.size(52.dp).background(MaterialTheme.colorScheme.surfaceVariant, CircleShape), contentAlignment = Alignment.Center) {
            Icon(icon, label, Modifier.size(24.dp))
        }
        Spacer(Modifier.height(12.dp))
        Text(label, style = MaterialTheme.typography.bodyLarge)
    }
}

@Composable
private fun SheetGroup(content: @Composable () -> Unit) {
    Column(
        Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.48f), RoundedCornerShape(22.dp)),
        content = { content() },
    )
}

@Composable
private fun SheetRow(
    icon: ImageVector,
    title: String,
    subtitle: String = "",
    trailing: (@Composable () -> Unit)? = null,
    onClick: () -> Unit,
) {
    Row(
        Modifier.fillMaxWidth()
            .then(if (trailing == null) Modifier.clickable(role = Role.Button, onClick = onClick) else Modifier)
            .defaultMinSize(minHeight = 48.dp)
            .padding(horizontal = 14.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(44.dp).background(MaterialTheme.colorScheme.surfaceVariant, CircleShape), contentAlignment = Alignment.Center) {
            Icon(icon, null, Modifier.size(22.dp))
        }
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge)
            if (subtitle.isNotBlank()) Text(subtitle, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
        }
        if (trailing != null) trailing()
        else Icon(Icons.Outlined.ChevronRight, null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(20.dp))
    }
}

@Composable
private fun DividerLine() {
    Box(Modifier.fillMaxWidth().padding(start = 70.dp).height(1.dp).background(MaterialTheme.colorScheme.outline.copy(alpha = 0.22f)))
}
