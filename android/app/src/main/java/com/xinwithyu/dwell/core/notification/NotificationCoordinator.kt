package com.xinwithyu.dwell.core.notification

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import com.xinwithyu.dwell.core.model.NotificationBaselineResponse
import com.xinwithyu.dwell.core.model.NotificationDto
import com.xinwithyu.dwell.core.model.NotificationResponse
import com.xinwithyu.dwell.worker.DwellNotifier
import java.util.UUID
import kotlinx.coroutines.CancellationException

const val NOTIFICATION_LEASE_MILLIS = 120_000L
private const val TERMINAL_RECEIPT_RETENTION_MILLIS = 30L * 24L * 60L * 60L * 1000L
private const val MAX_NOTIFICATION_SYNC_PAGES = 20
private const val NOTIFICATION_PAGE_SIZE = 100
private const val PENDING_DRAIN_LIMIT = 100

enum class NotificationSource { FCM, SSE, REST }

enum class NotificationProcessStatus {
    PRESENTED,
    SUPPRESSED,
    DUPLICATE,
    REJECTED,
    IGNORED,
    /** Presentation failed in a way that should be retried without moving the REST cursor. */
    RETRYABLE,
    /** A live FCM payload was durably staged while the scope is not initialized. */
    QUEUED,
}

data class NotificationProcessResult(
    val status: NotificationProcessStatus,
    val reason: String = "",
    val retryable: Boolean = false,
)

data class RestPageResult(
    val processed: Boolean,
    val nextCursor: Long,
    val hasMore: Boolean,
)

data class PendingDrainResult(
    val completed: Boolean,
    val retryable: Boolean,
)

/** The only presentation seam needed by coordinator tests. */
fun interface NotificationPresenter {
    fun show(
        notification: NotificationDto,
        route: NotificationRoute,
        notificationEpoch: String,
        pairedDeviceId: String,
    ): Boolean
}

/** A narrow API seam for baseline and paginated notification tests. */
interface NotificationApi {
    suspend fun baseline(): NotificationBaselineResponse
    suspend fun notifications(since: Long, limit: Int): NotificationResponse
}

/**
 * Owns baseline acquisition and REST pagination without knowing about Android or DwellApi.
 * A failed or invalid baseline never creates a usable scope. Pending receipts are drained
 * before the REST cursor is allowed to move.
 */
class NotificationSyncEngine(
    private val coordinator: NotificationCoordinator,
    private val api: NotificationApi,
    private val notificationsEnabled: () -> Boolean,
    private val permissionGranted: () -> Boolean = { true },
) {
    suspend fun sync(): Result<Unit> = runCatching {
        val enabled = notificationsEnabled()
        val baseline = api.baseline()
        if (!baseline.ok || baseline.notificationEpoch.isBlank() || baseline.deviceId.isBlank() || baseline.latest < 0L) {
            throw IllegalStateException("通知 baseline 无效")
        }
        coordinator.configureScope(
            notificationEpoch = baseline.notificationEpoch,
            pairedDeviceId = baseline.deviceId,
            baselineLatest = baseline.latest,
        )

        val pending = coordinator.drainPending(
            notificationsEnabled = enabled,
            permissionGranted = permissionGranted(),
        )
        if (!pending.completed) throw IllegalStateException("通知待发送队列未处理完成")

        repeat(MAX_NOTIFICATION_SYNC_PAGES) {
            val scope = coordinator.scope() ?: throw IllegalStateException("通知作用域未初始化")
            if (!scope.cursorInitialized) throw IllegalStateException("通知作用域未初始化")
            val response = api.notifications(scope.restCursor, NOTIFICATION_PAGE_SIZE)
            val page = coordinator.processRestPage(
                response = response,
                notificationsEnabled = enabled,
                permissionGranted = permissionGranted(),
            )
            if (!page.processed) throw IllegalStateException("通知页未处理完成")
            if (!page.hasMore) return@runCatching Unit
            if (page.nextCursor <= scope.restCursor) throw IllegalStateException("通知游标未前进")
        }
        throw IllegalStateException("通知积压超过单次同步上限")
    }
}

class NotificationCoordinator(
    private val store: NotificationReceiptStore,
    private val presenter: NotificationPresenter,
    private val now: () -> Long = { System.currentTimeMillis() },
    private val permissionGranted: () -> Boolean = { true },
) {
    constructor(context: Context) : this(
        store = NotificationReceiptDatabase.get(context.applicationContext).dao(),
        presenter = NotificationPresenter { notification, route, notificationEpoch, pairedDeviceId ->
            DwellNotifier.show(
                context = context.applicationContext,
                notification = notification,
                route = route,
                notificationEpoch = notificationEpoch,
                pairedDeviceId = pairedDeviceId,
            )
        },
        permissionGranted = { hasNotificationPermission(context.applicationContext) },
    )

    /** Record the identity discovered by bootstrap, but keep the cursor unusable. */
    suspend fun rememberUninitializedScope(notificationEpoch: String, pairedDeviceId: String) {
        val epoch = notificationEpoch.trim()
        val deviceId = pairedDeviceId.trim()
        require(epoch.isNotBlank()) { "通知 epoch 无效" }
        require(deviceId.isNotBlank()) { "通知设备无效" }
        store.rememberUninitializedScope(epoch, deviceId, now())
    }

    /**
     * Persist a successful baseline atomically with the scope. A zero baseline is valid;
     * cursorInitialized is the separate persisted fact that distinguishes it from failure.
     */
    suspend fun configureScope(notificationEpoch: String, pairedDeviceId: String, baselineLatest: Long) {
        val epoch = notificationEpoch.trim()
        val deviceId = pairedDeviceId.trim()
        require(epoch.isNotBlank()) { "通知 epoch 无效" }
        require(deviceId.isNotBlank()) { "通知设备无效" }
        require(baselineLatest >= 0L) { "通知 baseline 无效" }
        check(store.initializeScope(epoch, deviceId, baselineLatest, now())) { "通知作用域已变化" }
    }

    suspend fun scope(): NotificationScopeEntity? = store.scope()

    suspend fun receipt(epoch: String, deviceId: String, notificationId: Long): NotificationReceiptEntity? =
        store.receipt(epoch, deviceId, notificationId)

    suspend fun cursor(): Long = store.scope()
        ?.takeIf { it.cursorInitialized }
        ?.restCursor
        ?: 0L

    suspend fun recoverLeasesAndCleanup(now: Long = this.now()) {
        store.recoverExpiredLeases(now, now)
        val scope = store.scope()?.takeIf { it.cursorInitialized } ?: return
        store.deleteOldTerminalReceipts(
            epoch = scope.notificationEpoch,
            deviceId = scope.pairedDeviceId,
            restCursor = scope.restCursor,
            before = now - TERMINAL_RECEIPT_RETENTION_MILLIS,
        )
    }

    /**
     * Accept one payload. FCM callers set preserveLive so the payload can initialize an
     * uninitialized scope and remain pending until baseline acquisition succeeds.
     */
    suspend fun accept(
        notification: NotificationDto,
        source: NotificationSource,
        notificationsEnabled: Boolean,
        permissionGranted: Boolean = this.permissionGranted(),
        preserveLive: Boolean = false,
    ): NotificationProcessResult {
        val notificationId = notification.notificationId.takeIf { it > 0 } ?: notification.id
        if (notificationId <= 0L) return NotificationProcessResult(NotificationProcessStatus.REJECTED, "invalid_notification_id")

        val currentScope = store.scope()
        val liveFcm = source == NotificationSource.FCM && preserveLive
        if (currentScope == null || !currentScope.cursorInitialized) {
            return if (liveFcm) stageLiveFcm(notification, notificationId, notificationsEnabled, permissionGranted)
            else NotificationProcessResult(NotificationProcessStatus.IGNORED, if (currentScope == null) "scope_unconfigured" else "scope_uninitialized")
        }
        if (notification.notificationEpoch != currentScope.notificationEpoch || notification.deviceId != currentScope.pairedDeviceId) {
            if (liveFcm) {
                rememberUninitializedScope(notification.notificationEpoch, notification.deviceId)
                return stageLiveFcm(notification, notificationId, notificationsEnabled, permissionGranted)
            }
            return NotificationProcessResult(NotificationProcessStatus.IGNORED, "scope_mismatch")
        }

        val existing = store.receipt(currentScope.notificationEpoch, currentScope.pairedDeviceId, notificationId)
        if (existing != null) {
            val expiredPresenting = existing.state == RECEIPT_PRESENTING &&
                (existing.leaseUntil == null || existing.leaseUntil <= now())
            return when {
                existing.state == RECEIPT_PENDING || expiredPresenting ->
                    processReceipt(existing, currentScope, notificationsEnabled, permissionGranted)
                existing.state == RECEIPT_PRESENTING -> NotificationProcessResult(
                    status = NotificationProcessStatus.DUPLICATE,
                    reason = existing.state,
                    retryable = true,
                )
                else -> NotificationProcessResult(
                    status = NotificationProcessStatus.DUPLICATE,
                    reason = existing.state,
                )
            }
        }

        val timestamp = now()
        if (source != NotificationSource.REST && !liveFcm && notificationId <= currentScope.baselineLatest) {
            val inserted = store.insertReceipt(
                receiptFor(notification, currentScope, notificationId, RECEIPT_IGNORED_BASELINE, timestamp, source),
            )
            return if (inserted == -1L) {
                NotificationProcessResult(NotificationProcessStatus.DUPLICATE, RECEIPT_IGNORED_BASELINE)
            } else {
                NotificationProcessResult(NotificationProcessStatus.IGNORED, RECEIPT_IGNORED_BASELINE)
            }
        }

        val route = NotificationRouteParser.parse(notification.route, notification.kind)
        val initialState = if (route == null) RECEIPT_REJECTED_INVALID else RECEIPT_PENDING
        val receipt = receiptFor(notification, currentScope, notificationId, initialState, timestamp, source)
        val inserted = store.insertReceipt(receipt)
        if (inserted == -1L) {
            val raced = store.receipt(currentScope.notificationEpoch, currentScope.pairedDeviceId, notificationId)
            return if (raced?.state == RECEIPT_PENDING) {
                processReceipt(raced, currentScope, notificationsEnabled, permissionGranted)
            } else {
                NotificationProcessResult(
                    NotificationProcessStatus.DUPLICATE,
                    raced?.state.orEmpty(),
                    retryable = raced?.state == RECEIPT_PRESENTING,
                )
            }
        }
        if (route == null) return NotificationProcessResult(NotificationProcessStatus.REJECTED, "invalid_route")
        return processReceipt(receipt, currentScope, notificationsEnabled, permissionGranted)
    }

    private suspend fun stageLiveFcm(
        notification: NotificationDto,
        notificationId: Long,
        notificationsEnabled: Boolean,
        permissionGranted: Boolean,
    ): NotificationProcessResult {
        val epoch = notification.notificationEpoch.trim()
        val deviceId = notification.deviceId.trim()
        if (epoch.isBlank() || deviceId.isBlank()) return NotificationProcessResult(NotificationProcessStatus.IGNORED, "scope_mismatch")

        val timestamp = now()
        val route = NotificationRouteParser.parse(notification.route, notification.kind)
        val initialState = if (route == null) RECEIPT_REJECTED_INVALID else RECEIPT_PENDING
        val staged = store.stageFcmReceipt(
            receiptFor(
                notification = notification,
                scope = NotificationScopeEntity(
                    notificationEpoch = epoch,
                    pairedDeviceId = deviceId,
                    restCursor = 0L,
                    baselineLatest = 0L,
                    cursorInitialized = false,
                    updatedAt = timestamp,
                ),
                notificationId = notificationId,
                state = initialState,
                timestamp = timestamp,
                source = NotificationSource.FCM,
            ),
            timestamp,
        )
        if (staged.status == FcmStageStatus.SCOPE_MISMATCH) {
            return NotificationProcessResult(NotificationProcessStatus.IGNORED, "scope_mismatch")
        }
        val scope = store.scope()
        val receipt = staged.receipt
        if (receipt == null) return NotificationProcessResult(NotificationProcessStatus.DUPLICATE, "")
        if (receipt.state != RECEIPT_PENDING) return NotificationProcessResult(NotificationProcessStatus.REJECTED, "invalid_route")
        if (scope == null || !scope.cursorInitialized) {
            return NotificationProcessResult(NotificationProcessStatus.QUEUED, "scope_uninitialized")
        }
        return processReceipt(receipt, scope, notificationsEnabled, permissionGranted)
    }

    private fun receiptFor(
        notification: NotificationDto,
        scope: NotificationScopeEntity,
        notificationId: Long,
        state: String,
        timestamp: Long,
        source: NotificationSource,
    ) = NotificationReceiptEntity(
        notificationEpoch = scope.notificationEpoch,
        pairedDeviceId = scope.pairedDeviceId,
        notificationId = notificationId,
        kind = notification.kind,
        title = notification.title.take(64),
        body = notification.body.take(64),
        at = notification.at,
        route = notification.route,
        source = source.name.lowercase(),
        state = state,
        createdAt = timestamp,
        updatedAt = timestamp,
    )

    private fun NotificationReceiptEntity.toNotificationDto() = NotificationDto(
        id = notificationId,
        notificationId = notificationId,
        kind = kind,
        title = title,
        body = body,
        at = at,
        route = route,
        notificationEpoch = notificationEpoch,
        deviceId = pairedDeviceId,
    )

    private suspend fun processReceipt(
        receipt: NotificationReceiptEntity,
        scope: NotificationScopeEntity,
        notificationsEnabled: Boolean,
        permissionGranted: Boolean,
    ): NotificationProcessResult {
        val workReceipt = if (receipt.state == RECEIPT_PRESENTING &&
            (receipt.leaseUntil == null || receipt.leaseUntil <= now())
        ) {
            store.transitionPending(
                scope.notificationEpoch,
                scope.pairedDeviceId,
                receipt.notificationId,
                RECEIPT_PRESENTING,
                RECEIPT_PENDING,
                now(),
            )
            store.receipt(scope.notificationEpoch, scope.pairedDeviceId, receipt.notificationId)
                ?: receipt.copy(state = RECEIPT_PENDING, leaseToken = null, leaseUntil = null)
        } else {
            receipt
        }
        val route = NotificationRouteParser.parse(workReceipt.route, workReceipt.kind)
        if (route == null) {
            store.transitionPending(
                scope.notificationEpoch,
                scope.pairedDeviceId,
                workReceipt.notificationId,
                RECEIPT_PENDING,
                RECEIPT_REJECTED_INVALID,
                now(),
            )
            return NotificationProcessResult(NotificationProcessStatus.REJECTED, "invalid_route")
        }
        if (!notificationsEnabled) {
            store.transitionPending(
                scope.notificationEpoch,
                scope.pairedDeviceId,
                workReceipt.notificationId,
                RECEIPT_PENDING,
                RECEIPT_SUPPRESSED_DISABLED,
                now(),
            )
            return NotificationProcessResult(NotificationProcessStatus.SUPPRESSED, RECEIPT_SUPPRESSED_DISABLED)
        }
        if (!permissionGranted) {
            store.transitionPending(
                scope.notificationEpoch,
                scope.pairedDeviceId,
                workReceipt.notificationId,
                RECEIPT_PENDING,
                RECEIPT_SUPPRESSED_PERMISSION,
                now(),
            )
            return NotificationProcessResult(NotificationProcessStatus.SUPPRESSED, RECEIPT_SUPPRESSED_PERMISSION)
        }

        val leaseToken = UUID.randomUUID().toString()
        val claimNow = now()
        val claimed = store.claimForPresentation(
            epoch = scope.notificationEpoch,
            deviceId = scope.pairedDeviceId,
            notificationId = workReceipt.notificationId,
            state = RECEIPT_PRESENTING,
            leaseToken = leaseToken,
            leaseUntil = claimNow + NOTIFICATION_LEASE_MILLIS,
            now = claimNow,
            updatedAt = claimNow,
        )
        if (claimed == 0) {
            return NotificationProcessResult(
                NotificationProcessStatus.RETRYABLE,
                "presentation_claim_lost",
                retryable = true,
            )
        }

        val shown = try {
            presenter.show(
                notification = workReceipt.toNotificationDto(),
                route = route,
                notificationEpoch = scope.notificationEpoch,
                pairedDeviceId = scope.pairedDeviceId,
            )
        } catch (error: CancellationException) {
            throw error
        } catch (_: Throwable) {
            false
        }
        return if (shown) {
            val marked = store.markPresented(
                scope.notificationEpoch,
                scope.pairedDeviceId,
                workReceipt.notificationId,
                leaseToken,
                now(),
            )
            if (marked == 1) {
                NotificationProcessResult(NotificationProcessStatus.PRESENTED)
            } else {
                NotificationProcessResult(
                    NotificationProcessStatus.RETRYABLE,
                    "presentation_fence_lost",
                    retryable = true,
                )
            }
        } else {
            store.releasePresentation(
                scope.notificationEpoch,
                scope.pairedDeviceId,
                workReceipt.notificationId,
                leaseToken,
                now(),
            )
            NotificationProcessResult(
                NotificationProcessStatus.RETRYABLE,
                "notification_manager_unavailable",
                retryable = true,
            )
        }
    }

    /** Drain durable pending receipts before REST is allowed to advance its cursor. */
    suspend fun drainPending(
        notificationsEnabled: Boolean,
        permissionGranted: Boolean = this.permissionGranted(),
        limit: Int = PENDING_DRAIN_LIMIT,
    ): PendingDrainResult {
        val scope = store.scope() ?: return PendingDrainResult(completed = false, retryable = false)
        if (!scope.cursorInitialized) return PendingDrainResult(completed = false, retryable = false)
        val pending = store.pendingReceipts(scope.notificationEpoch, scope.pairedDeviceId, limit)
        for (receipt in pending) {
            val result = processReceipt(receipt, scope, notificationsEnabled, permissionGranted)
            if (result.retryable) return PendingDrainResult(completed = false, retryable = true)
        }
        return PendingDrainResult(completed = pending.size < limit, retryable = false)
    }

    suspend fun processRestPage(
        response: NotificationResponse,
        notificationsEnabled: Boolean,
        permissionGranted: Boolean = this.permissionGranted(),
    ): RestPageResult {
        val scope = store.scope() ?: return RestPageResult(false, 0L, false)
        if (!response.ok || !scope.cursorInitialized || response.notificationEpoch != scope.notificationEpoch) {
            return RestPageResult(false, scope.restCursor, response.hasMore)
        }
        for (item in response.items) {
            if ((item.notificationEpoch.isNotBlank() && item.notificationEpoch != scope.notificationEpoch) ||
                (item.deviceId.isNotBlank() && item.deviceId != scope.pairedDeviceId)
            ) {
                return RestPageResult(false, scope.restCursor, response.hasMore)
            }
            val normalized = item.copy(
                notificationEpoch = item.notificationEpoch.ifBlank { scope.notificationEpoch },
                deviceId = item.deviceId.ifBlank { scope.pairedDeviceId },
            )
            val result = accept(
                notification = normalized,
                source = NotificationSource.REST,
                notificationsEnabled = notificationsEnabled,
                permissionGranted = permissionGranted,
            )
            if (result.retryable || result.status == NotificationProcessStatus.RETRYABLE ||
                (result.status == NotificationProcessStatus.IGNORED && result.reason == "scope_mismatch")
            ) {
                return RestPageResult(false, scope.restCursor, response.hasMore)
            }
        }
        val next = maxOf(scope.restCursor, response.next)
        if (next > scope.restCursor) {
            store.advanceRestCursor(scope.notificationEpoch, scope.pairedDeviceId, next, now())
        }
        return RestPageResult(true, next, response.hasMore)
    }

    suspend fun saveRegistration(state: String, tokenHash: String = "", errorCode: String = "", registeredAt: Long = 0L) {
        store.saveRegistration(
            NotificationRegistrationEntity(
                state = state,
                tokenHash = tokenHash,
                lastErrorCode = errorCode,
                lastRegisteredAt = registeredAt,
                updatedAt = now(),
            ),
        )
    }

    suspend fun registration(): NotificationRegistrationEntity? = store.registration()

    companion object {
        fun hasNotificationPermission(context: Context): Boolean =
            Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.POST_NOTIFICATIONS,
            ) == PackageManager.PERMISSION_GRANTED
    }
}
