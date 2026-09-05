package com.pdatahub.hub.mcp

import com.pdatahub.hub.data.SettingsRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import javax.inject.Inject
import javax.inject.Singleton

enum class ApprovalStreamState {
    DISCONNECTED,
    CONNECTING,
    CONNECTED,
}

@Serializable
sealed class ApprovalStreamEvent {
    @Serializable
    data class ApprovalRequest(
        val request_id: String,
        val agent_id: String,
        val tool_name: String,
        val scope: String,
        val justification: String? = null,
        val created_at: String,
    ) : ApprovalStreamEvent()

    @Serializable
    data class AuditUpdate(
        val entry: AuditEntryPayload,
    ) : ApprovalStreamEvent()

    @Serializable
    data class GrantRevoked(
        val grant_id: String,
    ) : ApprovalStreamEvent()
}

@Serializable
data class AuditEntryPayload(
    val id: String,
    val timestamp: String,
    val agent_id: String,
    val tool_name: String,
    val decision: String,
)

/**
 * WebSocket client that connects to Hub core's /approval-stream endpoint.
 *
 * Receives:
 *   - approval_request: when AI agent asks for tool access
 *   - audit_update: live audit log entries
 *   - grant_revoked: when user manually revokes
 *
 * Sends:
 *   - approval_decided: { request_id, decision: "approved" | "denied" }
 *   - pong: heartbeat response
 *
 * Reconnect logic: exponential backoff (1s, 2s, 4s, 8s, max 30s).
 */
@Singleton
class ApprovalWebSocketClient @Inject constructor(
    private val settings: SettingsRepository,
    private val okHttpClient: OkHttpClient,
) {
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private var reconnectJob: Job? = null
    private var ws: WebSocket? = null
    private var pingJob: Job? = null

    private val _state = MutableStateFlow(ApprovalStreamState.DISCONNECTED)
    val state: StateFlow<ApprovalStreamState> = _state.asStateFlow()

    private val _events = MutableSharedFlow<ApprovalStreamEvent>(extraBufferCapacity = 64)
    val events: SharedFlow<ApprovalStreamEvent> = _events.asSharedFlow()

    private val json = Json { ignoreUnknownKeys = true }

    /**
     * Start the WebSocket connection with automatic reconnect.
     * Safe to call multiple times — cancels previous connection first.
     */
    fun start() {
        scope.launch {
            reconnectLoop()
        }
    }

    /**
     * Stop the WebSocket and cancel reconnect attempts.
     */
    fun stop() {
        scope.launch {
            reconnectJob?.cancel()
            reconnectJob = null
            ws?.close(1000, "client shutdown")
            ws = null
            pingJob?.cancel()
            pingJob = null
            _state.value = ApprovalStreamState.DISCONNECTED
        }
    }

    /**
     * Send approval decision back to Hub core.
     */
    fun sendDecision(requestId: String, approved: Boolean) {
        val socket = ws ?: return
        val payload = buildString {
            append("{\"type\":\"approval_decided\",\"request_id\":\"")
            append(requestId)
            append("\",\"decision\":\"")
            append(if (approved) "approved" else "denied")
            append("\"}")
        }
        socket.send(payload)
    }

    private suspend fun reconnectLoop() {
        var attempt = 0
        while (true) {
            _state.value = ApprovalStreamState.CONNECTING
            val hubCoreUrl = settings.hubCoreUrl
            val token = settings.hubCoreAuthToken
            val wsUrl = hubCoreUrl
                .replace("http://", "ws://")
                .replace("https://", "wss://")
                .trimEnd('/') + "/approval-stream"

            val request = Request.Builder()
                .url(wsUrl)
                .build()

            val closedSignal = kotlinx.coroutines.CompletableDeferred<Unit>()
            val opened = connectOnce(request, closedSignal)
            if (opened) {
                attempt = 0
                _state.value = ApprovalStreamState.CONNECTED
                startHeartbeat()
                closedSignal.await()
                stopHeartbeat()
            }
            _state.value = ApprovalStreamState.DISCONNECTED
            attempt++
            val backoffMs = (1000L * (1 shl minOf(attempt, 5))).coerceAtMost(30_000L)
            delay(backoffMs)
        }
    }

    private suspend fun connectOnce(
        request: Request,
        closedSignal: kotlinx.coroutines.CompletableDeferred<Unit>,
    ): Boolean {
        return suspendCancellableCoroutine { cont ->
            val listener = object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    ws = webSocket
                    if (cont.isActive) cont.resumeWith(Result.success(true))
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    handleMessage(text)
                }

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    webSocket.close(code, reason)
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    ws = null
                    if (!closedSignal.isCompleted) closedSignal.complete(Unit)
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    ws = null
                    if (cont.isActive) cont.resumeWith(Result.success(false))
                    if (!closedSignal.isCompleted) closedSignal.complete(Unit)
                }
            }
            val socket = okHttpClient.newWebSocket(request, listener)
            cont.invokeOnCancellation {
                socket.cancel()
            }
        }
    }

    private fun handleMessage(text: String) {
        val obj: JsonObject = try {
            json.parseToJsonElement(text).jsonObject
        } catch (_: Exception) {
            return
        }
        val type = obj["type"]?.jsonPrimitive?.contentOrNull ?: return
        try {
            when (type) {
                "approval_request" -> {
                    val event = json.decodeFromJsonElement(ApprovalStreamEvent.ApprovalRequest.serializer(), obj)
                    scope.launch { _events.emit(event) }
                }
                "audit_update" -> {
                    val event = json.decodeFromJsonElement(ApprovalStreamEvent.AuditUpdate.serializer(), obj)
                    scope.launch { _events.emit(event) }
                }
                "grant_revoked" -> {
                    val event = json.decodeFromJsonElement(ApprovalStreamEvent.GrantRevoked.serializer(), obj)
                    scope.launch { _events.emit(event) }
                }
                "pong" -> {
                    // heartbeat ack, nothing to do
                }
                else -> {
                    // unknown type — ignore
                }
            }
        } catch (_: Exception) {
            // malformed payload — ignore
        }
    }

    private fun startHeartbeat() {
        pingJob?.cancel()
        pingJob = scope.launch {
            while (true) {
                delay(30_000)
                val socket = ws ?: continue
                if (socket.send("{\"type\":\"ping\"}")) {
                    // ok
                } else {
                    break
                }
            }
        }
    }

    private fun stopHeartbeat() {
        pingJob?.cancel()
        pingJob = null
    }

    fun shutdown() {
        stop()
        scope.cancel()
    }
}
