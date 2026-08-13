package com.xinwithyu.dwell.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Alarm
import androidx.compose.material.icons.outlined.Archive
import androidx.compose.material.icons.outlined.AutoStories
import androidx.compose.material.icons.outlined.CalendarMonth
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material.icons.outlined.CheckBox
import androidx.compose.material.icons.outlined.EditNote
import androidx.compose.material.icons.outlined.FavoriteBorder
import androidx.compose.material.icons.outlined.Newspaper
import androidx.compose.material.icons.outlined.Storage
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.Text
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import com.xinwithyu.dwell.ui.theme.DwellSerif
import kotlinx.coroutines.launch

data class DrawerDestination(val id: String, val label: String, val icon: ImageVector)

val drawerDestinations = listOf(
    DrawerDestination("chat", "聊天", Icons.Outlined.ChatBubbleOutline),
    DrawerDestination("todo", "待办", Icons.Outlined.CheckBox),
    DrawerDestination("calendar", "日历", Icons.Outlined.CalendarMonth),
    DrawerDestination("diary", "日记", Icons.Outlined.EditNote),
    DrawerDestination("nook", "共读", Icons.Outlined.AutoStories),
    DrawerDestination("news", "日报", Icons.Outlined.Newspaper),
    DrawerDestination("health", "健康", Icons.Outlined.FavoriteBorder),
    DrawerDestination("repo", "仓库", Icons.Outlined.Archive),
    DrawerDestination("tasks", "定时任务", Icons.Outlined.Alarm),
)

@Composable
fun DwellNavigationDrawer(
    selected: String,
    onDestination: (String) -> Unit,
    onSettings: () -> Unit,
    drawerRequest: Int,
    gesturesEnabled: Boolean = true,
    content: @Composable (openDrawer: () -> Unit) -> Unit,
) {
    val state = rememberDrawerState(DrawerValue.Closed)
    val scope = rememberCoroutineScope()
    androidx.compose.runtime.LaunchedEffect(drawerRequest) { if (drawerRequest > 0) state.open() }
    ModalNavigationDrawer(
        drawerState = state,
        gesturesEnabled = gesturesEnabled,
        drawerContent = {
            ModalDrawerSheet(
                modifier = Modifier.fillMaxWidth(0.84f).fillMaxHeight(),
                drawerContainerColor = MaterialTheme.colorScheme.background,
                drawerTonalElevation = 0.dp,
            ) {
                Column(Modifier.fillMaxHeight().padding(horizontal = 18.dp)) {
                    Spacer(Modifier.height(56.dp))
                    Text("Claude", fontFamily = DwellSerif, style = MaterialTheme.typography.displayLarge, modifier = Modifier.padding(horizontal = 18.dp, vertical = 16.dp))
                    Spacer(Modifier.height(10.dp))
                    drawerDestinations.forEach { item ->
                        val active = item.id == selected
                        Row(
                            Modifier.fillMaxWidth()
                                .background(if (active) MaterialTheme.colorScheme.surfaceVariant else androidx.compose.ui.graphics.Color.Transparent, RoundedCornerShape(18.dp))
                                .clickable {
                                    scope.launch { state.close() }
                                    onDestination(item.id)
                                }
                                .padding(horizontal = 20.dp, vertical = 16.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Icon(item.icon, null, Modifier.size(24.dp))
                            Spacer(Modifier.width(18.dp))
                            Text(item.label, style = MaterialTheme.typography.titleMedium)
                        }
                    }
                    Spacer(Modifier.weight(1f))
                    Row(
                        Modifier.padding(start = 14.dp, bottom = 28.dp).size(60.dp).background(MaterialTheme.colorScheme.surface, CircleShape)
                            .clickable { scope.launch { state.close() }; onSettings() },
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = androidx.compose.foundation.layout.Arrangement.Center,
                    ) { Text("Me", style = MaterialTheme.typography.titleLarge) }
                }
            }
        },
    ) {
        content { scope.launch { state.open() } }
    }
}
