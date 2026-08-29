package com.xinwithyu.dwell.notification

import com.google.firebase.FirebaseApp
import android.content.Context
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.xinwithyu.dwell.BuildConfig
import com.xinwithyu.dwell.core.model.NotificationDto
import com.xinwithyu.dwell.core.notification.NotificationSource
import com.xinwithyu.dwell.core.repository.DwellRepository
import com.xinwithyu.dwell.worker.FcmRegistrationScheduler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout

class DwellFirebaseMessagingService : FirebaseMessagingService() {

    override fun onMessageReceived(message: RemoteMessage) {
        if (!BuildConfig.DWELL_FCM_ENABLED) return
        val data = message.data
        val notificationId = data["notification_id"]?.toLongOrNull()?.takeIf { it > 0 } ?: return
        val epoch = data["notification_epoch"].orEmpty()
        val deviceId = data["device_id"].orEmpty()
        val kind = data["kind"].orEmpty()
        val route = data["route"].orEmpty()
        if (epoch.isBlank() || deviceId.isBlank() || kind.isBlank() || route.isBlank()) return

        runBlocking(Dispatchers.IO) {
            runCatching {
                withTimeout(8_000L) {
                    val repository = DwellRepository.get(applicationContext)
                    repository.handleIncomingNotification(
                        NotificationDto(
                            id = notificationId,
                            kind = kind,
                            title = data["title"].orEmpty(),
                            body = data["body"].orEmpty(),
                            at = data["at"]?.toLongOrNull() ?: 0L,
                            route = route,
                            notificationEpoch = epoch,
                            deviceId = deviceId,
                            notificationId = notificationId,
                        ),
                        NotificationSource.FCM,
                        preserveLive = true,
                    )
                }
            }
        }
    }

    override fun onNewToken(token: String) {
        if (!BuildConfig.DWELL_FCM_ENABLED || token.isBlank()) return
        runBlocking(Dispatchers.IO) {
            val result = runCatching {
                withTimeout(15_000L) {
                    DwellRepository.get(applicationContext).registerPushToken(token, firebaseAppId())
                }
            }.getOrNull()
            if (result == null || result.isFailure) {
                FcmRegistrationScheduler.enqueue(applicationContext)
            }
        }
    }

    private fun firebaseAppId(): String = currentFirebaseAppId()

    companion object {
        fun currentFirebaseAppId(): String = runCatching {
            FirebaseApp.getInstance().options.applicationId
        }.getOrDefault("")
    }
}

object DwellFcmRegistration {
    fun sync(context: Context) {
        if (!BuildConfig.DWELL_FCM_ENABLED) return
        val appContext = context.applicationContext
        val task = runCatching { FirebaseMessaging.getInstance().token }
            .getOrElse {
                recordError(appContext, "token_unavailable")
                FcmRegistrationScheduler.enqueue(appContext)
                return
            }
        task.addOnSuccessListener { token ->
            if (token.isBlank()) {
                recordError(appContext, "token_empty")
                FcmRegistrationScheduler.enqueue(appContext)
                return@addOnSuccessListener
            }
            CoroutineScope(Dispatchers.IO).launch {
                val result = DwellRepository.get(appContext).registerPushToken(
                    token,
                    DwellFirebaseMessagingService.currentFirebaseAppId(),
                )
                if (result.isFailure) FcmRegistrationScheduler.enqueue(appContext)
            }
        }.addOnFailureListener {
            recordError(appContext, "token_unavailable")
            FcmRegistrationScheduler.enqueue(appContext)
        }
    }

    private fun recordError(context: Context, errorCode: String) {
        CoroutineScope(Dispatchers.IO).launch {
            DwellRepository.get(context).notificationCoordinator.saveRegistration(
                state = "error",
                errorCode = errorCode,
            )
        }
    }
}
