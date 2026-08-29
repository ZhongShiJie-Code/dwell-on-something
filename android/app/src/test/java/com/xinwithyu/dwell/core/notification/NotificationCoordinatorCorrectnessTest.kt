package com.xinwithyu.dwell.core.notification

import com.xinwithyu.dwell.core.model.NotificationBaselineResponse
import com.xinwithyu.dwell.core.model.NotificationDto
import com.xinwithyu.dwell.core.model.NotificationResponse
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class NotificationCoordinatorCorrectnessTest {
    @Test
    fun zeroLatestStillProducesAnInitializedScope() = runTest {
        val store = FakeNotificationStore()
        val coordinator = coordinator(store)

        coordinator.configureScope("epoch-1", "device-1", baselineLatest = 0L)

        val scope = store.scope()
        assertNotNull(scope)
        assertTrue(scope!!.cursorInitialized)
        assertEquals(0L, scope.restCursor)
        assertEquals(0L, scope.baselineLatest)
    }

    @Test
    fun repeatedBaselineDoesNotRaiseTheOriginalBaselineWatermark() = runTest {
        val store = FakeNotificationStore()
        val coordinator = coordinator(store)

        coordinator.configureScope("epoch-1", "device-1", baselineLatest = 5L)
        coordinator.configureScope("epoch-1", "device-1", baselineLatest = 10L)

        assertEquals(5L, store.scope()!!.baselineLatest)
        assertEquals(5L, store.scope()!!.restCursor)
    }

    @Test
    fun invalidBaselineScopeIsRejectedWithoutPersistingAnUninitializedScope() = runTest {
        val store = FakeNotificationStore()
        val coordinator = coordinator(store)

        assertThrows(IllegalArgumentException::class.java) {
            runBlocking { coordinator.configureScope("", "device-1", baselineLatest = 0L) }
        }
        assertEquals(null, store.scope())

        assertThrows(IllegalArgumentException::class.java) {
            runBlocking { coordinator.configureScope("epoch-1", "device-1", baselineLatest = -1L) }
        }
        assertEquals(null, store.scope())
    }

    @Test
    fun triggeringFcmNotificationIsNotDiscardedWhenBaselineAlreadyIncludesItsId() = runTest {
        val store = FakeNotificationStore()
        val shown = mutableListOf<Long>()
        val coordinator = coordinator(store) { notification, _, _, _ ->
            shown += notification.notificationId
            true
        }
        coordinator.configureScope("epoch-1", "device-1", baselineLatest = 10L)

        val result = coordinator.accept(
            notification = notification(10L),
            source = NotificationSource.FCM,
            notificationsEnabled = true,
            permissionGranted = true,
            preserveLive = true,
        )

        assertEquals(NotificationProcessStatus.PRESENTED, result.status)
        assertEquals(listOf(10L), shown)
        assertEquals(RECEIPT_PRESENTED, store.receipt("epoch-1", "device-1", 10L)!!.state)
    }

    @Test
    fun liveFcmIsStagedBeforeBaselineAndPresentedAfterInitialization() = runTest {
        val store = FakeNotificationStore()
        val shown = mutableListOf<Long>()
        val coordinator = coordinator(store) { notification, _, _, _ ->
            shown += notification.notificationId
            true
        }
        val live = notification(11L)

        assertEquals(
            NotificationProcessStatus.QUEUED,
            coordinator.accept(live, NotificationSource.FCM, notificationsEnabled = true, permissionGranted = true, preserveLive = true).status,
        )
        assertFalse(store.scope()!!.cursorInitialized)
        assertEquals(RECEIPT_PENDING, store.receipt("epoch-1", "device-1", 11L)!!.state)

        coordinator.configureScope("epoch-1", "device-1", baselineLatest = 11L)
        assertEquals(
            NotificationProcessStatus.PRESENTED,
            coordinator.accept(live, NotificationSource.FCM, notificationsEnabled = true, permissionGranted = true, preserveLive = true).status,
        )
        assertEquals(listOf(11L), shown)
        assertEquals(RECEIPT_PRESENTED, store.receipt("epoch-1", "device-1", 11L)!!.state)
    }

    @Test
    fun failedBaselineLeavesScopeUninitialized() = runTest {
        val store = FakeNotificationStore()
        val coordinator = coordinator(store)
        val api = FakeNotificationApi(
            baseline = NotificationBaselineResponse(
                ok = false,
                deviceId = "device-1",
                notificationEpoch = "epoch-1",
                latest = 0L,
            ),
            pages = ArrayDeque(),
        )

        assertFalse(
            NotificationSyncEngine(
                coordinator = coordinator,
                api = api,
                notificationsEnabled = { true },
                permissionGranted = { true },
            ).sync().isSuccess,
        )
        assertEquals(null, store.scope())
    }

    @Test
    fun disabledSyncIngestsAndSuppressesNotificationsWithoutPresentingThem() = runTest {
        val store = FakeNotificationStore()
        val shown = mutableListOf<Long>()
        val coordinator = coordinator(store) { notification, _, _, _ ->
            shown += notification.notificationId
            true
        }
        val api = FakeNotificationApi(
            baseline = NotificationBaselineResponse(
                ok = true,
                deviceId = "device-1",
                notificationEpoch = "epoch-1",
                latest = 0L,
            ),
            pages = ArrayDeque(
                listOf(
                    NotificationResponse(
                        ok = true,
                        notificationEpoch = "epoch-1",
                        next = 1L,
                        latest = 1L,
                        hasMore = false,
                        items = listOf(notification(1L)),
                    ),
                ),
            ),
        )

        assertTrue(
            NotificationSyncEngine(
                coordinator = coordinator,
                api = api,
                notificationsEnabled = { false },
                permissionGranted = { true },
            ).sync().isSuccess,
        )
        assertTrue(shown.isEmpty())
        assertEquals(RECEIPT_SUPPRESSED_DISABLED, store.receipt("epoch-1", "device-1", 1L)!!.state)
        assertEquals(1L, store.scope()!!.restCursor)
    }

    @Test
    fun retryablePresentationFailureLeavesRestCursorBeforeTheFailedItem() = runTest {
        val store = FakeNotificationStore()
        val coordinator = coordinator(store) { _, _, _, _ -> false }
        coordinator.configureScope("epoch-1", "device-1", baselineLatest = 0L)

        val page = coordinator.processRestPage(
            response = NotificationResponse(
                ok = true,
                notificationEpoch = "epoch-1",
                next = 1L,
                latest = 1L,
                hasMore = false,
                items = listOf(notification(1L)),
            ),
            notificationsEnabled = true,
            permissionGranted = true,
        )

        assertFalse(page.processed)
        assertEquals(0L, page.nextCursor)
        assertEquals(0L, store.scope()!!.restCursor)
        assertEquals(RECEIPT_PENDING, store.receipt("epoch-1", "device-1", 1L)!!.state)
    }

    @Test
    fun expiredLeaseCanBeReclaimedButOldPresenterCannotCompleteIt() = runTest {
        val store = FakeNotificationStore()
        val coordinator = coordinator(store)
        coordinator.configureScope("epoch-1", "device-1", baselineLatest = 0L)
        store.seedPresenting(notification(1L), leaseToken = "old", leaseUntil = 100L)

        coordinator.recoverLeasesAndCleanup(now = 100L)
        assertEquals(RECEIPT_PENDING, store.receipt("epoch-1", "device-1", 1L)!!.state)

        assertEquals(
            1,
            store.claimForPresentation(
                epoch = "epoch-1",
                deviceId = "device-1",
                notificationId = 1L,
                state = RECEIPT_PRESENTING,
                leaseToken = "new",
                leaseUntil = 200L,
                now = 100L,
                updatedAt = 100L,
            ),
        )
        assertEquals(0, store.markPresented("epoch-1", "device-1", 1L, "old", 101L))
        assertEquals(1, store.markPresented("epoch-1", "device-1", 1L, "new", 101L))
    }

    @Test
    fun expiredPresentingReceiptCanBeReprocessedByAccept() = runTest {
        val store = FakeNotificationStore()
        val shown = mutableListOf<Long>()
        val coordinator = coordinator(store) { notification, _, _, _ ->
            shown += notification.notificationId
            true
        }
        coordinator.configureScope("epoch-1", "device-1", baselineLatest = 0L)
        val item = notification(1L)
        store.seedPresenting(item, leaseToken = "old", leaseUntil = 100L)

        val result = coordinator.accept(
            notification = item,
            source = NotificationSource.REST,
            notificationsEnabled = true,
            permissionGranted = true,
        )

        assertEquals(NotificationProcessStatus.PRESENTED, result.status)
        assertEquals(listOf(1L), shown)
        assertEquals(RECEIPT_PRESENTED, store.receipt("epoch-1", "device-1", 1L)!!.state)
    }

    @Test
    fun expiredPresentingReceiptCanBeSuppressedWhenNotificationsAreDisabled() = runTest {
        val store = FakeNotificationStore()
        val coordinator = coordinator(store)
        coordinator.configureScope("epoch-1", "device-1", baselineLatest = 0L)
        val item = notification(1L)
        store.seedPresenting(item, leaseToken = "old", leaseUntil = 100L)

        val result = coordinator.accept(
            notification = item,
            source = NotificationSource.REST,
            notificationsEnabled = false,
            permissionGranted = true,
        )

        assertEquals(NotificationProcessStatus.SUPPRESSED, result.status)
        assertEquals(RECEIPT_SUPPRESSED_DISABLED, store.receipt("epoch-1", "device-1", 1L)!!.state)
    }

    @Test
    fun restItemsMayOmitScopeFieldsButMustUseTheCurrentScope() = runTest {
        val store = FakeNotificationStore()
        val coordinator = coordinator(store)
        coordinator.configureScope("epoch-1", "device-1", baselineLatest = 0L)

        val page = coordinator.processRestPage(
            response = NotificationResponse(
                ok = true,
                notificationEpoch = "epoch-1",
                next = 1L,
                latest = 1L,
                hasMore = false,
                items = listOf(notification(1L).copy(notificationEpoch = "", deviceId = "")),
            ),
            notificationsEnabled = true,
            permissionGranted = true,
        )

        assertTrue(page.processed)
        assertEquals(1L, store.scope()!!.restCursor)
        assertEquals(RECEIPT_PRESENTED, store.receipt("epoch-1", "device-1", 1L)!!.state)
    }

    @Test
    fun restScopeMismatchDoesNotAdvanceTheCursor() = runTest {
        val store = FakeNotificationStore()
        val coordinator = coordinator(store)
        coordinator.configureScope("epoch-1", "device-1", baselineLatest = 0L)

        val page = coordinator.processRestPage(
            response = NotificationResponse(
                ok = true,
                notificationEpoch = "epoch-1",
                next = 1L,
                latest = 1L,
                hasMore = false,
                items = listOf(notification(1L).copy(deviceId = "other-device")),
            ),
            notificationsEnabled = true,
            permissionGranted = true,
        )

        assertFalse(page.processed)
        assertEquals(0L, store.scope()!!.restCursor)
        assertEquals(null, store.receipt("epoch-1", "device-1", 1L))
    }

    @Test
    fun syncEngineUsesFakeApiAndCommitsCursorOnlyAfterPresentation() = runTest {
        val store = FakeNotificationStore()
        val coordinator = coordinator(store)
        val api = FakeNotificationApi(
            baseline = NotificationBaselineResponse(
                ok = true,
                deviceId = "device-1",
                notificationEpoch = "epoch-1",
                latest = 0L,
            ),
            pages = ArrayDeque(
                listOf(
                    NotificationResponse(
                        ok = true,
                        notificationEpoch = "epoch-1",
                        next = 1L,
                        latest = 1L,
                        hasMore = false,
                        items = listOf(notification(1L)),
                    ),
                ),
            ),
        )
        val engine = NotificationSyncEngine(
            coordinator = coordinator,
            api = api,
            notificationsEnabled = { true },
            permissionGranted = { true },
        )

        assertTrue(engine.sync().isSuccess)
        assertEquals(listOf(0L), api.requestedCursors)
        assertEquals(1L, store.scope()!!.restCursor)
    }

    private fun coordinator(
        store: FakeNotificationStore,
        presenter: NotificationPresenter = NotificationPresenter { _, _, _, _ -> true },
    ) = NotificationCoordinator(store, presenter, now = { 100L })

    private fun notification(id: Long) = NotificationDto(
        id = id,
        notificationId = id,
        kind = "chat",
        title = "title",
        body = "body",
        at = 100L,
        route = "chat/main",
        notificationEpoch = "epoch-1",
        deviceId = "device-1",
    )
}

private fun assertIllegalArgument(block: suspend () -> Unit) {
    assertThrows(IllegalArgumentException::class.java) { runBlocking { block() } }
}

private class FakeNotificationApi(
    private val baseline: NotificationBaselineResponse,
    private val pages: ArrayDeque<NotificationResponse>,
) : NotificationApi {
    val requestedCursors = mutableListOf<Long>()

    override suspend fun baseline(): NotificationBaselineResponse = baseline

    override suspend fun notifications(since: Long, limit: Int): NotificationResponse {
        requestedCursors += since
        return pages.removeFirst()
    }
}

private class FakeNotificationStore : NotificationReceiptStore {
    private var currentScope: NotificationScopeEntity? = null
    private val receipts = mutableMapOf<Triple<String, String, Long>, NotificationReceiptEntity>()

    override suspend fun scope(): NotificationScopeEntity? = currentScope

    override suspend fun replaceScope(scope: NotificationScopeEntity) {
        currentScope = scope
    }

    override suspend fun advanceRestCursor(epoch: String, deviceId: String, cursor: Long, updatedAt: Long): Int {
        val scope = currentScope ?: return 0
        if (scope.notificationEpoch != epoch || scope.pairedDeviceId != deviceId || !scope.cursorInitialized || scope.restCursor >= cursor) return 0
        currentScope = scope.copy(restCursor = cursor, updatedAt = updatedAt)
        return 1
    }

    override suspend fun insertReceipt(receipt: NotificationReceiptEntity): Long {
        val key = Triple(receipt.notificationEpoch, receipt.pairedDeviceId, receipt.notificationId)
        if (receipts.putIfAbsent(key, receipt) != null) return -1L
        return 1L
    }

    override suspend fun receipt(epoch: String, deviceId: String, notificationId: Long): NotificationReceiptEntity? =
        receipts[Triple(epoch, deviceId, notificationId)]

    override suspend fun pendingReceipts(
        epoch: String,
        deviceId: String,
        limit: Int,
    ): List<NotificationReceiptEntity> = receipts.values
        .filter { it.notificationEpoch == epoch && it.pairedDeviceId == deviceId && it.state == RECEIPT_PENDING }
        .sortedBy { it.notificationId }
        .take(limit)

    override suspend fun transitionPending(
        epoch: String,
        deviceId: String,
        notificationId: Long,
        fromState: String,
        state: String,
        updatedAt: Long,
    ): Int = update(epoch, deviceId, notificationId) { receipt ->
        if (receipt.state != fromState) return@update null
        receipt.copy(state = state, leaseToken = null, leaseUntil = null, updatedAt = updatedAt)
    }

    override suspend fun claimForPresentation(
        epoch: String,
        deviceId: String,
        notificationId: Long,
        state: String,
        leaseToken: String,
        leaseUntil: Long,
        now: Long,
        updatedAt: Long,
    ): Int = update(epoch, deviceId, notificationId) { receipt ->
        if (receipt.state != RECEIPT_PENDING &&
            !(receipt.state == RECEIPT_PRESENTING && (receipt.leaseUntil == null || receipt.leaseUntil <= now))
        ) return@update null
        receipt.copy(state = state, leaseToken = leaseToken, leaseUntil = leaseUntil, updatedAt = updatedAt)
    }

    override suspend fun markPresented(epoch: String, deviceId: String, notificationId: Long, leaseToken: String, updatedAt: Long): Int =
        update(epoch, deviceId, notificationId) { receipt ->
            if (receipt.state != RECEIPT_PRESENTING || receipt.leaseToken != leaseToken) return@update null
            receipt.copy(state = RECEIPT_PRESENTED, leaseToken = null, leaseUntil = null, updatedAt = updatedAt)
        }

    override suspend fun releasePresentation(epoch: String, deviceId: String, notificationId: Long, leaseToken: String, updatedAt: Long): Int =
        update(epoch, deviceId, notificationId) { receipt ->
            if (receipt.state != RECEIPT_PRESENTING || receipt.leaseToken != leaseToken) return@update null
            receipt.copy(state = RECEIPT_PENDING, leaseToken = null, leaseUntil = null, updatedAt = updatedAt)
        }

    override suspend fun recoverExpiredLeases(now: Long, updatedAt: Long): Int {
        var count = 0
        receipts.entries.toList().forEach { (key, receipt) ->
            if (receipt.state == RECEIPT_PRESENTING && (receipt.leaseUntil == null || receipt.leaseUntil <= now)) {
                receipts[key] = receipt.copy(state = RECEIPT_PENDING, leaseToken = null, leaseUntil = null, updatedAt = updatedAt)
                count += 1
            }
        }
        return count
    }

    override suspend fun deleteOldTerminalReceipts(
        epoch: String,
        deviceId: String,
        restCursor: Long,
        before: Long,
    ): Int = 0

    override suspend fun registration(): NotificationRegistrationEntity? = null

    override suspend fun saveRegistration(registration: NotificationRegistrationEntity) = Unit

    fun seedPresenting(notification: NotificationDto, leaseToken: String, leaseUntil: Long) {
        val now = 100L
        receipts[Triple("epoch-1", "device-1", notification.notificationId)] = NotificationReceiptEntity(
            notificationEpoch = "epoch-1",
            pairedDeviceId = "device-1",
            notificationId = notification.notificationId,
            kind = notification.kind,
            title = notification.title,
            body = notification.body,
            at = notification.at,
            route = notification.route,
            source = "rest",
            state = RECEIPT_PRESENTING,
            leaseToken = leaseToken,
            leaseUntil = leaseUntil,
            createdAt = now,
            updatedAt = now,
        )
    }

    private fun update(
        epoch: String,
        deviceId: String,
        notificationId: Long,
        transform: (NotificationReceiptEntity) -> NotificationReceiptEntity?,
    ): Int {
        val key = Triple(epoch, deviceId, notificationId)
        val current = receipts[key] ?: return 0
        val replacement = transform(current) ?: return 0
        receipts[key] = replacement
        return 1
    }
}
