package com.pdatahub.hub.ui.approval

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ApprovalNotificationFormatTest {

    private fun local(
        agentId: String = "openai-agent",
        toolName: String = "sendEmail",
        scope: String = "email:send",
    ) = PendingApprovalRequest(
        requestId = "req-local",
        agentId = agentId,
        toolName = toolName,
        scope = scope,
        justification = null,
        createdAt = "2026-09-07T12:00:00Z",
    )

    private fun federated(
        agentId: String = "B_local_agent",
        toolName: String = "listEvents",
        peerHubName: String? = "userB",
        delegatedBy: String? = "ed25519:B_public_key",
    ) = PendingApprovalRequest(
        requestId = "req-fed",
        agentId = agentId,
        toolName = toolName,
        scope = "calendar:read",
        justification = "Read A's calendar",
        createdAt = "2026-09-07T12:00:00Z",
        delegatedBy = delegatedBy,
        peerHubName = peerHubName,
    )

    @Test
    fun `local request title mentions tool name and not federation`() {
        val title = formatApprovalTitle(local())
        assertEquals("Agent wants to call sendEmail", title)
        assertFalse("local title must not say Federated", title.contains("Federated"))
    }

    @Test
    fun `local request body mentions scope and not peer`() {
        val body = formatApprovalBody(local())
        assertEquals(
            "Agent `openai-agent` wants to call `sendEmail` on scope `email:send`. Approve?",
            body,
        )
        assertFalse("local body must not mention peer", body.contains("peer"))
    }

    @Test
    fun `federated request title mentions peer hub name`() {
        val title = formatApprovalTitle(federated(peerHubName = "userB"))
        assertEquals("Federated request from userB", title)
    }

    @Test
    fun `federated request body mentions peer agent and tool name`() {
        val body = formatApprovalBody(federated())
        assertEquals(
            "Agent `B_local_agent` wants to call `listEvents` on your hub. Approve?",
            body,
        )
    }

    @Test
    fun `federated title falls back to truncated delegated_by when peer_hub_name missing`() {
        val req = federated(peerHubName = null, delegatedBy = "ed25519:abc123def456")
        val title = formatApprovalTitle(req)
        assertEquals("Federated request from ed25519:abc", title)
    }

    @Test
    fun `federated title falls back to literal peer when neither hub name nor delegated_by available`() {
        val req = federated(peerHubName = null, delegatedBy = null)
        val title = formatApprovalTitle(req)
        assertEquals("Federated request from peer", title)
    }

    @Test
    fun `isFederated reflects delegatedBy presence`() {
        assertFalse(local().isFederated)
        assertTrue(federated().isFederated)
    }
}
