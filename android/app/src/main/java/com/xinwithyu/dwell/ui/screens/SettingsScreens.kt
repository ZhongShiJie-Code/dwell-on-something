package com.xinwithyu.dwell.ui.screens

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ArrowBack
import androidx.compose.material.icons.outlined.Bolt
import androidx.compose.material.icons.outlined.DarkMode
import androidx.compose.material.icons.outlined.NotificationsNone
import androidx.compose.material.icons.outlined.PersonOutline
import androidx.compose.material.icons.outlined.Sync
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.xinwithyu.dwell.core.repository.ConnectionState
import com.xinwithyu.dwell.core.settings.AppSettings
import com.xinwithyu.dwell.core.settings.ThemeMode
import com.xinwithyu.dwell.ui.components.DwellIconButton
import com.xinwithyu.dwell.ui.theme.DwellSerif
import com.xinwithyu.dwell.worker.NotificationScheduler
import kotlinx.coroutines.launch

@Composable
fun PairingScreen(
    settings: AppSettings,
    error: String,
    onPair: suspend (String, String, String, Boolean) -> Result<Unit>,
) {
    val scope = rememberCoroutineScope()
    var localUrl by remember(settings.localUrl) { mutableStateOf(settings.localUrl) }
    var remoteUrl by remember(settings.remoteUrl) { mutableStateOf(settings.remoteUrl) }
    var code by remember { mutableStateOf("") }
    var working by remember { mutableStateOf(false) }
    var localError by remember { mutableStateOf("") }
    Column(
        Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).statusBarsPadding().verticalScroll(rememberScrollState()).padding(horizontal = 26.dp, vertical = 30.dp),
    ) {
        Text("Dwell", fontFamily = DwellSerif, style = MaterialTheme.typography.displayLarge)
        Text("连接你的 Mac", style = MaterialTheme.typography.titleLarge)
        Spacer(Modifier.height(28.dp))
        Text("1. 在 Mac 的项目目录运行", style = MaterialTheme.typography.titleMedium)
        Text("cd backend && npm run pair", modifier = Modifier.fillMaxWidth().padding(vertical = 10.dp).background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(14.dp)).padding(14.dp), style = MaterialTheme.typography.bodyLarge)
        Text("2. 把 Mac 显示的 6 位配对码填到下面", style = MaterialTheme.typography.titleMedium)
        Spacer(Modifier.height(18.dp))
        OutlinedTextField(code, { code = it.filter(Char::isDigit).take(6) }, label = { Text("6 位配对码") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.fillMaxWidth())
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(localUrl, { localUrl = it }, label = { Text("局域网地址（优先）") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(remoteUrl, { remoteUrl = it }, label = { Text("Cloudflare 地址（外网）") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        Spacer(Modifier.height(20.dp))
        Row(
            Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.onBackground, RoundedCornerShape(18.dp)).clickable(enabled = code.length == 6 && !working) {
                working = true
                scope.launch {
                    onPair(code, localUrl, remoteUrl, false).onFailure { localError = it.message.orEmpty() }
                    working = false
                }
            }.padding(vertical = 15.dp),
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (working) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.background)
            else Text("配对并连接", color = MaterialTheme.colorScheme.background, style = MaterialTheme.typography.labelLarge)
        }
        val shownError = localError.ifBlank { error }
        if (shownError.isNotBlank()) Text(shownError, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 14.dp))
        Spacer(Modifier.height(22.dp))
        Text("设备令牌只保存在 Android Keystore；应用会先尝试局域网，失败后自动切到 Cloudflare。", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
fun SettingsScreen(
    settings: AppSettings,
    connection: ConnectionState,
    endpoint: String,
    backendVersion: String,
    safeMode: Boolean,
    onBack: () -> Unit,
    onSaveConnection: suspend (String, String, Boolean) -> Unit,
    onReconnect: () -> Unit,
    onTheme: suspend (ThemeMode) -> Unit,
    onNotifications: suspend (Boolean) -> Unit,
    onDisconnect: () -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var localUrl by remember(settings.localUrl) { mutableStateOf(settings.localUrl) }
    var remoteUrl by remember(settings.remoteUrl) { mutableStateOf(settings.remoteUrl) }
    var preferRemote by remember(settings.preferRemote) { mutableStateOf(settings.preferRemote) }
    var notificationRequested by remember { mutableStateOf(false) }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        notificationRequested = false
        scope.launch {
            onNotifications(granted)
            NotificationScheduler.setEnabled(context, granted)
        }
    }
    Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).statusBarsPadding()) {
        Row(Modifier.fillMaxWidth().height(70.dp).padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            DwellIconButton(Icons.Outlined.ArrowBack, "返回", onBack)
            Text("设置", style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(start = 8.dp))
        }
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 10.dp)) {
            SettingsLabel("账号")
            SettingsGroup {
                SettingsRow(Icons.Outlined.PersonOutline, "用户", "本机")
                SettingsDivider()
                SettingsRow(Icons.Outlined.Sync, "后端在跑吗", when (connection) {
                    ConnectionState.CONNECTED -> "活着 · v$backendVersion"
                    ConnectionState.CONNECTING -> "连接中"
                    ConnectionState.OFFLINE -> "离线"
                    ConnectionState.NEEDS_PAIRING -> "需要配对"
                })
                if (safeMode) {
                    SettingsDivider()
                    SettingsRow(Icons.Outlined.Bolt, "安全模式", "旧页面暂时停用")
                }
            }
            SettingsLabel("连接")
            SettingsGroup {
                Column(Modifier.padding(16.dp)) {
                    OutlinedTextField(localUrl, { localUrl = it }, label = { Text("局域网地址") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                    Spacer(Modifier.height(10.dp))
                    OutlinedTextField(remoteUrl, { remoteUrl = it }, label = { Text("Cloudflare 地址") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Text("优先使用 Cloudflare", modifier = Modifier.weight(1f))
                        Switch(preferRemote, { preferRemote = it })
                    }
                    Text("当前：${endpoint.ifBlank { "未连接" }}", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(Modifier.height(12.dp))
                    Text(
                        "保存并重连",
                        modifier = Modifier.background(MaterialTheme.colorScheme.onBackground, RoundedCornerShape(14.dp)).clickable {
                            scope.launch { onSaveConnection(localUrl, remoteUrl, preferRemote); onReconnect() }
                        }.padding(horizontal = 16.dp, vertical = 11.dp),
                        color = MaterialTheme.colorScheme.background,
                    )
                }
            }
            SettingsLabel("外观与通知")
            SettingsGroup {
                SettingsRow(Icons.Outlined.DarkMode, "夜间模式", when (settings.themeMode) { ThemeMode.SYSTEM -> "跟随系统"; ThemeMode.DARK -> "深色"; ThemeMode.LIGHT -> "浅色" }) {
                    scope.launch { onTheme(if (settings.themeMode == ThemeMode.DARK) ThemeMode.SYSTEM else ThemeMode.DARK) }
                }
                SettingsDivider()
                SettingsRow(Icons.Outlined.NotificationsNone, "手机通知", trailing = {
                    Switch(settings.notificationsEnabled, { enabled ->
                        if (enabled && Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                            notificationRequested = true
                            permission.launch(Manifest.permission.POST_NOTIFICATIONS)
                        } else scope.launch { onNotifications(enabled); NotificationScheduler.setEnabled(context, enabled) }
                    })
                })
                if (settings.notificationsEnabled) {
                    SettingsDivider()
                    SettingsRow(Icons.Outlined.Sync, "后台补偿", "WorkManager · 最长约 15 分钟")
                    SettingsDivider()
                    SettingsRow(Icons.Outlined.Bolt, "实时 FCM", "未配置 Firebase 凭据")
                }
            }
            SettingsLabel("安全")
            SettingsGroup {
                SettingsRow(Icons.Outlined.Bolt, "重新配对", "清除本机设备令牌") { onDisconnect() }
            }
            Spacer(Modifier.height(36.dp))
        }
    }
}

@Composable private fun SettingsLabel(value: String) { Text(value, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 20.dp, bottom = 8.dp, start = 6.dp)) }

@Composable private fun SettingsGroup(content: @Composable () -> Unit) {
    Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.6f), RoundedCornerShape(22.dp)), content = { content() })
}

@Composable
private fun SettingsRow(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    title: String,
    value: String = "",
    trailing: (@Composable () -> Unit)? = null,
    onClick: (() -> Unit)? = null,
) {
    Row(
        Modifier.fillMaxWidth().then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier).padding(horizontal = 16.dp, vertical = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, Modifier.size(23.dp))
        Text(title, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(start = 14.dp).weight(1f))
        if (trailing != null) trailing()
        else if (value.isNotBlank()) Text(value, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable private fun SettingsDivider() { Spacer(Modifier.fillMaxWidth().padding(start = 54.dp).height(1.dp).background(MaterialTheme.colorScheme.outline.copy(alpha = 0.2f))) }
