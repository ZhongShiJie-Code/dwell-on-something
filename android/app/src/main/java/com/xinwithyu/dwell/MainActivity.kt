package com.xinwithyu.dwell

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import com.xinwithyu.dwell.core.diagnostics.CrashGuard
import com.xinwithyu.dwell.core.notification.NotificationRoute
import com.xinwithyu.dwell.core.notification.NotificationRouteParser
import com.xinwithyu.dwell.core.repository.DwellRepository
import com.xinwithyu.dwell.core.settings.ThemeMode
import com.xinwithyu.dwell.notification.DwellFcmRegistration
import com.xinwithyu.dwell.ui.DwellApp
import com.xinwithyu.dwell.ui.theme.DwellDarkBackground
import com.xinwithyu.dwell.ui.theme.DwellLightBackground
import com.xinwithyu.dwell.ui.theme.DwellTheme
import com.xinwithyu.dwell.worker.DwellNotifier
import com.xinwithyu.dwell.worker.NotificationScheduler
import com.xinwithyu.dwell.worker.NotificationWorker
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private const val NOTIFICATION_ROUTE_WAIT_ATTEMPTS = 120

class MainActivity : ComponentActivity() {
    private data class NotificationIntentCandidate(
        val route: NotificationRoute,
        val notificationEpoch: String,
        val pairedDeviceId: String,
        val notificationId: Long,
    )

    private lateinit var repository: DwellRepository
    private var pendingRoute by mutableStateOf<NotificationRoute?>(null)
    private var safeMode by mutableStateOf(false)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        CrashGuard.install(this)
        safeMode = CrashGuard.isSafeMode(this)
        enableEdgeToEdge()
        val notificationCandidate = parseNotificationIntent(intent)
        pendingRoute = null
        repository = DwellRepository.get(this)
        repository.start()
        lifecycleScope.launch {
            notificationCandidate?.let { awaitNotificationRoute(it) }
            delay(2 * 60 * 1000L)
            CrashGuard.markStable(this@MainActivity)
            safeMode = false
        }
        setContent {
            val settings by repository.settings.collectAsStateWithLifecycle()
            val systemDark = isSystemInDarkTheme()
            val dark = when (settings.themeMode) {
                ThemeMode.SYSTEM -> systemDark
                ThemeMode.LIGHT -> false
                ThemeMode.DARK -> true
            }
            val view = LocalView.current
            SideEffect {
                window.statusBarColor = (if (dark) DwellDarkBackground else DwellLightBackground).toArgb()
                window.navigationBarColor = (if (dark) DwellDarkBackground else DwellLightBackground).toArgb()
                WindowCompat.getInsetsController(window, view).apply {
                    isAppearanceLightStatusBars = !dark
                    isAppearanceLightNavigationBars = !dark
                }
            }
            val repositoryState by repository.state.collectAsStateWithLifecycle()
            LaunchedEffect(settings.notificationsEnabled, repositoryState.connection) {
                NotificationScheduler.setEnabled(this@MainActivity, settings.notificationsEnabled)
                if (settings.notificationsEnabled) DwellFcmRegistration.sync(this@MainActivity)
            }
            DwellTheme(settings.themeMode) {
                DwellApp(repository, pendingRoute, safeMode, dark) { pendingRoute = null }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        pendingRoute = null
        parseNotificationIntent(intent)?.let { lifecycleScope.launch { awaitNotificationRoute(it) } }
    }

    private suspend fun awaitNotificationRoute(candidate: NotificationIntentCandidate) {
        repeat(NOTIFICATION_ROUTE_WAIT_ATTEMPTS) {
            if (repository.validateNotificationIntent(
                    notificationEpoch = candidate.notificationEpoch,
                    pairedDeviceId = candidate.pairedDeviceId,
                    notificationId = candidate.notificationId,
                    route = candidate.route,
                )
            ) {
                pendingRoute = candidate.route
                return
            }
            delay(250L)
        }
    }

    private fun parseNotificationIntent(intent: Intent?): NotificationIntentCandidate? {
        val value = intent ?: return null
        val route = value.getStringExtra(NotificationWorker.EXTRA_ROUTE)
            ?.let(NotificationRouteParser::parse)
            ?: return null
        val notificationEpoch = value.getStringExtra(NotificationWorker.EXTRA_NOTIFICATION_EPOCH).orEmpty()
        val pairedDeviceId = value.getStringExtra(NotificationWorker.EXTRA_DEVICE_ID).orEmpty()
        val notificationId = value.getLongExtra(NotificationWorker.EXTRA_NOTIFICATION_ID, 0L)
        if (notificationEpoch.isBlank() || pairedDeviceId.isBlank() || notificationId <= 0L) return null
        if (value.action != DwellNotifier.notificationAction(notificationEpoch, pairedDeviceId, notificationId)) return null
        val data = value.data ?: return null
        if (data.scheme != "dwell" || data.host != "notification") return null
        if (data.pathSegments != listOf(notificationEpoch, pairedDeviceId, notificationId.toString())) return null
        return NotificationIntentCandidate(route, notificationEpoch, pairedDeviceId, notificationId)
    }
}
