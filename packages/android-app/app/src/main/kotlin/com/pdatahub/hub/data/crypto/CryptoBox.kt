package com.pdatahub.hub.data.crypto

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import com.google.crypto.tink.Aead
import com.google.crypto.tink.KeyTemplates
import com.google.crypto.tink.aead.AeadConfig
import com.google.crypto.tink.integration.android.AndroidKeysetManager
import dagger.hilt.android.qualifiers.ApplicationContext
import java.util.Base64
import javax.inject.Inject
import javax.inject.Singleton
import android.security.keystore.KeyPermanentlyInvalidatedException

/**
 * Authenticated encryption wrapper used to encrypt sensitive blobs at rest:
 *   - Identity keypair
 *   - OAuth tokens per plugin
 *   - Pairing session tokens
 *
 * Uses Tink with an Android Keystore-backed master key. On API 23+ this gives
 * hardware-backed encryption when available.
 *
 * Format: Tink's AEAD envelope — nonces and tags are appended to ciphertext.
 * Per-tink docs, no manual nonce management required.
 */
@Singleton
class CryptoBox @Inject constructor(
    @ApplicationContext context: Context,
) {
    init {
        AeadConfig.register()
    }

    private val aead: Aead by lazy {
        try {
            val keysetHandle = AndroidKeysetManager.Builder()
                .withSharedPref(context, KEYSET_NAME, PREFS_NAME)
                .withKeyTemplate(KeyTemplates.get("AES256_GCM"))
                .withMasterKeyUri(MASTER_KEY_URI)
                .build()
                .keysetHandle
            keysetHandle.getPrimitive(Aead::class.java)
        } catch (e: KeyPermanentlyInvalidatedException) {
            // User removed device credentials — wipe and rebuild.
            context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit().clear().apply()
            AndroidKeysetManager.Builder()
                .withSharedPref(context, KEYSET_NAME, PREFS_NAME)
                .withKeyTemplate(KeyTemplates.get("AES256_GCM"))
                .withMasterKeyUri(MASTER_KEY_URI)
                .build()
                .keysetHandle
                .getPrimitive(Aead::class.java)
        }
    }

    fun encrypt(plaintext: ByteArray, associatedData: ByteArray = ByteArray(0)): ByteArray =
        aead.encrypt(plaintext, associatedData)

    fun decrypt(ciphertext: ByteArray, associatedData: ByteArray = ByteArray(0)): ByteArray? = try {
        aead.decrypt(ciphertext, associatedData)
    } catch (e: Throwable) {
        null
    }

    fun encryptString(plaintext: String, associatedData: ByteArray = ByteArray(0)): String =
        Base64.getUrlEncoder().withoutPadding().encodeToString(encrypt(plaintext.toByteArray(Charsets.UTF_8), associatedData))

    fun decryptString(ciphertext: String, associatedData: ByteArray = ByteArray(0)): String? = try {
        val raw = Base64.getUrlDecoder().decode(ciphertext)
        decrypt(raw, associatedData)?.toString(Charsets.UTF_8)
    } catch (e: Throwable) {
        null
    }

    companion object {
        private const val KEYSET_NAME = "pdatahub_aead_keyset"
        private const val PREFS_NAME = "pdatahub_aead_prefs"
        private const val MASTER_KEY_URI = "android-keystore://pdatahub_master_key"
    }
}
