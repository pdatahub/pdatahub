package com.pdatahub.hub.data.db

import android.content.Context
import com.pdatahub.hub.data.crypto.CryptoBox
import dagger.hilt.android.qualifiers.ApplicationContext
import java.security.SecureRandom
import java.util.Base64
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Manages the SQLCipher database passphrase.
 *
 * The passphrase is a 32-byte random key, generated on first launch and
 * encrypted via [CryptoBox] before being stored in SharedPreferences. The
 * plaintext passphrase only exists in memory while the database is open.
 *
 * SharedPreferences is intentionally NOT encrypted at rest — the encrypted
 * blob is useless without the Android Keystore master key that wraps it.
 */
@Singleton
class DatabasePassphrase @Inject constructor(
    @ApplicationContext private val context: Context,
    private val cryptoBox: CryptoBox,
) {
    private val prefs = context.getSharedPreferences("hub_db_meta", Context.MODE_PRIVATE)
    private val secureRandom = SecureRandom()

    fun getOrCreate(): ByteArray {
        val stored = prefs.getString(KEY_CIPHERTEXT, null)
        if (stored != null) {
            val raw = Base64.getUrlDecoder().decode(stored)
            return cryptoBox.decrypt(raw)
                ?: error("Failed to decrypt DB passphrase — keystore may have been wiped")
        }
        val fresh = ByteArray(32).also { secureRandom.nextBytes(it) }
        val ciphertext = cryptoBox.encrypt(fresh)
        prefs.edit()
            .putString(KEY_CIPHERTEXT, Base64.getUrlEncoder().withoutPadding().encodeToString(ciphertext))
            .apply()
        return fresh
    }

    fun clear() {
        prefs.edit().remove(KEY_CIPHERTEXT).apply()
    }

    companion object {
        private const val KEY_CIPHERTEXT = "passphrase_ct"
    }
}
