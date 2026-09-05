package com.pdatahub.hub.di

import android.content.Context
import androidx.room.Room
import com.pdatahub.hub.data.db.DatabasePassphrase
import com.pdatahub.hub.data.db.HubDatabase
import com.pdatahub.hub.data.db.TokenDao
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import net.zetetic.database.sqlcipher.SupportOpenHelperFactory
import javax.inject.Singleton

/**
 * Provides the encrypted Hub database via Room + SQLCipher.
 *
 * Passphrase is generated on first launch, encrypted via CryptoBox, and
 * persisted in SharedPreferences. See [DatabasePassphrase].
 *
 * `fallbackToDestructiveMigration` is enabled for init. Real production
 * should define proper migrations once the schema stabilizes.
 */
@Module
@InstallIn(SingletonComponent::class)
object DatabaseModule {

    @Provides
    @Singleton
    fun provideHubDatabase(
        @ApplicationContext context: Context,
        dbPassphrase: DatabasePassphrase,
    ): HubDatabase {
        val passphrase = dbPassphrase.getOrCreate()
        val factory = SupportOpenHelperFactory(passphrase)
        return Room.databaseBuilder(context, HubDatabase::class.java, "hub.db")
            .openHelperFactory(factory)
            .fallbackToDestructiveMigration()
            .build()
    }

    @Provides
    fun provideTokenDao(db: HubDatabase): TokenDao = db.tokens()
}
