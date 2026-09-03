package com.pdatahub.hub

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.hilt.navigation.compose.hiltViewModel
import com.pdatahub.hub.mcp.McpServerService
import com.pdatahub.hub.ui.home.HomeScreen
import com.pdatahub.hub.ui.home.HomeViewModel
import com.pdatahub.hub.ui.theme.PdatahubTheme
import dagger.hilt.android.AndroidEntryPoint

@AndroidEntryPoint
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            PdatahubTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    val viewModel: HomeViewModel = hiltViewModel()
                    val state by viewModel.state.collectAsState()
                    HomeScreen(
                        state = state,
                        onStartServer = { startServer() },
                        onStopServer = { stopServer() },
                        onPairingToggle = { viewModel.togglePairing() },
                        onRelayUrlChange = { viewModel.setRelayUrl(it) },
                        onRefreshTools = { viewModel.refreshTools() },
                        onInstallPlugin = { path -> viewModel.installPlugin(path) },
                        showInstallDialog = state.showInstallDialog,
                        onShowInstallDialog = { viewModel.showInstallDialog() },
                        onDismissInstallDialog = { viewModel.dismissInstallDialog() },
                    )
                }
            }
        }
    }

    private fun startServer() {
        val intent = Intent(this, McpServerService::class.java).apply { action = McpServerService.ACTION_START }
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            startForegroundService(intent)
        } else {
            startService(intent)
        }
    }

    private fun stopServer() {
        val intent = Intent(this, McpServerService::class.java).apply { action = McpServerService.ACTION_STOP }
        startService(intent)
    }
}
