package com.pdatahub.hub.ui.delegation

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import com.pdatahub.hub.mcp.DelegationGranted

@Composable
fun DelegationManagementScreen(
    viewModel: DelegationManagementViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsState()
    var pendingRevoke by remember { mutableStateOf<String?>(null) }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(24.dp)
            .verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(20.dp),
    ) {
        Text(
            text = "Federation",
            style = MaterialTheme.typography.headlineMedium,
        )
        Text(
            text = "Manage delegations granted to peer hubs. Revoking takes effect immediately for new calls; in-flight calls complete normally.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        Card(modifier = Modifier.fillMaxWidth()) {
            Column(
                modifier = Modifier.padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
                ) {
                    Text("Delegations", style = MaterialTheme.typography.titleSmall)
                    OutlinedButton(onClick = { viewModel.refresh() }) { Text("Refresh") }
                }
                when (val s = state) {
                    DelegationListUiState.Loading -> Text(
                        "Loading…",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    is DelegationListUiState.Error -> Text(
                        "Failed: ${s.message}",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                    )
                    is DelegationListUiState.Loaded -> {
                        if (s.granted.isEmpty() && s.received.isEmpty()) {
                            Text(
                                "No delegations yet. Create one from the CLI: `pdatahub-hub delegate …`",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        } else {
                            s.revokeError?.let {
                                Text(
                                    "Revoke error: $it",
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.error,
                                )
                            }
                            if (s.granted.isNotEmpty()) {
                                Text(
                                    "Granted to peers (${s.granted.size})",
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                                s.granted.forEach { d ->
                                    DelegationRow(
                                        delegation = d,
                                        isRevoking = s.revokingId == d.delegation_id,
                                        onRevokeClick = { pendingRevoke = d.delegation_id },
                                    )
                                }
                            }
                            if (s.received.isNotEmpty()) {
                                Text(
                                    "Received from peers (${s.received.size})",
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                                s.received.forEach { d ->
                                    DelegationRow(
                                        delegation = d,
                                        isRevoking = false,
                                        onRevokeClick = null,
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    pendingRevoke?.let { id ->
        AlertDialog(
            onDismissRequest = { pendingRevoke = null },
            title = { Text("Revoke delegation?") },
            text = { Text("Delegation $id will be marked revoked. New calls against it will fail; in-flight calls complete normally.") },
            confirmButton = {
                TextButton(onClick = {
                    viewModel.revoke(id)
                    pendingRevoke = null
                }) { Text("Revoke") }
            },
            dismissButton = {
                TextButton(onClick = { pendingRevoke = null }) { Text("Cancel") }
            },
        )
    }
}

@Composable
private fun DelegationRow(
    delegation: DelegationGranted,
    isRevoking: Boolean,
    onRevokeClick: (() -> Unit)?,
) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(
            text = "${delegation.plugin} :: ${delegation.tool}",
            style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
        )
        Text(
            text = "scope: ${delegation.scope} · expires: ${delegation.expires_at}",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.primary,
        )
        Text(
            text = "peer: ${delegation.peer_hub_name ?: truncate(delegation.peer_verify_key, 16)}",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Row(
            verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                text = if (delegation.isRevoked) "revoked" else "active",
                style = MaterialTheme.typography.labelSmall,
                color = if (delegation.isRevoked)
                    MaterialTheme.colorScheme.error
                else
                    MaterialTheme.colorScheme.tertiary,
            )
            if (onRevokeClick != null && !delegation.isRevoked) {
                OutlinedButton(onClick = onRevokeClick, enabled = !isRevoking) {
                    Text(if (isRevoking) "Revoking…" else "Revoke")
                }
            }
        }
    }
}

private fun truncate(value: String, head: Int): String {
    if (value.length <= head) return value
    return value.take(head) + "…"
}
