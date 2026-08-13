package com.xinwithyu.dwell.worker

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.xinwithyu.dwell.MainActivity
import com.xinwithyu.dwell.R
import com.xinwithyu.dwell.core.repository.DwellRepository
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.flow.first

class NotificationWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val repository = DwellRepository.get(applicationContext)
        val settings = repository.settingsStore.settings.first()
        if (!settings.notificationsEnabled) return Result.success()
        val response = repository.notifications(settings.notificationCursor).getOrElse { return Result.retry() }
        if (settings.notificationCursor > 0) response.items.takeLast(3).forEach { item ->
            DwellNotifier.show(applicationContext, item.title, item.body, item.id, item.route)
        }
        repository.settingsStore.setNotificationCursor(maxOf(settings.notificationCursor, response.next))
        return Result.success()
    }

    companion object {
        const val EXTRA_ROUTE = "dwell-notification-route"
    }
}

object DwellNotifier {
    private const val CHANNEL_ID = "dwell-messages-v2"

    fun show(context: Context, title: String, body: String, id: Long, route: String) {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Dwell 消息与任务", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "Mac 有新回复或定时任务完成时提醒"
            },
        )
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra(NotificationWorker.EXTRA_ROUTE, route)
        }
        val pending = PendingIntent.getActivity(context, (id and 0x7fffffff).toInt(), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        manager.notify(
            (id and 0x7fffffff).toInt(),
            NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(title.ifBlank { "Dwell" })
                .setContentText(body.ifBlank { "有新消息" })
                .setStyle(NotificationCompat.BigTextStyle().bigText(body))
                .setAutoCancel(true)
                .setContentIntent(pending)
                .build(),
        )
    }
}

object NotificationScheduler {
    private const val PERIODIC = "dwell-notification-sync"
    private const val IMMEDIATE = "dwell-notification-now"
    private val constraints = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

    fun setEnabled(context: Context, enabled: Boolean) {
        val manager = WorkManager.getInstance(context)
        if (!enabled) {
            manager.cancelUniqueWork(PERIODIC)
            manager.cancelUniqueWork(IMMEDIATE)
            return
        }
        val periodic = PeriodicWorkRequestBuilder<NotificationWorker>(15, TimeUnit.MINUTES)
            .setConstraints(constraints).build()
        manager.enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.UPDATE, periodic)
        pollNow(context)
    }

    fun pollNow(context: Context) {
        WorkManager.getInstance(context).enqueueUniqueWork(
            IMMEDIATE,
            ExistingWorkPolicy.REPLACE,
            OneTimeWorkRequestBuilder<NotificationWorker>().setConstraints(constraints).build(),
        )
    }
}
