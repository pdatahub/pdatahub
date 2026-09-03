package com.pdatahub.hub.data.identity

import android.content.Context
import com.pdatahub.hub.data.crypto.CryptoBox
import dagger.hilt.android.qualifiers.ApplicationContext
import java.io.File
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Encrypted-on-disk storage for the Hub's identity keypair.
 *
 * Uses [CryptoBox] (AES-256-GCM with Android Keystore-backed master key) for
 * encryption. The plaintext is the concatenation of the Ed25519 public key
 * (32 bytes) followed by the private key bytes.
 */
@Singleton
class IdentityKeystore @Inject constructor(
    @ApplicationContext private val context: Context,
    private val cryptoBox: CryptoBox,
) {
    private val file: File = File(context.filesDir, "identity.bin")

    fun load(): IdentityManager.Identity? {
        if (!file.exists()) return null
        val encrypted = file.readBytes()
        if (encrypted.isEmpty()) return null
        val decrypted = cryptoBox.decrypt(encrypted) ?: return null
        if (decrypted.size < 32) return null
        val pub = decrypted.copyOfRange(0, 32)
        val priv = decrypted.copyOfRange(32, decrypted.size)
        return IdentityManager.Identity(publicKey = pub, privateKey = priv)
    }

    fun store(identity: IdentityManager.Identity): Boolean {
        val combined = identity.publicKey + identity.privateKey
        val encrypted = cryptoBox.encrypt(combined)
        file.writeBytes(encrypted)
        return true
    }

    fun clear() {
        if (file.exists()) file.delete()
    }
}
