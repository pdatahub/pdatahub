package com.pdatahub.hub.data

import android.content.Context
import android.content.SharedPreferences
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Persistent user settings.
 *
 * Backed by SharedPreferences. For init scope only stores the relay URL —
 * future versions will add hub display name, plugin auto-update toggle, etc.
 */
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

    companion object {
        private const val KEY_RELAY_URL = "relay_url"
        const val DEFAULT_RELAY_URL = "wss://relay.pdatahub.app"
    }
}
