package com.xinwithyu.dwell.core.diagnostics

import android.content.Context
import java.util.concurrent.atomic.AtomicBoolean

/** Detects a short crash loop without recording message text, tokens, or request bodies. */
object CrashGuard {
    private const val PREFS = "dwell-crash-guard"
    private const val KEY_TIMES = "crash-times"
    private const val KEY_SAFE = "safe-mode"
    private const val WINDOW_MS = 2 * 60 * 1000L
    private val installed = AtomicBoolean(false)

    fun install(context: Context) {
        val app = context.applicationContext
        val prefs = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val recent = recentTimes(prefs.getString(KEY_TIMES, "").orEmpty())
        if (recent.size >= 3) prefs.edit().putBoolean(KEY_SAFE, true).apply()
        if (!installed.compareAndSet(false, true)) return
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
            runCatching {
                val values = (recentTimes(prefs.getString(KEY_TIMES, "").orEmpty()) + System.currentTimeMillis()).takeLast(6)
                prefs.edit().putString(KEY_TIMES, values.joinToString(",")).putBoolean(KEY_SAFE, values.size >= 3).commit()
            }
            previous?.uncaughtException(thread, throwable)
        }
    }

    fun isSafeMode(context: Context): Boolean = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_SAFE, false)

    fun markStable(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(KEY_TIMES).putBoolean(KEY_SAFE, false).apply()
    }

    private fun recentTimes(raw: String): List<Long> {
        val cutoff = System.currentTimeMillis() - WINDOW_MS
        return raw.split(',').mapNotNull(String::toLongOrNull).filter { it >= cutoff }
    }
}
