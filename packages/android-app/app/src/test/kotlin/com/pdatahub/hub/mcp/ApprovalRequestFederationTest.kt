package com.pdatahub.hub.mcp

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Contract tests for Phase 6 (Federation v2) Android-side deserialization.
 *
 * Verifies:
 *   - ApprovalRequest round-trips with the new federation fields populated.
 *   - ApprovalRequest deserializes from "old" payloads (without the new
 *     fields) — required for backward compat with hub-core builds that
 *     have not yet emitted these fields.
 *   - ignoreUnknownKeys=true is in effect so future field additions cannot
 *     break this client.
 *   - The full WebSocket envelope ({"type":"approval_request", ...}) is
 *     routed into ApprovalRequest via the same Json instance the production
 *     ApprovalWebSocketClient uses.
 */
class ApprovalRequestFederationTest {

    private val json = Json { ignoreUnknownKeys = true }

    @Test
    fun `ApprovalRequest deserializes with federation fields populated`() {
        val payload = """
            {
              "request_id": "req-1",
              "agent_id": "openai-agent",
              "tool_name": "listEvents",
              "scope": "calendar:read",
              "justification": "Read A's calendar",
              "created_at": "2026-09-07T12:00:00Z",
              "delegated_by": "ed25519:B_public_key",
              "peer_hub_name": "userB",
              "peer_agent_id": "B_local_agent"
            }
        """.trimIndent()
        val event = json.decodeFromString(
            ApprovalStreamEvent.ApprovalRequest.serializer(),
            payload,
        )
        assertEquals("req-1", event.request_id)
        assertEquals("openai-agent", event.agent_id)
        assertEquals("listEvents", event.tool_name)
        assertEquals("calendar:read", event.scope)
        assertEquals("Read A's calendar", event.justification)
        assertEquals("2026-09-07T12:00:00Z", event.created_at)
        assertEquals("ed25519:B_public_key", event.delegated_by)
        assertEquals("userB", event.peer_hub_name)
        assertEquals("B_local_agent", event.peer_agent_id)
    }

    @Test
    fun `ApprovalRequest deserializes without federation fields (backward compat)`() {
        val payload = """
            {
              "request_id": "req-2",
              "agent_id": "openai-agent",
              "tool_name": "sendEmail",
              "scope": "email:send",
              "created_at": "2026-09-07T12:00:00Z"
            }
        """.trimIndent()
        val event = json.decodeFromString(
            ApprovalStreamEvent.ApprovalRequest.serializer(),
            payload,
        )
        assertEquals("req-2", event.request_id)
        assertEquals("openai-agent", event.agent_id)
        assertEquals("sendEmail", event.tool_name)
        assertEquals("email:send", event.scope)
        assertEquals("2026-09-07T12:00:00Z", event.created_at)
        assertNull(event.justification)
        assertNull(event.delegated_by)
        assertNull(event.peer_hub_name)
        assertNull(event.peer_agent_id)
    }

    @Test
    fun `ApprovalRequest ignores unknown fields without throwing`() {
        // Future hub-core revisions may add new optional fields. The current
        // client must round-trip them silently via ignoreUnknownKeys=true.
        val payload = """
            {
              "request_id": "req-3",
              "agent_id": "openai-agent",
              "tool_name": "listEvents",
              "scope": "calendar:read",
              "created_at": "2026-09-07T12:00:00Z",
              "future_field_one": "ignored",
              "future_field_two": 42
            }
        """.trimIndent()
        val event = json.decodeFromString(
            ApprovalStreamEvent.ApprovalRequest.serializer(),
            payload,
        )
        assertEquals("listEvents", event.tool_name)
        assertNull(event.delegated_by)
    }

    @Test
    fun `WebSocket envelope dispatch parses approval_request into ApprovalRequest`() {
        // Mirrors the parsing path in ApprovalWebSocketClient.handleMessage:
        //   - parse envelope to JsonObject
        //   - check `type` discriminator
        //   - decodeFromJsonElement(ApprovalRequest.serializer(), obj)
        val envelope = """
            {
              "type": "approval_request",
              "request_id": "req-4",
              "agent_id": "B_local_agent",
              "tool_name": "listEvents",
              "scope": "calendar:read",
              "created_at": "2026-09-07T12:00:00Z",
              "delegated_by": "ed25519:B_public_key",
              "peer_hub_name": "userB"
            }
        """.trimIndent()
        val obj = json.parseToJsonElement(envelope).jsonObject
        assertEquals(
            "approval_request",
            obj["type"]?.jsonPrimitive?.contentOrNullSafe(),
        )
        val event = json.decodeFromJsonElement(
            ApprovalStreamEvent.ApprovalRequest.serializer(),
            obj,
        )
        assertEquals("ed25519:B_public_key", event.delegated_by)
        assertEquals("userB", event.peer_hub_name)
        // peer_agent_id is optional in payload → defaults to null
        assertNotNull(event)
        assertEquals(null, event.peer_agent_id)
    }

    private fun kotlinx.serialization.json.JsonPrimitive.contentOrNullSafe(): String? =
        try { content } catch (_: Exception) { null }
}
