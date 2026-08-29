package com.xinwithyu.dwell.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import android.net.Uri
import com.xinwithyu.dwell.core.notification.NotificationRoute
import com.xinwithyu.dwell.core.repository.ConnectionState
import com.xinwithyu.dwell.core.repository.DwellRepository
import com.xinwithyu.dwell.ui.components.DwellNavigationDrawer
import com.xinwithyu.dwell.ui.screens.ChatScreen
import com.xinwithyu.dwell.ui.screens.ChatsScreen
import com.xinwithyu.dwell.ui.screens.LegacyFeatureScreen
import com.xinwithyu.dwell.ui.screens.PairingScreen
import com.xinwithyu.dwell.ui.screens.SettingsScreen
import com.xinwithyu.dwell.ui.screens.TaskDetailScreen
import com.xinwithyu.dwell.ui.screens.TaskRunScreen
import com.xinwithyu.dwell.ui.screens.TasksScreen

@Composable
fun DwellApp(repository: DwellRepository, pendingRoute: NotificationRoute? = null, safeMode: Boolean = false, dark: Boolean = false, onRouteConsumed: () -> Unit = {}) {
    val state by repository.state.collectAsStateWithLifecycle()
    val settings by repository.settings.collectAsStateWithLifecycle()
    val chats by repository.chats.collectAsStateWithLifecycle()
    val messages by repository.messages.collectAsStateWithLifecycle(initialValue = emptyList())
    val draft by repository.observeDraft(state.activeChatId).collectAsStateWithLifecycle(initialValue = null)

    if (state.connection == ConnectionState.NEEDS_PAIRING) {
        PairingScreen(settings, state.error, repository::pair)
        return
    }

    val nav = rememberNavController()
    val entry by nav.currentBackStackEntryAsState()
    val route = entry?.destination?.route.orEmpty()
    val rootRoute = route in setOf("chat", "chats", "tasks")

    LaunchedEffect(pendingRoute, state.connection) {
        val destination = pendingRoute ?: return@LaunchedEffect
        if (state.connection != ConnectionState.CONNECTED) return@LaunchedEffect
        when (destination) {
            is NotificationRoute.Chat -> {
                repository.openChat(destination.chatId)
                nav.navigate("chat") { launchSingleTop = true }
            }
            is NotificationRoute.Task -> {
                nav.navigate(
                    "task/${Uri.encode(destination.taskId)}/run/${Uri.encode(destination.runId)}",
                ) { launchSingleTop = true }
            }
        }
        onRouteConsumed()
    }

    DwellNavigationDrawer(
        selectedDestination = when {
            route.startsWith("legacy/") -> route.substringAfter("legacy/")
            route.startsWith("task") || route == "tasks" -> "tasks"
            else -> "chat"
        },
        onDestination = { destination ->
            when (destination) {
                "chat" -> nav.navigate("chats") { launchSingleTop = true }
                "tasks" -> nav.navigate("tasks") { launchSingleTop = true }
                else -> nav.navigate("legacy/$destination") { launchSingleTop = true }
            }
        },
        onSettings = { nav.navigate("settings") { launchSingleTop = true } },
        drawerRequest = 0,
        gesturesEnabled = rootRoute,
    ) { openDrawer ->
        NavHost(navController = nav, startDestination = "chat", modifier = Modifier) {
            composable("chat") {
                ChatScreen(
                    messages = messages,
                    activeChatId = state.activeChatId,
                    activeChatName = chats.find { it.id == state.activeChatId }?.name.orEmpty(),
                    busy = state.busy,
                    streamingText = state.streamingText,
                    streamingThought = state.streamingThought,
                    model = state.model,
                    webSearch = settings.webSearch,
                    error = state.error,
                    onMenu = openDrawer,
                    onNewChat = repository::prepareNewChat,
                    onOpenChats = { nav.navigate("chats") { launchSingleTop = true } },
                    onSettings = { nav.navigate("settings") { launchSingleTop = true } },
                    onRename = { repository.renameChat(state.activeChatId, it) },
                    onSend = { text, attachments -> repository.send(text, settings.webSearch, attachments) },
                    onStop = repository::stop,
                    onRegenerate = repository::regenerate,
                    onFeedback = repository::feedback,
                    onSelectModel = repository::selectModel,
                    onWebSearch = repository::updateWebSearch,
                    onDraftChanged = { repository.saveDraft(state.activeChatId, it) },
                    initialDraft = draft?.text.orEmpty(),
                )
            }
            composable("chats") {
                ChatsScreen(
                    chats = chats,
                    onMenu = openDrawer,
                    onOpen = { repository.openChat(it); nav.navigate("chat") { launchSingleTop = true } },
                    onNew = { repository.prepareNewChat(); nav.navigate("chat") { launchSingleTop = true } },
                    onArchive = repository::archiveChat,
                )
            }
            composable("tasks") { TasksScreen(openDrawer, { nav.navigate("task/$it") }, repository::loadTasks) }
            composable("task/{taskId}", arguments = listOf(navArgument("taskId") { type = NavType.StringType })) { backStack ->
                val taskId = backStack.arguments?.getString("taskId").orEmpty()
                TaskDetailScreen(
                    taskId = taskId,
                    onBack = { nav.popBackStack() },
                    onOpenRun = { nav.navigate("task/$taskId/run/$it") },
                    load = { repository.loadTask(taskId) },
                    action = { repository.taskAction(taskId, it) },
                )
            }
            composable(
                "task/{taskId}/run/{runId}",
                arguments = listOf(navArgument("taskId") { type = NavType.StringType }, navArgument("runId") { type = NavType.StringType }),
            ) { backStack ->
                val taskId = backStack.arguments?.getString("taskId").orEmpty()
                val runId = backStack.arguments?.getString("runId").orEmpty()
                TaskRunScreen(taskId, runId, { nav.popBackStack() }) { repository.loadTaskRun(taskId, runId) }
            }
            composable("settings") {
                SettingsScreen(
                    settings, state.connection, state.endpoint, state.backendVersion, state.pushStatus, safeMode,
                    onBack = { nav.popBackStack() },
                    onSaveConnection = repository::saveConnection,
                    onReconnect = repository::reconnect,
                    onTheme = repository::setTheme,
                    onNotifications = repository::setNotifications,
                    onDisconnect = repository::disconnect,
                )
            }
            composable("legacy/{feature}", arguments = listOf(navArgument("feature") { type = NavType.StringType })) { backStack ->
                LegacyFeatureScreen(
                    feature = backStack.arguments?.getString("feature").orEmpty(),
                    endpoint = state.endpoint,
                    deviceToken = repository.deviceTokenForLegacy(),
                    safeMode = safeMode,
                    dark = dark,
                    onBack = { nav.popBackStack() },
                )
            }
        }
    }
}
