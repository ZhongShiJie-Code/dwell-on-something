package com.xinwithyu.dwell.core.database

import android.content.Context
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
import com.xinwithyu.dwell.core.model.ChatDto
import com.xinwithyu.dwell.core.model.MessageDto
import kotlinx.coroutines.flow.Flow

@Entity(tableName = "chats", indices = [Index(value = ["last"], orders = [Index.Order.DESC])])
data class ChatEntity(
    @PrimaryKey val id: String,
    val name: String,
    val preview: String,
    val created: Long,
    val last: Long,
    val current: Boolean,
    val archived: Boolean,
    val source: String,
    val sourceLabel: String,
)

@Entity(tableName = "messages", indices = [Index(value = ["chatId", "seq"], unique = true)])
data class MessageEntity(
    @PrimaryKey val seq: Long,
    val chatId: String,
    val at: Long,
    val kind: String,
    val text: String,
    val extra: String?,
    val feedback: String,
    val replyTo: Long?,
    val variantOf: Long?,
    val version: Int?,
)

@Entity(tableName = "drafts")
data class DraftEntity(
    @PrimaryKey val chatId: String,
    val text: String,
    val updatedAt: Long,
)

@Dao
interface DwellDao {
    @Query("SELECT * FROM chats ORDER BY last DESC")
    fun observeChats(): Flow<List<ChatEntity>>

    @Query("SELECT * FROM messages WHERE chatId = :chatId ORDER BY seq ASC")
    fun observeMessages(chatId: String): Flow<List<MessageEntity>>

    @Query("SELECT * FROM messages WHERE chatId = :chatId ORDER BY seq ASC")
    suspend fun messages(chatId: String): List<MessageEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertChats(items: List<ChatEntity>)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertMessages(items: List<MessageEntity>)

    @Query("DELETE FROM messages WHERE chatId = :chatId")
    suspend fun deleteMessages(chatId: String)

    @Query("UPDATE chats SET current = CASE WHEN id = :chatId THEN 1 ELSE 0 END")
    suspend fun selectChat(chatId: String)

    @Query("SELECT * FROM drafts WHERE chatId = :chatId LIMIT 1")
    fun observeDraft(chatId: String): Flow<DraftEntity?>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun saveDraft(draft: DraftEntity)

    @Query("DELETE FROM drafts WHERE chatId = :chatId")
    suspend fun clearDraft(chatId: String)

    @Query("UPDATE messages SET feedback = :value WHERE seq = :seq")
    suspend fun setFeedback(seq: Long, value: String)

    @Transaction
    suspend fun replaceMessages(chatId: String, items: List<MessageEntity>) {
        deleteMessages(chatId)
        upsertMessages(items)
    }
}

@Database(
    entities = [ChatEntity::class, MessageEntity::class, DraftEntity::class],
    version = 1,
    exportSchema = true,
)
abstract class DwellDatabase : RoomDatabase() {
    abstract fun dao(): DwellDao

    companion object {
        @Volatile private var instance: DwellDatabase? = null

        fun get(context: Context): DwellDatabase = instance ?: synchronized(this) {
            instance ?: Room.databaseBuilder(
                context.applicationContext,
                DwellDatabase::class.java,
                "dwell-mobile.sqlite",
            ).build().also { instance = it }
        }
    }
}

fun ChatDto.toEntity() = ChatEntity(id, name, preview, created, last, current, archived, source, sourceLabel)
fun ChatEntity.toDto() = ChatDto(id, name, preview, created, last, current, archived, source, sourceLabel)
fun MessageDto.toEntity(defaultChatId: String = chatId) = MessageEntity(
    seq, chatId.ifBlank { defaultChatId }, at, kind, text, extra, feedback, replyTo, variantOf, version,
)
fun MessageEntity.toDto() = MessageDto(seq, at, chatId, kind, text, extra, feedback, replyTo, variantOf, version)
