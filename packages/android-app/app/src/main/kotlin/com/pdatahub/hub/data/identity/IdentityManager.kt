package com.pdatahub.hub.data.identity

import android.content.Context
import dagger.hilt.android.qualifiers.ApplicationContext
import org.bouncycastle.crypto.generators.Ed25519KeyPairGenerator
import org.bouncycastle.crypto.params.Ed25519KeyGenerationParameters
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters
import java.security.KeyPairGenerator
import java.security.SecureRandom
import java.util.Base64
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Manages the Hub's long-lived Ed25519 identity keypair.
 *
 * The keypair is generated on first launch and persisted to internal storage
 * (encrypted via [com.pdatahub.hub.data.crypto.CryptoBox]). The public key
 * is the user's stable identity — the private key never leaves the device.
 *
 * Identity is used for:
 *   - Pairing QR codes (signs the session token)
 *   - Audit log signing
 *   - Future federation (cross-Hub trust)
 */
@Singleton
class IdentityManager @Inject constructor(
    @ApplicationContext private val context: Context,
    private val keystore: IdentityKeystore,
) {

    data class Identity(val publicKey: ByteArray, val privateKey: ByteArray) {
        val publicKeyBase64: String get() = Base64.getUrlEncoder().withoutPadding().encodeToString(publicKey)

        override fun equals(other: Any?): Boolean = other is Identity && publicKey.contentEquals(other.publicKey)
        override fun hashCode(): Int = publicKey.contentHashCode()
    }

    @Volatile
    private var cached: Identity? = null

    fun getOrCreate(): Identity {
        cached?.let { return it }

        synchronized(this) {
            cached?.let { return it }
            val existing = keystore.load()
            val identity = existing ?: generateAndStore()
            cached = identity
            return identity
        }
    }

    fun publicKeyBase64(): String = getOrCreate().publicKeyBase64

    private fun generateAndStore(): Identity {
        val identity = generate()
        keystore.store(identity)
        return identity
    }

    private fun generate(): Identity {
        // Prefer Android Keystore Ed25519 (API 33+) — falls back to BouncyCastle
        // for older devices.
        return try {
            generateAndroidKeystore()
        } catch (e: Throwable) {
            generateBouncyCastle()
        }
    }

    private fun generateAndroidKeystore(): Identity {
        val gen = KeyPairGenerator.getInstance("Ed25519")
        gen.initialize(255)
        val kp = gen.generateKeyPair()
        return Identity(
            publicKey = kp.public.encoded,
            privateKey = kp.private.encoded,
        )
    }

    private fun generateBouncyCastle(): Identity {
        val gen = Ed25519KeyPairGenerator()
        gen.init(Ed25519KeyGenerationParameters(SecureRandom()))
        val kp = gen.generateKeyPair()
        val priv = kp.private as Ed25519PrivateKeyParameters
        val pub = kp.public as Ed25519PublicKeyParameters
        return Identity(
            publicKey = pub.encoded,
            privateKey = priv.encoded,
        )
    }
}
