package com.xinwithyu.dwell.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
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
import androidx.compose.material.icons.outlined.ArrowBack
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Menu
import androidx.compose.material.icons.outlined.Pause
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.xinwithyu.dwell.core.model.TaskDetailResponse
import com.xinwithyu.dwell.core.model.TaskDto
import com.xinwithyu.dwell.core.model.TaskListResponse
import com.xinwithyu.dwell.core.model.TaskRun
import com.xinwithyu.dwell.core.model.TaskRunResponse
import com.xinwithyu.dwell.ui.components.DwellIconButton
import com.xinwithyu.dwell.ui.theme.DwellSerif
import kotlinx.coroutines.launch

@Composable
fun TasksScreen(
    onMenu: () -> Unit,
    onOpenTask: (String) -> Unit,
    load: suspend () -> Result<TaskListResponse>,
) {
    var response by remember { mutableStateOf<TaskListResponse?>(null) }
    var error by remember { mutableStateOf("") }
    var refresh by remember { mutableStateOf(0) }
    LaunchedEffect(refresh) { load().onSuccess { response = it; error = "" }.onFailure { error = it.message.orEmpty() } }
    Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).statusBarsPadding()) {
        Row(Modifier.fillMaxWidth().height(70.dp).padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            DwellIconButton(Icons.Outlined.Menu, "菜单", onMenu)
            Spacer(Modifier.weight(1f))
            DwellIconButton(Icons.Outlined.Refresh, "刷新", { refresh++ })
        }
        Text("定时任务", fontFamily = DwellSerif, style = MaterialTheme.typography.headlineLarge, modifier = Modifier.padding(horizontal = 24.dp, vertical = 8.dp))
        if (response == null && error.isBlank()) Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
        else if (error.isNotBlank()) ErrorState(error) { refresh++ }
        else LazyColumn(
            contentPadding = PaddingValues(20.dp, 16.dp, 20.dp, 40.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            items(response?.items.orEmpty(), key = { it.id }) { task ->
                TaskCard(task) { onOpenTask(task.id) }
            }
        }
    }
}

@Composable
fun TaskDetailScreen(
    taskId: String,
    onBack: () -> Unit,
    onOpenRun: (String) -> Unit,
    load: suspend () -> Result<TaskDetailResponse>,
    action: suspend (String) -> Result<Unit>,
) {
    val scope = rememberCoroutineScope()
    var response by remember(taskId) { mutableStateOf<TaskDetailResponse?>(null) }
    var error by remember { mutableStateOf("") }
    var working by remember { mutableStateOf(false) }
    var refresh by remember { mutableStateOf(0) }
    LaunchedEffect(taskId, refresh) { load().onSuccess { response = it; error = "" }.onFailure { error = it.message.orEmpty() } }
    Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).statusBarsPadding()) {
        NativeBackBar(onBack, "任务详情")
        val detail = response
        if (detail == null && error.isBlank()) Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
        else if (error.isNotBlank()) ErrorState(error) { refresh++ }
        else if (detail != null) LazyColumn(contentPadding = PaddingValues(22.dp, 12.dp, 22.dp, 40.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            item {
                Text(detail.task.name, fontFamily = DwellSerif, style = MaterialTheme.typography.headlineMedium)
                Spacer(Modifier.height(8.dp))
                Text(detail.task.description, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.height(12.dp))
                Text("${if (detail.task.enabled) "已启用" else "已暂停"} · ${detail.task.schedule}", color = if (detail.task.enabled) ColorSuccess else MaterialTheme.colorScheme.onSurfaceVariant)
            }
            item {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    TaskActionButton("立即运行", Icons.Outlined.PlayArrow, enabled = detail.control.available && !working) {
                        working = true
                        scope.launch { action("run").onFailure { error = it.message.orEmpty() }; working = false; refresh++ }
                    }
                    TaskActionButton(if (detail.task.enabled) "暂停" else "恢复", Icons.Outlined.Pause, enabled = detail.control.available && !working) {
                        working = true
                        scope.launch { action(if (detail.task.enabled) "pause" else "resume").onFailure { error = it.message.orEmpty() }; working = false; refresh++ }
                    }
                }
                if (!detail.control.available) Text("Mac 任务控制桥未连接；运行记录仍可查看。", modifier = Modifier.padding(top = 10.dp), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            item { Text("运行记录", style = MaterialTheme.typography.titleLarge) }
            if (detail.runs.isEmpty()) item { Text("还没有运行记录", color = MaterialTheme.colorScheme.onSurfaceVariant) }
            items(detail.runs, key = { it.id }) { run -> RunCard(run) { onOpenRun(run.id) } }
        }
    }
}

@Composable
fun TaskRunScreen(taskId: String, runId: String, onBack: () -> Unit, load: suspend () -> Result<TaskRunResponse>) {
    var response by remember(taskId, runId) { mutableStateOf<TaskRunResponse?>(null) }
    var error by remember { mutableStateOf("") }
    LaunchedEffect(taskId, runId) { load().onSuccess { response = it }.onFailure { error = it.message.orEmpty() } }
    Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).statusBarsPadding()) {
        NativeBackBar(onBack, "运行详情")
        val data = response
        if (data == null && error.isBlank()) Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
        else if (error.isNotBlank()) ErrorState(error) { }
        else if (data != null) LazyColumn(contentPadding = PaddingValues(24.dp, 12.dp, 24.dp, 44.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            item {
                Text(data.task.name, fontFamily = DwellSerif, style = MaterialTheme.typography.headlineMedium)
                Text("${data.run.sourceLabel} · ${data.run.startedAt.orEmpty()}", color = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.height(14.dp))
                StatusBadge(data.run.status)
            }
            if (data.run.summary.isNotBlank()) item { Text(data.run.summary, style = MaterialTheme.typography.bodyLarge) }
            if (data.run.steps.isNotEmpty()) {
                item { Text("Progress", style = MaterialTheme.typography.titleLarge) }
                items(data.run.steps) { step ->
                    Row(Modifier.fillMaxWidth()) {
                        Box(Modifier.padding(top = 7.dp).size(9.dp).background(statusColor(step.status), CircleShape))
                        Spacer(Modifier.size(12.dp))
                        Column(Modifier.weight(1f)) {
                            Text(step.title, style = MaterialTheme.typography.titleMedium)
                            if (step.detail.isNotBlank()) Text(step.detail, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
            if (data.run.outputs.isNotEmpty()) {
                item { Text("Working folder", style = MaterialTheme.typography.titleLarge) }
                items(data.run.outputs) { output -> Text("▣  ${output.name}", modifier = Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(14.dp)).padding(14.dp)) }
            }
        }
    }
}

@Composable
private fun TaskCard(task: TaskDto, onClick: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.66f), RoundedCornerShape(22.dp))
            .clickable(onClick = onClick).padding(18.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(task.name, style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
            Box(Modifier.size(9.dp).background(if (task.enabled) ColorSuccess else MaterialTheme.colorScheme.outline, CircleShape))
        }
        Spacer(Modifier.height(6.dp))
        Text(task.description, maxLines = 3, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(12.dp))
        Text("${task.schedule} · ${task.lastResult}", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun RunCard(run: TaskRun, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f), RoundedCornerShape(18.dp))
            .clickable(onClick = onClick).padding(16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(if (run.status == "success") Icons.Outlined.CheckCircle else if (run.status == "running") Icons.Outlined.Schedule else Icons.Outlined.ErrorOutline, null, tint = statusColor(run.status))
        Spacer(Modifier.size(12.dp))
        Column(Modifier.weight(1f)) {
            Text(run.startedAt.orEmpty(), style = MaterialTheme.typography.titleMedium)
            Text(run.sourceLabel.ifBlank { run.source }, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Text(run.status, style = MaterialTheme.typography.labelLarge, color = statusColor(run.status))
    }
}

@Composable
private fun NativeBackBar(onBack: () -> Unit, title: String) {
    Row(Modifier.fillMaxWidth().height(70.dp).padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        DwellIconButton(Icons.Outlined.ArrowBack, "返回", onBack)
        Text(title, style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(start = 8.dp))
    }
}

@Composable
private fun TaskActionButton(label: String, icon: androidx.compose.ui.graphics.vector.ImageVector, enabled: Boolean, onClick: () -> Unit) {
    Row(
        Modifier.background(if (enabled) MaterialTheme.colorScheme.onBackground else MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(16.dp))
            .clickable(enabled = enabled, onClick = onClick).padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, Modifier.size(19.dp), tint = if (enabled) MaterialTheme.colorScheme.background else MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.size(7.dp))
        Text(label, color = if (enabled) MaterialTheme.colorScheme.background else MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun StatusBadge(status: String) {
    Text(status, color = statusColor(status), fontWeight = FontWeight.SemiBold, modifier = Modifier.background(statusColor(status).copy(alpha = 0.12f), RoundedCornerShape(999.dp)).padding(horizontal = 12.dp, vertical = 7.dp))
}

@Composable
private fun ErrorState(error: String, retry: () -> Unit) {
    Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        Text(error, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(24.dp))
        Text("重试", modifier = Modifier.background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(999.dp)).clickable(onClick = retry).padding(horizontal = 18.dp, vertical = 10.dp))
    }
}

private val ColorSuccess = androidx.compose.ui.graphics.Color(0xFF4FAE76)
@Composable private fun statusColor(status: String) = when (status) {
    "success", "done" -> ColorSuccess
    "running", "queued" -> MaterialTheme.colorScheme.primary
    else -> MaterialTheme.colorScheme.error
}
