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
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.pdatahub.hub.R
import com.pdatahub.hub.pairing.QrRenderer

@Composable
fun HomeScreen(
    state: HomeUiState,
    onStartServer: () -> Unit,
    onStopServer: () -> Unit,
    onPairingToggle: () -> Unit,
    onRelayUrlChange: (String) -> Unit,
    onRefreshTools: () -> Unit,
    onInstallPlugin: (String) -> Unit,
    showInstallDialog: Boolean,
    onShowInstallDialog: () -> Unit,
    onDismissInstallDialog: () -> Unit,
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
            qrPayload = state.qrPayload,
            relayUrl = state.relayUrl,
            onToggle = onPairingToggle,
            onRelayUrlChange = onRelayUrlChange,
        )

        PluginsCard(
            tools = state.tools,
            onRefresh = onRefreshTools,
            onAdd = onShowInstallDialog,
        )

        if (showInstallDialog) {
            InstallPluginDialog(
                onDismiss = onDismissInstallDialog,
                onInstall = { path ->
                    onInstallPlugin(path)
                    onDismissInstallDialog()
                },
            )
        }
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
private fun PairingCard(
    sessionToken: String?,
    qrPayload: String?,
    relayUrl: String,
    onToggle: () -> Unit,
    onRelayUrlChange: (String) -> Unit,
) {
    val qrBitmap = remember(qrPayload) { qrPayload?.let { QrRenderer.render(it) } }
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(text = stringRes(R.string.hub_pairing_title), style = MaterialTheme.typography.titleSmall)
            Text(
                text = stringRes(R.string.hub_pairing_subtitle),
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
private fun PluginsCard(
    tools: List<ToolItem>,
    onRefresh: () -> Unit,
    onAdd: () -> Unit,
) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = stringRes(R.string.hub_tools_label),
                    style = MaterialTheme.typography.titleSmall,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    OutlinedButton(onClick = onRefresh) { Text("Refresh") }
                    Button(onClick = onAdd) { Text("Add") }
                }
            }
            HorizontalDivider()
            if (tools.isEmpty()) {
                Text(
                    text = stringRes(R.string.hub_tools_empty),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            } else {
                tools.forEach { tool -> ToolRow(tool = tool) }
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

@Composable
private fun InstallPluginDialog(
    onDismiss: () -> Unit,
    onInstall: (String) -> Unit,
) {
    var path by rememberSaveable { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Install plugin") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    "Absolute path to plugin entry point (e.g. /data/data/com.termux/files/home/.npm-global/lib/node_modules/pdatahub-plugin-google-calendar/dist/index.js)",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                OutlinedTextField(
                    value = path,
                    onValueChange = { path = it },
                    label = { Text("Plugin path") },
                    singleLine = false,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        },
        confirmButton = {
            TextButton(
                onClick = { onInstall(path.trim()) },
                enabled = path.isNotBlank(),
            ) {
                Text("Install")
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Cancel") }
        },
    )
}

@Composable
private fun stringRes(id: Int): String = androidx.compose.ui.res.stringResource(id = id)
