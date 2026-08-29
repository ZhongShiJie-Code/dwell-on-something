package com.xinwithyu.dwell.core.notification

import android.content.Context
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Index
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.Transaction

const val RECEIPT_PENDING = "pending"
const val RECEIPT_PRESENTING = "presenting"
const val RECEIPT_PRESENTED = "presented"
const val RECEIPT_SUPPRESSED_DISABLED = "suppressed_disabled"
const val RECEIPT_SUPPRESSED_PERMISSION = "suppressed_permission"
const val RECEIPT_REJECTED_INVALID = "rejected_invalid"
const val RECEIPT_IGNORED_BASELINE = "ignored_baseline"

@Entity(tableName = "notification_scope")
data class NotificationScopeEntity(
    @PrimaryKey val singleton: Int = 1,
    val notificationEpoch: String,
    val pairedDeviceId: String,
    val restCursor: Long,
    val baselineLatest: Long,
    val cursorInitialized: Boolean,
    val updatedAt: Long,
)

@Entity(
    tableName = "notification_inbox",
    primaryKeys = ["notificationEpoch", "pairedDeviceId", "notificationId"],
    indices = [
        Index(value = ["state"]),
        Index(value = ["leaseUntil"]),
        Index(value = ["updatedAt"]),
    ],
)
data class NotificationReceiptEntity(
    val notificationEpoch: String,
    val pairedDeviceId: String,
    val notificationId: Long,
    val kind: String,
    val title: String,
    val body: String,
    val at: Long,
    val route: String,
    val source: String,
    val state: String,
    val leaseToken: String? = null,
    val leaseUntil: Long? = null,
    val createdAt: Long,
    val updatedAt: Long,
)

@Entity(tableName = "notification_registration")
data class NotificationRegistrationEntity(
    @PrimaryKey val singleton: Int = 1,
    val state: String = "disabled",
    val tokenHash: String = "",
    val lastErrorCode: String = "",
    val lastRegisteredAt: Long = 0,
    val updatedAt: Long = 0,
)

enum class FcmStageStatus { INSERTED, DUPLICATE, SCOPE_MISMATCH }

data class FcmStageResult(
    val status: FcmStageStatus,
    val receipt: NotificationReceiptEntity? = null,
)

interface NotificationReceiptStore {
    suspend fun scope(): NotificationScopeEntity?
    suspend fun replaceScope(scope: NotificationScopeEntity)
    suspend fun advanceRestCursor(epoch: String, deviceId: String, cursor: Long, updatedAt: Long): Int
    suspend fun insertReceipt(receipt: NotificationReceiptEntity): Long
    suspend fun receipt(epoch: String, deviceId: String, notificationId: Long): NotificationReceiptEntity?
    suspend fun transitionPending(epoch: String, deviceId: String, notificationId: Long, fromState: String, state: String, updatedAt: Long): Int
    suspend fun claimForPresentation(
        epoch: String,
        deviceId: String,
        notificationId: Long,
        state: String,
        leaseToken: String,
        leaseUntil: Long,
        now: Long,
        updatedAt: Long,
    ): Int
    suspend fun markPresented(epoch: String, deviceId: String, notificationId: Long, leaseToken: String, updatedAt: Long): Int
    suspend fun releasePresentation(epoch: String, deviceId: String, notificationId: Long, leaseToken: String, updatedAt: Long): Int
    suspend fun recoverExpiredLeases(now: Long, updatedAt: Long): Int
    suspend fun deleteOldTerminalReceipts(
        epoch: String,
        deviceId: String,
        restCursor: Long,
        before: Long,
    ): Int
    suspend fun registration(): NotificationRegistrationEntity?
    suspend fun saveRegistration(registration: NotificationRegistrationEntity)

    /** Persist the backend identity without making the cursor usable. */
    suspend fun rememberUninitializedScope(epoch: String, deviceId: String, updatedAt: Long): Boolean {
        val current = scope()
        if (current != null && (current.notificationEpoch != epoch || current.pairedDeviceId != deviceId)) {
            replaceScope(
                NotificationScopeEntity(
                    notificationEpoch = epoch,
                    pairedDeviceId = deviceId,
                    restCursor = 0L,
                    baselineLatest = 0L,
                    cursorInitialized = false,
                    updatedAt = updatedAt,
                ),
            )
        } else if (current == null) {
            replaceScope(
                NotificationScopeEntity(
                    notificationEpoch = epoch,
                    pairedDeviceId = deviceId,
                    restCursor = 0L,
                    baselineLatest = 0L,
                    cursorInitialized = false,
                    updatedAt = updatedAt,
                ),
            )
        } else if (!current.cursorInitialized) {
            replaceScope(current.copy(updatedAt = updatedAt))
        }
        return true
    }

    /** Atomically installs a successful baseline while preserving an existing cursor. */
    suspend fun initializeScope(epoch: String, deviceId: String, baselineLatest: Long, updatedAt: Long): Boolean {
        val current = scope()
        if (current != null && (current.notificationEpoch != epoch || current.pairedDeviceId != deviceId)) return false
        when {
            current == null -> replaceScope(
                NotificationScopeEntity(
                    notificationEpoch = epoch,
                    pairedDeviceId = deviceId,
                    restCursor = baselineLatest,
                    baselineLatest = baselineLatest,
                    cursorInitialized = true,
                    updatedAt = updatedAt,
                ),
            )
            !current.cursorInitialized -> replaceScope(
                current.copy(
                    restCursor = baselineLatest,
                    baselineLatest = baselineLatest,
                    cursorInitialized = true,
                    updatedAt = updatedAt,
                ),
            )
            else -> replaceScope(current.copy(updatedAt = updatedAt))
        }
        return true
    }

    /** Atomically stages a live FCM payload, even while baseline acquisition is unavailable. */
    suspend fun stageFcmReceipt(receipt: NotificationReceiptEntity, updatedAt: Long): FcmStageResult {
        val current = scope()
        if (current != null && (current.notificationEpoch != receipt.notificationEpoch || current.pairedDeviceId != receipt.pairedDeviceId)) {
            return FcmStageResult(FcmStageStatus.SCOPE_MISMATCH)
        }
        if (current == null) {
            replaceScope(
                NotificationScopeEntity(
                    notificationEpoch = receipt.notificationEpoch,
                    pairedDeviceId = receipt.pairedDeviceId,
                    restCursor = 0L,
                    baselineLatest = 0L,
                    cursorInitialized = false,
                    updatedAt = updatedAt,
                ),
            )
        }
        val existing = receipt(receipt.notificationEpoch, receipt.pairedDeviceId, receipt.notificationId)
        if (existing != null) return FcmStageResult(FcmStageStatus.DUPLICATE, existing)
        return if (insertReceipt(receipt) == -1L) {
            FcmStageResult(FcmStageStatus.DUPLICATE, receipt(receipt.notificationEpoch, receipt.pairedDeviceId, receipt.notificationId))
        } else {
            FcmStageResult(FcmStageStatus.INSERTED, receipt)
        }
    }

    suspend fun pendingReceipts(epoch: String, deviceId: String, limit: Int): List<NotificationReceiptEntity> = emptyList()
}

@Dao
interface NotificationReceiptDao : NotificationReceiptStore {
    @Query("SELECT * FROM notification_scope WHERE singleton = 1 LIMIT 1")
    override suspend fun scope(): NotificationScopeEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    override suspend fun replaceScope(scope: NotificationScopeEntity)

    @Query("UPDATE notification_scope SET restCursor = :cursor, updatedAt = :updatedAt WHERE singleton = 1 AND notificationEpoch = :epoch AND pairedDeviceId = :deviceId AND cursorInitialized = 1 AND restCursor < :cursor")
    override suspend fun advanceRestCursor(epoch: String, deviceId: String, cursor: Long, updatedAt: Long): Int

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    override suspend fun insertReceipt(receipt: NotificationReceiptEntity): Long

    @Query("SELECT * FROM notification_inbox WHERE notificationEpoch = :epoch AND pairedDeviceId = :deviceId AND notificationId = :notificationId LIMIT 1")
    override suspend fun receipt(epoch: String, deviceId: String, notificationId: Long): NotificationReceiptEntity?

    @Query("SELECT * FROM notification_inbox WHERE notificationEpoch = :epoch AND pairedDeviceId = :deviceId AND state = 'pending' ORDER BY notificationId ASC LIMIT :limit")
    override suspend fun pendingReceipts(epoch: String, deviceId: String, limit: Int): List<NotificationReceiptEntity>

    @Query("UPDATE notification_inbox SET state = :state, leaseToken = NULL, leaseUntil = NULL, updatedAt = :updatedAt WHERE notificationEpoch = :epoch AND pairedDeviceId = :deviceId AND notificationId = :notificationId AND state = :fromState")
    override suspend fun transitionPending(epoch: String, deviceId: String, notificationId: Long, fromState: String, state: String, updatedAt: Long): Int

    @Query("UPDATE notification_inbox SET state = :state, leaseToken = :leaseToken, leaseUntil = :leaseUntil, updatedAt = :updatedAt WHERE notificationEpoch = :epoch AND pairedDeviceId = :deviceId AND notificationId = :notificationId AND (state = 'pending' OR (state = 'presenting' AND (leaseUntil IS NULL OR leaseUntil <= :now)))")
    override suspend fun claimForPresentation(
        epoch: String,
        deviceId: String,
        notificationId: Long,
        state: String,
        leaseToken: String,
        leaseUntil: Long,
        now: Long,
        updatedAt: Long,
    ): Int

    @Query("UPDATE notification_inbox SET state = 'presented', leaseToken = NULL, leaseUntil = NULL, updatedAt = :updatedAt WHERE notificationEpoch = :epoch AND pairedDeviceId = :deviceId AND notificationId = :notificationId AND state = 'presenting' AND leaseToken = :leaseToken")
    override suspend fun markPresented(epoch: String, deviceId: String, notificationId: Long, leaseToken: String, updatedAt: Long): Int

    @Query("UPDATE notification_inbox SET state = 'pending', leaseToken = NULL, leaseUntil = NULL, updatedAt = :updatedAt WHERE notificationEpoch = :epoch AND pairedDeviceId = :deviceId AND notificationId = :notificationId AND state = 'presenting' AND leaseToken = :leaseToken")
    override suspend fun releasePresentation(epoch: String, deviceId: String, notificationId: Long, leaseToken: String, updatedAt: Long): Int

    @Query("UPDATE notification_inbox SET state = 'pending', leaseToken = NULL, leaseUntil = NULL, updatedAt = :updatedAt WHERE state = 'presenting' AND (leaseUntil IS NULL OR leaseUntil <= :now)")
    override suspend fun recoverExpiredLeases(now: Long, updatedAt: Long): Int

    @Query("DELETE FROM notification_inbox WHERE notificationEpoch = :epoch AND pairedDeviceId = :deviceId AND notificationId <= :restCursor AND state IN ('presented', 'suppressed_disabled', 'suppressed_permission', 'rejected_invalid', 'ignored_baseline') AND updatedAt < :before")
    override suspend fun deleteOldTerminalReceipts(
        epoch: String,
        deviceId: String,
        restCursor: Long,
        before: Long,
    ): Int

    @Query("SELECT * FROM notification_registration WHERE singleton = 1 LIMIT 1")
    override suspend fun registration(): NotificationRegistrationEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    override suspend fun saveRegistration(registration: NotificationRegistrationEntity)

    @Transaction
    override suspend fun rememberUninitializedScope(epoch: String, deviceId: String, updatedAt: Long): Boolean {
        val current = scope()
        if (current != null && (current.notificationEpoch != epoch || current.pairedDeviceId != deviceId)) {
            replaceScope(
                NotificationScopeEntity(
                    notificationEpoch = epoch,
                    pairedDeviceId = deviceId,
                    restCursor = 0L,
                    baselineLatest = 0L,
                    cursorInitialized = false,
                    updatedAt = updatedAt,
                ),
            )
        } else if (current == null) {
            replaceScope(
                NotificationScopeEntity(
                    notificationEpoch = epoch,
                    pairedDeviceId = deviceId,
                    restCursor = 0L,
                    baselineLatest = 0L,
                    cursorInitialized = false,
                    updatedAt = updatedAt,
                ),
            )
        } else if (!current.cursorInitialized) {
            replaceScope(current.copy(updatedAt = updatedAt))
        }
        return true
    }

    @Transaction
    override suspend fun initializeScope(epoch: String, deviceId: String, baselineLatest: Long, updatedAt: Long): Boolean {
        val current = scope()
        if (current != null && (current.notificationEpoch != epoch || current.pairedDeviceId != deviceId)) return false
        when {
            current == null -> replaceScope(
                NotificationScopeEntity(
                    notificationEpoch = epoch,
                    pairedDeviceId = deviceId,
                    restCursor = baselineLatest,
                    baselineLatest = baselineLatest,
                    cursorInitialized = true,
                    updatedAt = updatedAt,
                ),
            )
            !current.cursorInitialized -> replaceScope(
                current.copy(
                    restCursor = baselineLatest,
                    baselineLatest = baselineLatest,
                    cursorInitialized = true,
                    updatedAt = updatedAt,
                ),
            )
            else -> replaceScope(current.copy(updatedAt = updatedAt))
        }
        return true
    }

    @Transaction
    override suspend fun stageFcmReceipt(receipt: NotificationReceiptEntity, updatedAt: Long): FcmStageResult {
        val current = scope()
        if (current != null && (current.notificationEpoch != receipt.notificationEpoch || current.pairedDeviceId != receipt.pairedDeviceId)) {
            return FcmStageResult(FcmStageStatus.SCOPE_MISMATCH)
        }
        if (current == null) {
            replaceScope(
                NotificationScopeEntity(
                    notificationEpoch = receipt.notificationEpoch,
                    pairedDeviceId = receipt.pairedDeviceId,
                    restCursor = 0L,
                    baselineLatest = 0L,
                    cursorInitialized = false,
                    updatedAt = updatedAt,
                ),
            )
        }
        val existing = receipt(receipt.notificationEpoch, receipt.pairedDeviceId, receipt.notificationId)
        if (existing != null) return FcmStageResult(FcmStageStatus.DUPLICATE, existing)
        return if (insertReceipt(receipt) == -1L) {
            FcmStageResult(FcmStageStatus.DUPLICATE, receipt(receipt.notificationEpoch, receipt.pairedDeviceId, receipt.notificationId))
        } else {
            FcmStageResult(FcmStageStatus.INSERTED, receipt)
        }
    }

    @Transaction
    suspend fun replaceScopeAndCursor(scope: NotificationScopeEntity) {
        replaceScope(scope)
    }
}

@Database(
    entities = [NotificationScopeEntity::class, NotificationReceiptEntity::class, NotificationRegistrationEntity::class],
    version = 2,
    exportSchema = true,
)
abstract class NotificationReceiptDatabase : RoomDatabase() {
    abstract fun dao(): NotificationReceiptDao

    companion object {
        val MIGRATION_1_2 = object : Migration(1, 2) {
            override fun migrate(database: SupportSQLiteDatabase) {
                database.query("PRAGMA table_info(`notification_scope`)").use { cursor ->
                    val nameIndex = cursor.getColumnIndex("name")
                    var hasCursorInitialized = false
                    while (cursor.moveToNext()) {
                        if (nameIndex >= 0 && cursor.getString(nameIndex) == "cursorInitialized") {
                            hasCursorInitialized = true
                            break
                        }
                    }
                    if (!hasCursorInitialized) {
                        database.execSQL(
                            "ALTER TABLE `notification_scope` ADD COLUMN `cursorInitialized` INTEGER NOT NULL DEFAULT 0",
                        )
                    }
                }
            }
        }

        @Volatile private var instance: NotificationReceiptDatabase? = null

        fun get(context: Context): NotificationReceiptDatabase = instance ?: synchronized(this) {
            instance ?: Room.databaseBuilder(
                context.applicationContext,
                NotificationReceiptDatabase::class.java,
                "notification-receipts.sqlite",
            )
                .addMigrations(MIGRATION_1_2)
                .build()
                .also { instance = it }
        }
    }
}
