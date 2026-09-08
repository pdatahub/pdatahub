package com.pdatahub.hub

import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AppCompatActivity
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.hilt.navigation.compose.hiltViewModel
import com.pdatahub.hub.ui.delegation.DelegationManagementScreen
import com.pdatahub.hub.ui.home.HomeScreen
import com.pdatahub.hub.ui.home.HomeViewModel
import com.pdatahub.hub.ui.theme.PdatahubTheme
import dagger.hilt.android.AndroidEntryPoint

private enum class Screen { Home, Federation }

@AndroidEntryPoint
class MainActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            PdatahubTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    var screen by remember { mutableStateOf(Screen.Home) }
                    when (screen) {
                        Screen.Home -> {
                            val viewModel: HomeViewModel = hiltViewModel()
                            val state by viewModel.state.collectAsState()
                            HomeScreen(
                                state = state,
                                onPairingToggle = { viewModel.togglePairing() },
                                onRelayUrlChange = { viewModel.setRelayUrl(it) },
                                onHubCoreUrlChange = { viewModel.setHubCoreUrl(it) },
                                onBiometricEnabledChange = { viewModel.setBiometricEnabled(it) },
                                onApprove = { viewModel.approve(it) },
                                onDeny = { viewModel.deny(it) },
                                onLoadGrants = { viewModel.loadGrants() },
                                onRevokeGrant = { viewModel.revokeGrant(it) },
                                onLoadAuditHistory = { viewModel.loadAuditHistory() },
                                onOpenFederation = { screen = Screen.Federation },
                            )
                        }
                        Screen.Federation -> {
                            DelegationManagementScreen()
                        }
                    }
                }
            }
        }
    }
}
