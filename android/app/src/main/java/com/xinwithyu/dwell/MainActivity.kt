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
import com.xinwithyu.dwell.core.repository.DwellRepository
import com.xinwithyu.dwell.core.settings.ThemeMode
import com.xinwithyu.dwell.ui.DwellApp
import com.xinwithyu.dwell.ui.theme.DwellDarkBackground
import com.xinwithyu.dwell.ui.theme.DwellLightBackground
import com.xinwithyu.dwell.ui.theme.DwellTheme
import com.xinwithyu.dwell.worker.NotificationScheduler
import com.xinwithyu.dwell.worker.NotificationWorker
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private lateinit var repository: DwellRepository
    private var pendingRoute by mutableStateOf("")
    private var safeMode by mutableStateOf(false)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        CrashGuard.install(this)
        safeMode = CrashGuard.isSafeMode(this)
        enableEdgeToEdge()
        pendingRoute = intent?.getStringExtra(NotificationWorker.EXTRA_ROUTE).orEmpty()
        repository = DwellRepository.get(this)
        repository.start()
        lifecycleScope.launch {
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
            LaunchedEffect(settings.notificationsEnabled) {
                NotificationScheduler.setEnabled(this@MainActivity, settings.notificationsEnabled)
            }
            DwellTheme(settings.themeMode) {
                DwellApp(repository, pendingRoute, safeMode) { pendingRoute = "" }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        pendingRoute = intent.getStringExtra(NotificationWorker.EXTRA_ROUTE).orEmpty()
    }
}
