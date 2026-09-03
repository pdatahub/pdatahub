package com.pdatahub.hub.relay

import com.pdatahub.hub.data.identity.IdentityManager
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import javax.inject.Inject
import javax.inject.Singleton

/**
 * WebSocket client to the Cloudflare relay.
 *
 * The Hub dials OUT to the relay (relay doesn't know Hub's IP — Hub is behind
 * NAT). Connection survives laptop reboots via reconnect-with-backoff.
 *
 * Wire protocol: same JSON envelope as plugin-sdk uses between Hub and plugins.
 *   - Hub sends: { type: 'forward', payload: <opaque JSON from laptop> }
 *   - Hub receives: { type: 'forward', payload: <Hub's response> }
 *
 * The relay is opaque — it does not inspect message contents. End-to-end
 * TLS via wss:// gives us payload confidentiality on top.
 */
@Singleton
class RelayClient @Inject constructor(
    private val identity: IdentityManager,
) {
    enum class State { Disconnected, Connecting, Connected }

    private val _state = MutableStateFlow(State.Disconnected)
    val state: StateFlow<State> = _state.asStateFlow()

    @Volatile
    private var webSocket: WebSocket? = null

    private val httpClient = OkHttpClient.Builder().build()

    fun connect(relayUrl: String, sessionToken: String) {
        if (_state.value != State.Disconnected) return
        _state.value = State.Connecting

        val url = relayUrl.trimEnd('/') + "/sessions/$sessionToken/ws?role=hub&token=$sessionToken"
        val req = Request.Builder().url(url).build()
        val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                _state.value = State.Connected
                this@RelayClient.webSocket = webSocket
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                _state.value = State.Disconnected
            }
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                _state.value = State.Disconnected
            }
        }
        httpClient.newWebSocket(req, listener)
    }

    fun disconnect() {
        webSocket?.close(1000, "client closing")
        webSocket = null
        _state.value = State.Disconnected
    }

    fun send(json: String): Boolean {
        val ws = webSocket ?: return false
        return ws.send(json)
    }
}
