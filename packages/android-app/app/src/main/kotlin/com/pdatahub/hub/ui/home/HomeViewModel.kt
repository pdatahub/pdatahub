package com.pdatahub.hub.ui.home

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.pdatahub.hub.data.SettingsRepository
import com.pdatahub.hub.data.identity.IdentityManager
import com.pdatahub.hub.mcp.AuditEntry
import com.pdatahub.hub.mcp.Grant
import com.pdatahub.hub.mcp.HubCoreApi
import com.pdatahub.hub.pairing.PairingManager
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
    val biometricEnabled: Boolean = true,
    val pendingApprovals: List<PendingApprovalRequest> = emptyList(),
    val approvalStreamConnected: Boolean = false,
    val activeGrants: List<Grant> = emptyList(),
    val auditHistory: List<AuditEntry> = emptyList(),
)

@HiltViewModel
class HomeViewModel @Inject constructor(
    private val identity: IdentityManager,
    private val pairing: PairingManager,
    private val settings: SettingsRepository,
    private val approvalManager: ApprovalNotificationManager,
    private val hubCoreApi: HubCoreApi,
) : ViewModel() {

    private val _state = MutableStateFlow(
        HomeUiState(
            publicKeyBase64 = identity.publicKeyBase64(),
            relayUrl = settings.relayUrl,
            hubCoreUrl = settings.hubCoreUrl,
            biometricEnabled = settings.biometricEnabled,
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
        viewModelScope.launch {
            approvalManager.events.collect { event ->
                when (event) {
                    is com.pdatahub.hub.mcp.ApprovalStreamEvent.GrantRevoked -> {
                        _state.value = _state.value.copy(
                            activeGrants = _state.value.activeGrants.filterNot {
                                it.grant_id == event.grant_id
                            },
                        )
                    }
                    is com.pdatahub.hub.mcp.ApprovalStreamEvent.AuditUpdate -> {
                        val p = event.entry
                        val entry = AuditEntry(
                            id = p.id,
                            timestamp = p.timestamp,
                            agent_id = p.agent_id,
                            user_id = "local-user",
                            tool_name = p.tool_name,
                            plugin = "",
                            scope = "",
                            decision = p.decision,
                            duration_ms = 0,
                        )
                        val updated: List<AuditEntry> = listOf(entry) + _state.value.auditHistory
                        _state.value = _state.value.copy(auditHistory = updated.take(50))
                    }
                    else -> Unit
                }
            }
        }
        loadGrants()
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

    fun setBiometricEnabled(enabled: Boolean) {
        settings.biometricEnabled = enabled
        _state.value = _state.value.copy(biometricEnabled = enabled)
    }

    fun approve(requestId: String) {
        approvalManager.approve(requestId)
    }

    fun deny(requestId: String) {
        approvalManager.deny(requestId)
    }

    fun loadGrants() {
        viewModelScope.launch {
            try {
                _state.value = _state.value.copy(activeGrants = hubCoreApi.getGrants())
            } catch (_: Throwable) {
                // Hub core unreachable — leave list as-is
            }
        }
    }

    fun revokeGrant(grantId: String) {
        viewModelScope.launch {
            try {
                if (hubCoreApi.revokeGrant(grantId)) {
                    _state.value = _state.value.copy(
                        activeGrants = _state.value.activeGrants.filterNot {
                            it.grant_id == grantId
                        },
                    )
                }
            } catch (_: Throwable) {
            }
        }
    }

    fun loadAuditHistory(limit: Int = 50) {
        viewModelScope.launch {
            try {
                _state.value = _state.value.copy(auditHistory = hubCoreApi.getAuditHistory(limit))
            } catch (_: Throwable) {
            }
        }
    }
}
