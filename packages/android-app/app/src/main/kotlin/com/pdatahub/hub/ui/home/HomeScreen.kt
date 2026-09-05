package com.pdatahub.hub.ui.home

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.pdatahub.hub.R
import com.pdatahub.hub.pairing.QrRenderer
import com.pdatahub.hub.ui.approval.PendingApprovalRequest

@Composable
fun HomeScreen(
    state: HomeUiState,
    onPairingToggle: () -> Unit,
    onRelayUrlChange: (String) -> Unit,
    onHubCoreUrlChange: (String) -> Unit,
    onApprove: (String) -> Unit,
    onDeny: (String) -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(24.dp)
            .verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(20.dp),
    ) {
        Text(
            text = "pdatahub",
            style = MaterialTheme.typography.headlineMedium,
        )
        Text(
            text = "Personal Data Hub — Android UI client. Hub core (Node.js) runs on your laptop.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        IdentityCard(publicKeyBase64 = state.publicKeyBase64)

        HubCoreCard(
            hubCoreUrl = state.hubCoreUrl,
            connected = state.approvalStreamConnected,
            onHubCoreUrlChange = onHubCoreUrlChange,
        )

        PairingCard(
            sessionToken = state.sessionToken,
            qrPayload = state.qrPayload,
            relayUrl = state.relayUrl,
            onToggle = onPairingToggle,
            onRelayUrlChange = onRelayUrlChange,
        )

        PendingApprovalsCard(
            approvals = state.pendingApprovals,
            onApprove = onApprove,
            onDeny = onDeny,
        )
    }
}

@Composable
private fun IdentityCard(publicKeyBase64: String) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(text = "Identity", style = MaterialTheme.typography.titleSmall)
            Text(
                text = publicKeyBase64.ifBlank { "(not yet generated)" },
                style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
            )
        }
    }
}

@Composable
private fun HubCoreCard(
    hubCoreUrl: String,
    connected: Boolean,
    onHubCoreUrlChange: (String) -> Unit,
) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = "Hub core",
                    style = MaterialTheme.typography.titleSmall,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    text = if (connected) "● connected" else "○ disconnected",
                    style = MaterialTheme.typography.bodySmall,
                    color = if (connected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error,
                )
            }
            Text(
                text = "Node.js process running on your laptop (ws://laptop:8090).",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            OutlinedTextField(
                value = hubCoreUrl,
                onValueChange = onHubCoreUrlChange,
                label = { Text("Hub core URL") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

@Composable
private fun PairingCard(
    sessionToken: String?,
    qrPayload: String?,
    relayUrl: String,
    onToggle: () -> Unit,
    onRelayUrlChange: (String) -> Unit,
) {
    val qrBitmap = qrPayload?.let { QrRenderer.render(it) }
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(text = "Pairing (Cloudflare Relay)", style = MaterialTheme.typography.titleSmall)
            Text(
                text = "Scan QR code with pdatahub-mcp on your laptop to pair this device.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            if (qrBitmap != null) {
                Column(
                    horizontalAlignment = Alignment.CenterHorizontally,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Image(
                        bitmap = qrBitmap.asImageBitmap(),
                        contentDescription = "Pairing QR code",
                        modifier = Modifier
                            .size(224.dp)
                            .clip(RoundedCornerShape(8.dp)),
                    )
                    Spacer(modifier = Modifier.height(8.dp))
                    Text(
                        text = "Token: $sessionToken",
                        style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                    )
                }
            }

            OutlinedTextField(
                value = relayUrl,
                onValueChange = onRelayUrlChange,
                label = { Text("Relay URL") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                modifier = Modifier.fillMaxWidth(),
            )

            OutlinedButton(onClick = onToggle) {
                Text(if (sessionToken == null) "Start pairing" else "Cancel pairing")
            }
        }
    }
}

@Composable
private fun PendingApprovalsCard(
    approvals: List<PendingApprovalRequest>,
    onApprove: (String) -> Unit,
    onDeny: (String) -> Unit,
) {
    val containerColor = if (approvals.isEmpty()) {
        MaterialTheme.colorScheme.surface
    } else {
        MaterialTheme.colorScheme.primaryContainer
    }
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = containerColor),
    ) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(text = "Pending approvals", style = MaterialTheme.typography.titleSmall)
            if (approvals.isEmpty()) {
                Text(
                    text = "No pending requests.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            } else {
                approvals.forEach { request ->
                    ApprovalRow(
                        request = request,
                        onApprove = onApprove,
                        onDeny = onDeny,
                    )
                }
            }
        }
    }
}

@Composable
private fun ApprovalRow(
    request: PendingApprovalRequest,
    onApprove: (String) -> Unit,
    onDeny: (String) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(
            text = "${request.agentId} → ${request.toolName}",
            style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
        )
        Text(
            text = "scope: ${request.scope}",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.primary,
        )
        if (request.justification != null) {
            Text(
                text = request.justification,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { onApprove(request.requestId) }) {
                Text("Approve")
            }
            OutlinedButton(onClick = { onDeny(request.requestId) }) {
                Text("Deny")
            }
        }
    }
}

@Composable
private fun stringRes(id: Int): String = androidx.compose.ui.res.stringResource(id = id)
