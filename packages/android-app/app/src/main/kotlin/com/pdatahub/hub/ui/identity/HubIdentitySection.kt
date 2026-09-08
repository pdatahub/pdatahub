package com.pdatahub.hub.ui.identity

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel

@Composable
fun HubIdentitySection(viewModel: HubIdentityViewModel = hiltViewModel()) {
    val state by viewModel.state.collectAsState()
    val context = LocalContext.current

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
                Text("Hub identity", style = MaterialTheme.typography.titleSmall)
                OutlinedButton(onClick = { viewModel.refresh() }) { Text("Refresh") }
            }
            Text(
                text = "Public identity of this hub. Share the verify_key with peers to receive delegations.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            when (val s = state) {
                HubIdentityUiState.Loading -> Text(
                    text = "Loading…",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                is HubIdentityUiState.Error -> Text(
                    text = "Failed to load: ${s.message}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
                is HubIdentityUiState.Loaded -> Column(
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    IdentityField(
                        label = "Hub name",
                        value = s.identity.hub_name,
                        copyValue = s.identity.hub_name,
                        context = context,
                    )
                    IdentityField(
                        label = "Verify key",
                        value = truncate(s.identity.verify_key, 24) + "…",
                        copyValue = s.identity.verify_key,
                        context = context,
                    )
                    IdentityField(
                        label = "Fingerprint",
                        value = s.identity.fingerprint,
                        copyValue = s.identity.fingerprint,
                        context = context,
                    )
                    IdentityField(
                        label = "Magic DNS",
                        value = s.identity.magic_dns ?: "not detected",
                        copyValue = s.identity.magic_dns,
                        context = context,
                    )
                }
            }
        }
    }
}

@Composable
private fun IdentityField(
    label: String,
    value: String,
    copyValue: String?,
    context: Context,
) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
        ) {
            Text(
                text = value,
                style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                modifier = Modifier.weight(1f),
            )
            if (copyValue != null) {
                TextButton(onClick = { copyToClipboard(context, copyValue) }) {
                    Text("Copy")
                }
            }
        }
    }
}

private fun truncate(value: String, head: Int): String {
    if (value.length <= head) return value
    return value.take(head)
}

private fun copyToClipboard(context: Context, value: String) {
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    clipboard.setPrimaryClip(ClipData.newPlainText("hub-identity", value))
}
