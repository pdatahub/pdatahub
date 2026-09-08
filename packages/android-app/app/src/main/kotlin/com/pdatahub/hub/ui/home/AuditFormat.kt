package com.pdatahub.hub.ui.home

import com.pdatahub.hub.mcp.AuditEntry

internal enum class AuditOutcome { OK, DENIED, ERROR, OTHER }

internal fun federatedOutcome(entry: AuditEntry): AuditOutcome = when (entry.decision_federated) {
    "federated_ok" -> AuditOutcome.OK
    "federated_denied" -> AuditOutcome.DENIED
    else -> when (entry.decision) {
        "approved" -> AuditOutcome.OK
        "denied", "revoked" -> AuditOutcome.DENIED
        "error" -> AuditOutcome.ERROR
        else -> AuditOutcome.OTHER
    }
}

internal fun formatAuditMainLine(entry: AuditEntry): String = buildString {
    append(entry.decision)
    if (entry.decision_federated != null) append(" (${entry.decision_federated})")
    append(" · scope: ${entry.scope} · agent: ${entry.agent_id}")
    entry.delegated_by?.let { append(" · from ${truncateKey(it, 12)}") }
    entry.error?.let { append(" · error: $it") }
}

internal fun isFederatedAudit(entry: AuditEntry): Boolean =
    entry.delegated_by != null || entry.delegated_to != null

internal fun truncateKey(key: String, head: Int): String {
    if (key.length <= head) return key
    return key.take(head) + "…"
}
