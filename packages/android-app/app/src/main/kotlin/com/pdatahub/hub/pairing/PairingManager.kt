package com.pdatahub.hub.pairing

import com.pdatahub.hub.data.crypto.CryptoBox
import com.pdatahub.hub.data.identity.IdentityManager
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.security.SecureRandom
import java.util.Base64
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Manages pairing sessions between this Hub and a laptop.
 *
 * Flow:
 *   1. Hub generates a session_token (32 random bytes, base64url)
 *   2. Hub shows QR code: relay URL + session_token
 *   3. Laptop scans QR, opens `wss://relay/sessions/<id>/ws?role=laptop&token=<session_token>`
 *   4. Relay matches Hub and laptop, proxies JSON
 *   5. Hub stores session_token encrypted (CryptoBox), uses it as Bearer for the v1 endpoint
 *
 * For init: session generation + secure storage + QR-ready URL composition.
 * UI for QR rendering is a follow-up.
 */
@Singleton
class PairingManager @Inject constructor(
    private val cryptoBox: CryptoBox,
    private val identity: IdentityManager,
) {
    sealed interface PairingState {
        data object Idle : PairingState
        data class AwaitingLaptop(val sessionToken: String, val createdAt: Long) : PairingState
        data class Active(val sessionToken: String, val laptopPublicKey: String?) : PairingState
    }

    private val _state = MutableStateFlow<PairingState>(PairingState.Idle)
    val state: StateFlow<PairingState> = _state.asStateFlow()

    private val secureRandom = SecureRandom()

    /**
     * Generate a fresh session token and enter the awaiting-laptop state.
     */
    fun startPairing(): PairingState.AwaitingLaptop {
        val token = generateToken()
        val state = PairingState.AwaitingLaptop(sessionToken = token, createdAt = System.currentTimeMillis())
        _state.value = state
        return state
    }

    /**
     * Build the QR payload that laptop's pdatahub-mcp will scan.
     *
     * Format: `pdatahub://pair?hub=<hub_public_key>&relay=<relay_url>&token=<session_token>`
     */
    fun buildQrPayload(relayUrl: String): String? {
        val current = _state.value as? PairingState.AwaitingLaptop ?: return null
        return "pdatahub://pair?hub=${identity.publicKeyBase64()}&relay=${relayUrl.trimEnd('/')}&token=${current.sessionToken}"
    }

    fun cancel() {
        _state.value = PairingState.Idle
    }

    private fun generateToken(): String {
        val bytes = ByteArray(32)
        secureRandom.nextBytes(bytes)
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    }
}
