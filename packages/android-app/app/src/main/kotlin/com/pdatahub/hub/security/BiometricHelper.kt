package com.pdatahub.hub.security

import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity

/**
 * Biometric authentication helper.
 *
 * Wraps BiometricPrompt + BiometricManager behind a small surface so Compose
 * callers don't deal with executors, prompt info builders, or capability
 * constants directly.
 *
 * Capability check (`canAuthenticate`):
 *   - Returns true if device has BIOMETRIC_STRONG or BIOMETRIC_WEAK enrolled.
 *   - Returns false if hardware missing, none enrolled, or unavailable.
 *
 * Prompt flow (`prompt`):
 *   - Shows BiometricPrompt with title "pdatahub Hub" + subtitle.
 *   - On success: invokes onSuccess().
 *   - On user cancel / error / lockout: invokes onFailure(reason).
 *
 * Used by HomeScreen.ApprovalRow when SettingsRepository.biometricEnabled.
 * If biometricEnabled is true but device has no biometric, callers should
 * fall back to direct button (UI shows a hint).
 */
object BiometricHelper {

    fun canAuthenticate(activity: FragmentActivity): Boolean {
        val manager = BiometricManager.from(activity)
        val authenticators = BiometricManager.Authenticators.BIOMETRIC_WEAK or
            BiometricManager.Authenticators.BIOMETRIC_STRONG
        return when (manager.canAuthenticate(authenticators)) {
            BiometricManager.BIOMETRIC_SUCCESS -> true
            else -> false
        }
    }

    fun prompt(
        activity: FragmentActivity,
        title: String = "pdatahub Hub",
        subtitle: String = "Confirm approval",
        onSuccess: () -> Unit,
        onFailure: (reason: String) -> Unit,
    ) {
        val executor = ContextCompat.getMainExecutor(activity)
        val prompt = BiometricPrompt(activity, executor, object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                onSuccess()
            }

            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                onFailure(errString.toString())
            }

            override fun onAuthenticationFailed() {
                // User presented but didn't match — let them retry. Don't call onFailure.
            }
        })
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle(title)
            .setSubtitle(subtitle)
            .setAllowedAuthenticators(
                BiometricManager.Authenticators.BIOMETRIC_WEAK or
                    BiometricManager.Authenticators.BIOMETRIC_STRONG
            )
            .build()
        prompt.authenticate(info)
    }
}
