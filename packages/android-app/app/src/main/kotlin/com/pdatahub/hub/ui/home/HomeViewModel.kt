package com.pdatahub.hub.ui.home

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.pdatahub.hub.data.SettingsRepository
import com.pdatahub.hub.data.db.PluginDao
import com.pdatahub.hub.data.db.PluginEntity
import com.pdatahub.hub.data.identity.IdentityManager
import com.pdatahub.hub.pairing.PairingManager
import com.pdatahub.hub.plugin.PluginManager
import com.pdatahub.hub.ui.approval.ApprovalNotificationManager
import com.pdatahub.hub.ui.approval.PendingApprovalRequest
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

data class HomeUiState(
    val publicKeyBase64: String = "",
    val sessionToken: String? = null,
    val qrPayload: String? = null,
    val relayUrl: String = SettingsRepository.DEFAULT_RELAY_URL,
    val hubCoreUrl: String = SettingsRepository.DEFAULT_HUB_CORE_URL,
    val tools: List<ToolItem> = emptyList(),
    val nodePathResolved: Boolean = false,
    val showInstallDialog: Boolean = false,
    val installError: String? = null,
    val pendingApprovals: List<PendingApprovalRequest> = emptyList(),
    val approvalStreamConnected: Boolean = false,
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
    private val pluginDao: PluginDao,
    private val settings: SettingsRepository,
    private val approvalManager: ApprovalNotificationManager,
) : ViewModel() {

    private val _state = MutableStateFlow(
        HomeUiState(
            publicKeyBase64 = identity.publicKeyBase64(),
            nodePathResolved = plugins.resolveNodePath() != null,
            relayUrl = settings.relayUrl,
            hubCoreUrl = settings.hubCoreUrl,
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
                val qr = token?.let { pairing.buildQrPayload(settings.relayUrl) }
                _state.value = _state.value.copy(sessionToken = token, qrPayload = qr)
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
        viewModelScope.launch {
            pluginDao.observeAll().collect { entities ->
                _state.value = _state.value.copy(installError = null)
            }
        }
        viewModelScope.launch {
            approvalManager.pendingRequests.collect { requests ->
                _state.value = _state.value.copy(pendingApprovals = requests)
            }
        }
        viewModelScope.launch {
            approvalManager.streamState.collect { streamState ->
                _state.value = _state.value.copy(
                    approvalStreamConnected = streamState.name == "CONNECTED",
                )
            }
        }
    }

    fun togglePairing() {
        when (pairing.state.value) {
            PairingManager.PairingState.Idle -> pairing.startPairing()
            else -> pairing.cancel()
        }
    }

    fun setRelayUrl(url: String) {
        settings.relayUrl = url
        val token = (pairing.state.value as? PairingManager.PairingState.AwaitingLaptop)?.sessionToken
            ?: (pairing.state.value as? PairingManager.PairingState.Active)?.sessionToken
        val qr = token?.let { pairing.buildQrPayload(url) }
        _state.value = _state.value.copy(relayUrl = url, qrPayload = qr)
    }

    fun setHubCoreUrl(url: String) {
        settings.hubCoreUrl = url
        _state.value = _state.value.copy(hubCoreUrl = url)
    }

    fun showInstallDialog() {
        _state.value = _state.value.copy(showInstallDialog = true, installError = null)
    }

    fun dismissInstallDialog() {
        _state.value = _state.value.copy(showInstallDialog = false)
    }

    fun approve(requestId: String) {
        approvalManager.approve(requestId)
    }

    fun deny(requestId: String) {
        approvalManager.deny(requestId)
    }

    fun installPlugin(entryPath: String) {
        if (entryPath.isBlank()) {
            _state.value = _state.value.copy(installError = "Path is empty")
            return
        }
        viewModelScope.launch {
            try {
                val name = entryPath.substringAfterLast('/').substringBeforeLast('.')
                    .ifBlank { "plugin-${System.currentTimeMillis()}" }
                val entity = PluginEntity(
                    name = name,
                    version = "0.1.0",
                    entryPath = entryPath,
                    enabled = true,
                    installedAt = System.currentTimeMillis(),
                    configJson = "{}",
                )
                pluginDao.upsert(entity)
                plugins.refreshInstalled()
                _state.value = _state.value.copy(showInstallDialog = false, installError = null)
            } catch (e: Throwable) {
                _state.value = _state.value.copy(installError = e.message ?: "Install failed")
            }
        }
    }

    fun refreshTools() {
        viewModelScope.launch {
            plugins.refreshInstalled()
        }
    }
}
