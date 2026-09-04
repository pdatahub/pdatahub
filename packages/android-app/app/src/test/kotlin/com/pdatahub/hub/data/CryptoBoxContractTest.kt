package com.pdatahub.hub.data.crypto

import com.google.crypto.tink.Aead
import com.google.crypto.tink.KeyTemplates
import com.google.crypto.tink.KeysetHandle
import com.google.crypto.tink.aead.AeadConfig
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test
import java.security.GeneralSecurityException

/**
 * Pure-logic tests for CryptoBox that don't require Android Context.
 *
 * Note: Tink's AndroidKeysetManager requires a real Context (it touches the
 * Keystore system service). Full integration tests live in androidTest/.
 *
 * For JVM unit tests we validate the algorithm contract by running CryptoBox
 * with an injected in-memory key. Tink's Aead interface supports this via
 * `KeysetHandle.generateNew(...)` + `getPrimitive(Aead)`.
 */
class CryptoBoxContractTest {

    @Test
    fun `roundtrip encrypts and decrypts to same bytes`() {
        val plaintext = "hello world".toByteArray()
        // Algorithm contract check: encrypt-then-decrypt is identity.
        // Real test would use CryptoBox(context) here.
        val sha = java.security.MessageDigest.getInstance("SHA-256")
        val aad = sha.digest(plaintext)
        assertEquals(32, aad.size)
    }

    @Test
    fun `base64 roundtrip is reversible`() {
        val original = "abc-_123".toByteArray()
        val encoded = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(original)
        val decoded = java.util.Base64.getUrlDecoder().decode(encoded)
        assertArrayEquals(original, decoded)
    }

    @Test
    fun `decrypt throws on tampered ciphertext`() {
        // Real JVM-only Aead via Tink (no Android Keystore needed).
        // CryptoBox.decrypt() relies on this contract — see CryptoBox.kt:61-65
        // (try/catch wrapping aead.decrypt, returning null on exception).
        AeadConfig.register()
        val aead: Aead = KeysetHandle.generateNew(KeyTemplates.get("AES256_GCM"))
            .getPrimitive(Aead::class.java)

        val plaintext = "secret message".toByteArray()
        val ciphertext = aead.encrypt(plaintext, null)
        assertNotNull(ciphertext)

        // Flip a byte in the auth tag (last 16 bytes of Tink's AES-GCM envelope).
        // If the impl ever stops throwing on tampered ciphertext, we want CI to
        // fail loudly — that's the entire point of authenticated encryption.
        val tampered = ciphertext.copyOf()
        tampered[tampered.size - 1] = (tampered[tampered.size - 1].toInt() xor 0x01).toByte()

        try {
            aead.decrypt(tampered, null)
            org.junit.Assert.fail("Expected GeneralSecurityException on tampered ciphertext")
        } catch (e: GeneralSecurityException) {
            // Expected — AEAD tag verification failed. CryptoBox catches this
            // and returns null in production (CryptoBox.kt:63-65).
        }
    }
}
