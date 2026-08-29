package com.xinwithyu.dwell.worker

import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.google.android.gms.tasks.Tasks
import com.google.firebase.messaging.FirebaseMessaging
import com.xinwithyu.dwell.BuildConfig
import com.xinwithyu.dwell.notification.DwellFirebaseMessagingService
import com.xinwithyu.dwell.core.repository.DwellRepository
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class FcmRegistrationWorker(
    context: android.content.Context,
    params: WorkerParameters,
) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        if (!BuildConfig.DWELL_FCM_ENABLED) return Result.success()

        val repository = DwellRepository.get(applicationContext)
        if (runAttemptCount >= MAX_ATTEMPTS) {
            repository.notificationCoordinator.saveRegistration(
                state = "error",
                errorCode = "token_retry_exhausted",
            )
            return Result.failure()
        }

        val token = runCatching {
            withContext(Dispatchers.IO) {
                Tasks.await(FirebaseMessaging.getInstance().token, TOKEN_TIMEOUT_MILLIS, TimeUnit.MILLISECONDS)
            }
        }.getOrElse { error ->
            repository.notificationCoordinator.saveRegistration(
                state = "error",
                errorCode = tokenErrorCode(error),
            )
            return if (runAttemptCount + 1 >= MAX_ATTEMPTS) Result.failure() else Result.retry()
        }

        val result = repository.registerPushToken(
            fcmToken = token,
            firebaseAppId = DwellFirebaseMessagingService.currentFirebaseAppId(),
        )
        return if (result.isSuccess) {
            Result.success()
        } else if (runAttemptCount + 1 >= MAX_ATTEMPTS) {
            Result.failure()
        } else {
            Result.retry()
        }
    }

    private fun tokenErrorCode(error: Throwable): String =
        if (error is java.util.concurrent.TimeoutException) "token_timeout" else "token_unavailable"

    companion object {
        private const val MAX_ATTEMPTS = 5
        private const val TOKEN_TIMEOUT_MILLIS = 15_000L
    }
}

object FcmRegistrationScheduler {
    private const val UNIQUE_WORK = "dwell-fcm-registration-retry"
    private val constraints = Constraints.Builder()
        .setRequiredNetworkType(NetworkType.CONNECTED)
        .build()

    fun enqueue(context: android.content.Context) {
        val request = OneTimeWorkRequestBuilder<FcmRegistrationWorker>()
            .setConstraints(constraints)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30L, TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(context.applicationContext).enqueueUniqueWork(
            UNIQUE_WORK,
            ExistingWorkPolicy.KEEP,
            request,
        )
    }
}
