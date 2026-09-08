package com.pdatahub.hub.ui.delegation

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.pdatahub.hub.mcp.DelegationGranted
import com.pdatahub.hub.mcp.DelegationSource
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

sealed interface DelegationListUiState {
    data object Loading : DelegationListUiState
    data class Loaded(
        val granted: List<DelegationGranted>,
        val received: List<DelegationGranted>,
        val revokingId: String? = null,
        val revokeError: String? = null,
    ) : DelegationListUiState
    data class Error(val message: String) : DelegationListUiState
}

@HiltViewModel
class DelegationManagementViewModel @Inject constructor(
    private val source: DelegationSource,
) : ViewModel() {

    private val _state = MutableStateFlow<DelegationListUiState>(DelegationListUiState.Loading)
    val state: StateFlow<DelegationListUiState> = _state.asStateFlow()

    init {
        refresh()
    }

    fun refresh() {
        viewModelScope.launch {
            _state.value = DelegationListUiState.Loading
            try {
                val resp = source.getDelegations()
                _state.value = DelegationListUiState.Loaded(
                    granted = resp.granted,
                    received = resp.received,
                )
            } catch (e: Throwable) {
                _state.value = DelegationListUiState.Error(
                    e.message ?: "Failed to load delegations"
                )
            }
        }
    }

    fun revoke(delegationId: String) {
        val current = _state.value as? DelegationListUiState.Loaded ?: return
        _state.value = current.copy(revokingId = delegationId, revokeError = null)
        viewModelScope.launch {
            try {
                val ok = source.revokeDelegation(delegationId)
                if (ok) {
                    _state.value = current.copy(
                        granted = current.granted.map {
                            if (it.delegation_id == delegationId) it.copy(revoked = 1) else it
                        },
                        revokingId = null,
                    )
                } else {
                    _state.value = current.copy(
                        revokingId = null,
                        revokeError = "Server rejected revoke",
                    )
                }
            } catch (e: Throwable) {
                _state.value = current.copy(
                    revokingId = null,
                    revokeError = e.message ?: "Revoke failed",
                )
            }
        }
    }
}
