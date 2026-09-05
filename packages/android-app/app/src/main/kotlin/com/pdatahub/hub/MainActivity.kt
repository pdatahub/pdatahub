package com.pdatahub.hub

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
                        onPairingToggle = { viewModel.togglePairing() },
                        onRelayUrlChange = { viewModel.setRelayUrl(it) },
                        onHubCoreUrlChange = { viewModel.setHubCoreUrl(it) },
                        onApprove = { viewModel.approve(it) },
                        onDeny = { viewModel.deny(it) },
                    )
                }
            }
        }
    }
}
