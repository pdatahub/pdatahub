package com.pdatahub.hub.ui.home

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.pdatahub.hub.R

@Composable
fun HomeScreen(
    state: HomeUiState,
    onStartServer: () -> Unit,
    onStopServer: () -> Unit,
    onPairingToggle: () -> Unit,
    onRefreshTools: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(24.dp)
            .verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(20.dp),
    ) {
        Text(
            text = stringRes(R.string.hub_title),
            style = MaterialTheme.typography.headlineMedium,
        )
        Text(
            text = stringRes(R.string.hub_subtitle),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        IdentityCard(publicKeyBase64 = state.publicKeyBase64)

        ServerControlCard(
            nodePathResolved = state.nodePathResolved,
            onStart = onStartServer,
            onStop = onStopServer,
        )

        PairingCard(
            sessionToken = state.sessionToken,
            onToggle = onPairingToggle,
        )

        ToolsCard(
            tools = state.tools,
            onRefresh = onRefreshTools,
        )
    }
}

@Composable
private fun IdentityCard(publicKeyBase64: String) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(text = stringRes(R.string.hub_public_key_label), style = MaterialTheme.typography.titleSmall)
            Text(
                text = publicKeyBase64.ifBlank { "(not yet generated)" },
                style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
            )
        }
    }
}

@Composable
private fun ServerControlCard(
    nodePathResolved: Boolean,
    onStart: () -> Unit,
    onStop: () -> Unit,
) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = onStart, enabled = nodePathResolved) {
                    Text(stringRes(R.string.hub_status_start))
                }
                OutlinedButton(onClick = onStop) {
                    Text(stringRes(R.string.hub_status_stop))
                }
            }
            if (!nodePathResolved) {
                Text(
                    text = "`node` binary not found. Install via Termux and set the path in settings.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }
        }
    }
}

@Composable
private fun PairingCard(sessionToken: String?, onToggle: () -> Unit) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(text = stringRes(R.string.hub_pairing_title), style = MaterialTheme.typography.titleSmall)
            Text(
                text = stringRes(R.string.hub_pairing_subtitle),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (sessionToken != null) {
                Text(
                    text = stringRes(R.string.hub_pairing_session_label),
                    style = MaterialTheme.typography.labelSmall,
                )
                Text(
                    text = sessionToken,
                    style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                )
            }
            OutlinedButton(onClick = onToggle) {
                Text(if (sessionToken == null) "Start pairing" else "Cancel pairing")
            }
        }
    }
}

@Composable
private fun ToolsCard(tools: List<ToolItem>, onRefresh: () -> Unit) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    text = stringRes(R.string.hub_tools_label),
                    style = MaterialTheme.typography.titleSmall,
                    modifier = Modifier.padding(end = 8.dp),
                )
                OutlinedButton(onClick = onRefresh) { Text("Refresh") }
            }
            HorizontalDivider()
            if (tools.isEmpty()) {
                Text(
                    text = stringRes(R.string.hub_tools_empty),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            } else {
                tools.forEach { tool ->
                    ToolRow(tool = tool)
                }
            }
        }
    }
}

@Composable
private fun ToolRow(tool: ToolItem) {
    Column(modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(
            text = "${tool.pluginName} :: ${tool.toolName}",
            style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
        )
        Text(
            text = tool.description,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            text = "scope: ${tool.scope}",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.primary,
        )
    }
}

/** Local helper — Compose's stringResource isn't directly callable in previews here. */
@Composable
private fun stringRes(id: Int): String = androidx.compose.ui.res.stringResource(id = id)
