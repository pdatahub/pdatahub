package com.pdatahub.hub.ui.home

import com.pdatahub.hub.mcp.AuditEntry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AuditRowFederationTest {

    private fun base(
        delegated_by: String? = null,
        delegated_to: String? = null,
        decision: String = "approved",
        decision_federated: String? = null,
    ) = AuditEntry(
        id = "audit-1",
        timestamp = "2026-09-07T12:00:00Z",
        agent_id = "B_local_agent",
        user_id = "local-user",
        tool_name = "listEvents",
        plugin = "google-calendar",
        scope = "calendar:read",
        justification = null,
        decision = decision,
        grant_id = null,
        duration_ms = 450,
        error = null,
        delegated_by = delegated_by,
        delegated_to = delegated_to,
        decision_federated = decision_federated,
    )

    @Test
    fun `truncateKey returns whole string when shorter than head`() {
        assertEquals("abc", truncateKey("abc", 12))
    }

    @Test
    fun `truncateKey returns first head chars plus ellipsis when longer`() {
        val key = "ed25519:B_public_key_very_long"
        assertEquals("ed25519:B_pu…", truncateKey(key, 12))
    }

    @Test
    fun `local-only audit entry has no federation marker in line`() {
        val entry = base()
        val line = formatAuditMainLine(entry)
        assertTrue(line.startsWith("approved"))
        assertFalse("must not include delegated_by", line.contains("delegated_by"))
        assertFalse("must not include from", line.contains("from "))
        assertFalse("must not include federated_", line.contains("federated_"))
    }

    @Test
    fun `federated audit entry shows peer via from-prefix and truncated key`() {
        val entry = base(
            delegated_by = "ed25519:B_public_key_full_string",
            decision_federated = "federated_ok",
        )
        val line = formatAuditMainLine(entry)
        assertTrue("must include federation marker", line.contains("(federated_ok)"))
        assertTrue("must include truncated delegated_by", line.contains("from ed25519:B_pu"))
    }

    @Test
    fun `federated_denied uses error color mapping`() {
        val entry = base(
            delegated_by = "ed25519:B_key",
            decision = "approved",
            decision_federated = "federated_denied",
        )
        val outcome = federatedOutcome(entry)
        assertEquals(AuditOutcome.DENIED, outcome)
    }

    @Test
    fun `federated_ok uses tertiary mapping`() {
        val entry = base(
            delegated_by = "ed25519:B_key",
            decision = "approved",
            decision_federated = "federated_ok",
        )
        val outcome = federatedOutcome(entry)
        assertEquals(AuditOutcome.OK, outcome)
    }

    @Test
    fun `local entry maps to outcome by decision field`() {
        assertEquals(AuditOutcome.OK, federatedOutcome(base(decision = "approved")))
        assertEquals(AuditOutcome.DENIED, federatedOutcome(base(decision = "denied")))
        assertEquals(AuditOutcome.ERROR, federatedOutcome(base(decision = "error")))
        assertEquals(AuditOutcome.OTHER, federatedOutcome(base(decision = "pending")))
    }

    @Test
    fun `isFederated reflects delegated_by or delegated_to presence`() {
        assertFalse(isFederatedAudit(base()))
        assertTrue(isFederatedAudit(base(delegated_by = "ed25519:x")))
        assertTrue(isFederatedAudit(base(delegated_to = "ed25519:y")))
    }
}
