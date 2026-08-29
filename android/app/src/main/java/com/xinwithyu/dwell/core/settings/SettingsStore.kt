package com.xinwithyu.dwell.core.settings

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

private val Context.dwellDataStore by preferencesDataStore(name = "dwell-settings-v2")

enum class ThemeMode { SYSTEM, LIGHT, DARK }

data class AppSettings(
    val localUrl: String = "http://192.168.1.10:8787",
    val remoteUrl: String = "",
    val preferRemote: Boolean = false,
    val themeMode: ThemeMode = ThemeMode.SYSTEM,
    val notificationsEnabled: Boolean = false,
    val webSearch: Boolean = false,
)

class SettingsStore(private val context: Context) {
    private object Keys {
        val localUrl = stringPreferencesKey("local-url")
        val remoteUrl = stringPreferencesKey("remote-url")
        val preferRemote = booleanPreferencesKey("prefer-remote")
        val themeMode = stringPreferencesKey("theme-mode")
        val notifications = booleanPreferencesKey("notifications-enabled")
        val webSearch = booleanPreferencesKey("web-search")
    }

    val settings: Flow<AppSettings> = context.dwellDataStore.data.map { values ->
        AppSettings(
            localUrl = values[Keys.localUrl].orEmpty().ifBlank { "http://192.168.1.10:8787" },
            remoteUrl = values[Keys.remoteUrl].orEmpty(),
            preferRemote = values[Keys.preferRemote] ?: false,
            themeMode = runCatching { ThemeMode.valueOf(values[Keys.themeMode] ?: ThemeMode.SYSTEM.name) }.getOrDefault(ThemeMode.SYSTEM),
            notificationsEnabled = values[Keys.notifications] ?: false,
            webSearch = values[Keys.webSearch] ?: false,
        )
    }

    suspend fun saveConnection(localUrl: String, remoteUrl: String, preferRemote: Boolean) {
        context.dwellDataStore.edit {
            it[Keys.localUrl] = normalize(localUrl)
            it[Keys.remoteUrl] = normalize(remoteUrl)
            it[Keys.preferRemote] = preferRemote
        }
    }

    suspend fun setTheme(mode: ThemeMode) {
        context.dwellDataStore.edit { it[Keys.themeMode] = mode.name }
    }

    suspend fun setNotifications(enabled: Boolean) {
        context.dwellDataStore.edit { it[Keys.notifications] = enabled }
    }

    suspend fun setWebSearch(enabled: Boolean) {
        context.dwellDataStore.edit { it[Keys.webSearch] = enabled }
    }

    private fun normalize(value: String): String = value.trim().trimEnd('/')
}
