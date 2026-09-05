package com.pdatahub.hub.data

import android.content.Context
import android.content.SharedPreferences
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class SettingsRepository @Inject constructor(
    @ApplicationContext context: Context,
) {
    private val prefs: SharedPreferences =
        context.getSharedPreferences("hub_settings", Context.MODE_PRIVATE)

    var relayUrl: String
        get() = prefs.getString(KEY_RELAY_URL, DEFAULT_RELAY_URL) ?: DEFAULT_RELAY_URL
        set(value) {
            prefs.edit().putString(KEY_RELAY_URL, value).apply()
        }

    var hubCoreUrl: String
        get() = prefs.getString(KEY_HUB_CORE_URL, DEFAULT_HUB_CORE_URL) ?: DEFAULT_HUB_CORE_URL
        set(value) {
            prefs.edit().putString(KEY_HUB_CORE_URL, value).apply()
        }

    var hubCoreAuthToken: String
        get() = prefs.getString(KEY_HUB_CORE_TOKEN, "") ?: ""
        set(value) {
            prefs.edit().putString(KEY_HUB_CORE_TOKEN, value).apply()
        }

    /**
     * Require biometric (fingerprint / face) before Approve/Deny buttons fire.
     * Defaults to true. When false OR device has no biometric, ApprovalRow
     * falls back to direct button press.
     */
    var biometricEnabled: Boolean
        get() = prefs.getBoolean(KEY_BIOMETRIC_ENABLED, true)
        set(value) {
            prefs.edit().putBoolean(KEY_BIOMETRIC_ENABLED, value).apply()
        }

    companion object {
        private const val KEY_RELAY_URL = "relay_url"
        private const val KEY_HUB_CORE_URL = "hub_core_url"
        private const val KEY_HUB_CORE_TOKEN = "hub_core_token"
        private const val KEY_BIOMETRIC_ENABLED = "biometric_enabled"
        const val DEFAULT_RELAY_URL = "wss://relay.pdatahub.app"
        const val DEFAULT_HUB_CORE_URL = "ws://192.168.1.100:8090"
    }
}
