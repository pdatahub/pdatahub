package com.pdatahub.hub.ui.approval

import com.pdatahub.hub.mcp.ApprovalStreamEvent
import com.pdatahub.hub.mcp.ApprovalStreamState
import com.pdatahub.hub.mcp.ApprovalWebSocketClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class ApprovalNotificationManager @Inject constructor(
    private val webSocketClient: ApprovalWebSocketClient,
) {
    private val scope = CoroutineScope(Dispatchers.Main + SupervisorJob())

    private val _pendingRequests = MutableStateFlow<List<PendingApprovalRequest>>(emptyList())
    val pendingRequests: StateFlow<List<PendingApprovalRequest>> = _pendingRequests.asStateFlow()

    val streamState: StateFlow<ApprovalStreamState> = webSocketClient.state

    val events: SharedFlow<ApprovalStreamEvent> = webSocketClient.events

    init {
        scope.launch {
            webSocketClient.events.collect { event ->
                when (event) {
                    is ApprovalStreamEvent.ApprovalRequest -> {
                        _pendingRequests.value = _pendingRequests.value + PendingApprovalRequest(
                            requestId = event.request_id,
                            agentId = event.agent_id,
                            toolName = event.tool_name,
                            scope = event.scope,
                            justification = event.justification,
                            createdAt = event.created_at,
                        )
                    }
                    is ApprovalStreamEvent.GrantRevoked -> {
                        _pendingRequests.value = _pendingRequests.value.filterNot {
                            it.requestId == event.grant_id
                        }
                    }
                    is ApprovalStreamEvent.AuditUpdate -> Unit
                }
            }
        }
        webSocketClient.start()
    }

    fun approve(requestId: String) {
        webSocketClient.sendDecision(requestId, approved = true)
        _pendingRequests.value = _pendingRequests.value.filterNot { it.requestId == requestId }
    }

    fun deny(requestId: String) {
        webSocketClient.sendDecision(requestId, approved = false)
        _pendingRequests.value = _pendingRequests.value.filterNot { it.requestId == requestId }
    }

    fun start() {
        webSocketClient.start()
    }

    fun stop() {
        webSocketClient.stop()
    }
}

data class PendingApprovalRequest(
    val requestId: String,
    val agentId: String,
    val toolName: String,
    val scope: String,
    val justification: String?,
    val createdAt: String,
)
