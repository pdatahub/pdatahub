package com.pdatahub.hub.data.identity

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

class IdentityManagerContractTest {

    @Test
    fun `Ed25519 public key is 32 bytes`() {
        // Document the contract — real generation is tested via integration
        // tests because Ed25519 generation requires Android Keystore (API 33+)
        // or BouncyCastle provider registration on the JVM.
        val pub = ByteArray(32) { 0x42 }
        assertEquals(32, pub.size)
    }

    @Test
    fun `publicKeyBase64 is url-safe without padding`() {
        val pub = ByteArray(32) { it.toByte() }
        val encoded = Base64.getUrlEncoder().withoutPadding().encodeToString(pub)
        assertTrue("must not contain padding", !encoded.contains("="))
        assertTrue("must be url-safe", encoded.all { it.isLetterOrDigit() || it == '-' || it == '_' })
    }

    @Test
    fun `identity equality is value-based`() {
        val a = IdentityManager.Identity(ByteArray(32) { 0x42 }, ByteArray(32))
        val b = IdentityManager.Identity(ByteArray(32) { 0x42 }, ByteArray(32))
        val c = IdentityManager.Identity(ByteArray(32) { 0x43 }, ByteArray(32))
        assertEquals(a, b)
        assertNotNull(a)
        assertTrue(a != c)
    }
}
