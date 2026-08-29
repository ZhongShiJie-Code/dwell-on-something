package com.xinwithyu.dwell.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Archive
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.FilterList
import androidx.compose.material.icons.outlined.Menu
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.automirrored.outlined.Sort
import androidx.compose.material.icons.outlined.Unarchive
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.xinwithyu.dwell.core.model.ChatDto
import com.xinwithyu.dwell.ui.components.DwellIconButton
import com.xinwithyu.dwell.ui.components.DwellSheet
import com.xinwithyu.dwell.ui.theme.DwellSerif
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

@Composable
fun ChatsScreen(
    chats: List<ChatDto>,
    onMenu: () -> Unit,
    onOpen: (String) -> Unit,
    onNew: () -> Unit,
    onArchive: (String, Boolean) -> Unit,
) {
    var query by remember { mutableStateOf("") }
    var filter by remember { mutableStateOf("all") }
    var newestFirst by remember { mutableStateOf(true) }
    var filterVisible by remember { mutableStateOf(false) }
    val visible = remember(chats, query, filter, newestFirst) {
        chats.asSequence()
            .filter { chat ->
                when (filter) {
                    "dwell" -> !chat.archived && chat.source != "claude-code"
                    "mac" -> !chat.archived && chat.source == "claude-code"
                    "archived" -> chat.archived
                    else -> !chat.archived
                }
            }
            .filter { query.isBlank() || it.name.contains(query, true) || it.preview.contains(query, true) }
            .sortedWith(if (newestFirst) compareByDescending<ChatDto> { it.last } else compareBy { it.last })
            .toList()
    }
    Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        Column(Modifier.fillMaxSize().statusBarsPadding()) {
            Row(Modifier.fillMaxWidth().defaultMinSize(minHeight = 72.dp).padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                DwellIconButton(Icons.Outlined.Menu, "菜单", onMenu)
                Spacer(Modifier.weight(1f))
                DwellIconButton(Icons.Outlined.FilterList, "筛选", { filterVisible = true }, tint = if (filter == "all") MaterialTheme.colorScheme.onBackground else MaterialTheme.colorScheme.primary)
                DwellIconButton(Icons.AutoMirrored.Outlined.Sort, if (newestFirst) "改为最早优先" else "改为最新优先", { newestFirst = !newestFirst })
            }
            Text("Chats", fontFamily = DwellSerif, style = MaterialTheme.typography.displayLarge, modifier = Modifier.padding(horizontal = 24.dp))
            OutlinedTextField(
                value = query,
                onValueChange = { query = it },
                placeholder = { Text("Search Chats") },
                leadingIcon = { Icon(Icons.Outlined.Search, null) },
                singleLine = true,
                shape = RoundedCornerShape(18.dp),
                colors = OutlinedTextFieldDefaults.colors(unfocusedBorderColor = MaterialTheme.colorScheme.outline),
                modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 18.dp),
            )
            Text(
                "${filterLabel(filter)} · ${if (newestFirst) "最新优先" else "最早优先"}",
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 36.dp, vertical = 2.dp),
            )
            LazyColumn(Modifier.fillMaxSize(), contentPadding = androidx.compose.foundation.layout.PaddingValues(start = 24.dp, end = 24.dp, bottom = 100.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                items(visible, key = { it.id }) { chat ->
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Column(
                            Modifier.weight(1f).defaultMinSize(minHeight = 48.dp).clickable(role = Role.Button) { onOpen(chat.id) }.padding(horizontal = 12.dp, vertical = 13.dp),
                        ) {
                            Text(chat.name.ifBlank { "新会话" }, style = MaterialTheme.typography.bodyLarge)
                            Text(
                                listOfNotNull(relativeTime(chat.last).takeIf { it.isNotBlank() }, chat.sourceLabel.takeIf { it.isNotBlank() }).joinToString(" · "),
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        DwellIconButton(
                            if (chat.archived) Icons.Outlined.Unarchive else Icons.Outlined.Archive,
                            if (chat.archived) "恢复会话" else "归档会话",
                            { onArchive(chat.id, !chat.archived) },
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }
        Row(
            Modifier.align(Alignment.BottomEnd).padding(end = 24.dp, bottom = 28.dp)
                .defaultMinSize(minHeight = 48.dp)
                .background(MaterialTheme.colorScheme.onBackground, RoundedCornerShape(999.dp))
                .clickable(role = Role.Button, onClick = onNew)
                .padding(horizontal = 20.dp, vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Outlined.Add, null, tint = MaterialTheme.colorScheme.background, modifier = Modifier.size(20.dp))
            Spacer(Modifier.size(7.dp))
            Text("New chat", color = MaterialTheme.colorScheme.background, style = MaterialTheme.typography.labelLarge)
        }
    }
    DwellSheet(filterVisible, { filterVisible = false }) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 22.dp, vertical = 8.dp)) {
            Text("筛选会话", style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(horizontal = 10.dp, vertical = 10.dp))
            listOf("all" to "全部会话", "dwell" to "Claude Cli 会话", "mac" to "Mac Claude Code", "archived" to "已归档").forEach { (id, label) ->
                Row(
                    Modifier.fillMaxWidth()
                        .defaultMinSize(minHeight = 48.dp)
                        .semantics { selected = filter == id }
                        .clickable(role = Role.RadioButton) { filter = id; filterVisible = false }
                        .padding(horizontal = 10.dp, vertical = 15.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(label, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
                    if (filter == id) Icon(Icons.Outlined.Check, null, tint = MaterialTheme.colorScheme.primary)
                }
            }
        }
    }
}

private fun filterLabel(value: String): String = when (value) {
    "dwell" -> "Claude Cli 会话"
    "mac" -> "Mac Claude Code"
    "archived" -> "已归档"
    else -> "全部会话"
}

private fun relativeTime(value: Long): String {
    if (value <= 0) return ""
    val seconds = (System.currentTimeMillis() / 1000 - value).coerceAtLeast(0)
    return when {
        seconds < 60 -> "刚刚"
        seconds < 3600 -> "${seconds / 60} 分钟前"
        seconds < 86400 -> "${seconds / 3600} 小时前"
        seconds < 3 * 86400 -> "前日"
        seconds < 7 * 86400 -> "${seconds / 86400} 日前"
        else -> DateTimeFormatter.ofPattern("yyyy年M月d日").withZone(ZoneId.systemDefault()).format(Instant.ofEpochSecond(value))
    }
}
