package com.xinwithyu.dwell.worker

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
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
import com.xinwithyu.dwell.core.model.NotificationDto
import com.xinwithyu.dwell.core.notification.NotificationCoordinator
import com.xinwithyu.dwell.core.notification.NotificationRoute
import com.xinwithyu.dwell.core.repository.DwellRepository
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

class NotificationWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val repository = DwellRepository.get(applicationContext)
        repository.notificationCoordinator.recoverLeasesAndCleanup()
        return repository.syncNotifications().fold(
            onSuccess = { Result.success() },
            onFailure = { Result.retry() },
        )
    }

    companion object {
        const val EXTRA_ROUTE = "dwell-notification-route"
        const val EXTRA_NOTIFICATION_EPOCH = "dwell-notification-epoch"
        const val EXTRA_DEVICE_ID = "dwell-notification-device-id"
        const val EXTRA_NOTIFICATION_ID = "dwell-notification-id"
    }
}

object DwellNotifier {
    private const val CHANNEL_ID = "dwell-messages-v2"
    const val NOTIFICATION_ACTION_PREFIX = "com.xinwithyu.dwell.NOTIFICATION"

    fun notificationAction(notificationEpoch: String, pairedDeviceId: String, notificationId: Long): String =
        "$NOTIFICATION_ACTION_PREFIX.$notificationEpoch|$pairedDeviceId|$notificationId"

    fun show(
        context: Context,
        notification: NotificationDto,
        route: NotificationRoute,
        notificationEpoch: String,
        pairedDeviceId: String,
    ): Boolean {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.POST_NOTIFICATIONS,
            ) != PackageManager.PERMISSION_GRANTED
        ) return false
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return false
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Claude Cli 通知", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "Claude Cli 有新回复或定时任务完成时提醒"
            },
        )

        val stableIdentity = "$notificationEpoch|$pairedDeviceId|${notification.notificationId}"
        val foldedId = stableNotificationId(stableIdentity)
        val intent = Intent(context, MainActivity::class.java).apply {
            action = notificationAction(notificationEpoch, pairedDeviceId, notification.notificationId)
            data = Uri.parse("dwell://notification/${Uri.encode(notificationEpoch)}/${Uri.encode(pairedDeviceId)}/${notification.notificationId}")
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra(NotificationWorker.EXTRA_ROUTE, route.raw)
            putExtra(NotificationWorker.EXTRA_NOTIFICATION_EPOCH, notificationEpoch)
            putExtra(NotificationWorker.EXTRA_DEVICE_ID, pairedDeviceId)
            putExtra(NotificationWorker.EXTRA_NOTIFICATION_ID, notification.notificationId)
        }
        val pending = PendingIntent.getActivity(
            context,
            foldedId,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val body = notification.body.ifBlank { "回答已完成" }
        val publicVersion = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Claude Cli")
            .setContentText("有新通知")
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .build()
        manager.notify(
            stableIdentity,
            foldedId,
            NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle("Claude Cli")
                .setContentText(body)
                .setStyle(NotificationCompat.BigTextStyle().bigText(body))
                .setAutoCancel(true)
                .setOnlyAlertOnce(true)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                .setPublicVersion(publicVersion)
                .setContentIntent(pending)
                .build(),
        )
        return true
    }

    private fun stableNotificationId(identity: String): Int {
        val digest = MessageDigest.getInstance("SHA-256").digest(identity.toByteArray(Charsets.UTF_8))
        val value = ByteBuffer.wrap(digest, 0, Int.SIZE_BYTES).int and Int.MAX_VALUE
        return if (value == 0) 1 else value
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
