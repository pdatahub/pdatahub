package com.pdatahub.hub.data.db

import androidx.room.Database
import androidx.room.Entity
import androidx.room.PrimaryKey
import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.RoomDatabase
import kotlinx.coroutines.flow.Flow

@Entity(tableName = "tokens")
data class TokenEntity(
    @PrimaryKey val key: String,
    val pluginName: String,
    val scope: String,
    val accessTokenCiphertext: ByteArray,
    val refreshTokenCiphertext: ByteArray?,
    val expiresAt: Long?,
    val aad: ByteArray,
) {
    override fun equals(other: Any?): Boolean = other is TokenEntity && key == other.key
    override fun hashCode(): Int = key.hashCode()
}

@Dao
interface TokenDao {
    @Query("SELECT * FROM tokens WHERE key = :key LIMIT 1")
    suspend fun get(key: String): TokenEntity?

    @Query("SELECT * FROM tokens WHERE pluginName = :pluginName")
    fun observeByPlugin(pluginName: String): Flow<List<TokenEntity>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(token: TokenEntity)

    @Query("DELETE FROM tokens WHERE key = :key")
    suspend fun delete(key: String)
}

@Database(
    entities = [TokenEntity::class],
    version = 1,
    exportSchema = false,
)
abstract class HubDatabase : RoomDatabase() {
    abstract fun tokens(): TokenDao
}
