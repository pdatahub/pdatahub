package com.pdatahub.hub.ui.home

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.pdatahub.hub.data.identity.IdentityManager
import com.pdatahub.hub.pairing.PairingManager
import com.pdatahub.hub.plugin.PluginManager
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch
import javax.inject.Inject

data class HomeUiState(
    val publicKeyBase64: String = "",
    val sessionToken: String? = null,
    val pairingPayload: String? = null,
    val tools: List<ToolItem> = emptyList(),
    val nodePathResolved: Boolean = false,
)

data class ToolItem(
    val pluginName: String,
    val toolName: String,
    val description: String,
    val scope: String,
)

@HiltViewModel
class HomeViewModel @Inject constructor(
    private val identity: IdentityManager,
    private val pairing: PairingManager,
    private val plugins: PluginManager,
) : ViewModel() {

    private val _state = MutableStateFlow(
        HomeUiState(
            publicKeyBase64 = identity.publicKeyBase64(),
            nodePathResolved = plugins.resolveNodePath() != null,
        )
    )
    val state: StateFlow<HomeUiState> = _state.asStateFlow()

    init {
        viewModelScope.launch {
            pairing.state.collect { pairingState ->
                val token = when (pairingState) {
                    is PairingManager.PairingState.AwaitingLaptop -> pairingState.sessionToken
                    is PairingManager.PairingState.Active -> pairingState.sessionToken
                    PairingManager.PairingState.Idle -> null
                }
                _state.value = _state.value.copy(sessionToken = token)
            }
        }
        viewModelScope.launch {
            plugins.manifests.collect { manifests ->
                val tools = manifests.values.flatMap { manifest ->
                    manifest.tools.map { tool ->
                        ToolItem(
                            pluginName = manifest.name,
                            toolName = tool.name,
                            description = tool.description,
                            scope = tool.scope,
                        )
                    }
                }
                _state.value = _state.value.copy(tools = tools)
            }
        }
    }

    fun togglePairing() {
        when (pairing.state.value) {
            PairingManager.PairingState.Idle -> pairing.startPairing()
            else -> pairing.cancel()
        }
    }

    fun refreshTools() {
        viewModelScope.launch {
            // Re-scan manifests. Real impl would re-read PluginDao and restart processes.
        }
    }
}
