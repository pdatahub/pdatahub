package com.pdatahub.hub.ui.identity

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.pdatahub.hub.mcp.HubIdentitySource
import com.pdatahub.hub.mcp.IdentityResponse
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

sealed interface HubIdentityUiState {
    data object Loading : HubIdentityUiState
    data class Loaded(val identity: IdentityResponse) : HubIdentityUiState
    data class Error(val message: String) : HubIdentityUiState
}

@HiltViewModel
class HubIdentityViewModel @Inject constructor(
    private val source: HubIdentitySource,
) : ViewModel() {

    private val _state = MutableStateFlow<HubIdentityUiState>(HubIdentityUiState.Loading)
    val state: StateFlow<HubIdentityUiState> = _state.asStateFlow()

    init {
        refresh()
    }

    fun refresh() {
        viewModelScope.launch {
            _state.value = HubIdentityUiState.Loading
            try {
                val identity = source.getIdentity()
                _state.value = HubIdentityUiState.Loaded(identity)
            } catch (e: Throwable) {
                _state.value = HubIdentityUiState.Error(
                    e.message ?: "Failed to load hub identity"
                )
            }
        }
    }
}
