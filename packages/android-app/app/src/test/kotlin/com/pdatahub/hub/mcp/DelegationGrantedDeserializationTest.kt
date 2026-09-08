package com.pdatahub.hub.mcp

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DelegationGrantedDeserializationTest {

    private val json = Json { ignoreUnknownKeys = true }

    @Test
    fun `DelegationGranted deserializes with revoked 0 (active)`() {
        val payload = """
            {
              "delegation_id": "d-1",
              "peer_verify_key": "ed25519:peer_key_full",
              "peer_hub_name": "userB",
              "plugin": "google-calendar",
              "tool": "listEvents",
              "scope": "calendar:read",
              "expires_at": "2026-12-31T00:00:00Z",
              "revoked": 0,
              "created_at": "2026-09-01T00:00:00Z"
            }
        """.trimIndent()
        val d = json.decodeFromString<DelegationGranted>(payload)
        assertEquals(0, d.revoked)
        assertFalse("revoked=0 must map to not revoked", d.isRevoked)
    }

    @Test
    fun `DelegationGranted deserializes with revoked 1 (revoked)`() {
        val payload = """
            {
              "delegation_id": "d-2",
              "peer_verify_key": "ed25519:peer_key_full",
              "peer_hub_name": null,
              "plugin": "google-calendar",
              "tool": "listEvents",
              "scope": "calendar:read",
              "expires_at": "2026-12-31T00:00:00Z",
              "revoked": 1,
              "created_at": "2026-09-01T00:00:00Z"
            }
        """.trimIndent()
        val d = json.decodeFromString<DelegationGranted>(payload)
        assertEquals(1, d.revoked)
        assertTrue("revoked=1 must map to revoked", d.isRevoked)
        assertEquals(null, d.peer_hub_name)
    }

    @Test
    fun `DelegationsResponse defaults missing lists to empty`() {
        val payload = """{ "granted": [], "received": [] }"""
        val r = json.decodeFromString<DelegationsResponse>(payload)
        assertTrue(r.granted.isEmpty())
        assertTrue(r.received.isEmpty())
    }

    @Test
    fun `DelegationsResponse tolerates missing granted or received key`() {
        val onlyGranted = """{ "granted": [
            {
              "delegation_id": "d-3",
              "peer_verify_key": "ed25519:p",
              "peer_hub_name": "x",
              "plugin": "p", "tool": "t", "scope": "s",
              "expires_at": "2026-12-31T00:00:00Z",
              "revoked": 0, "created_at": "2026-09-01T00:00:00Z"
            } ] }"""
        val r = json.decodeFromString<DelegationsResponse>(onlyGranted)
        assertEquals(1, r.granted.size)
        assertTrue(r.received.isEmpty())
    }
}
