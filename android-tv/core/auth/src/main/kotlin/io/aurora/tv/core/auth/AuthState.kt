package io.aurora.tv.core.auth

import kotlinx.serialization.Serializable

/**
 * Auth state is modeled as a sealed hierarchy so UI can exhaustive-when
 * against it and the compiler catches any missing branch when we add new
 * states (e.g. RequiresMfa, SessionExpired).
 */
@Serializable
sealed interface AuthState {
    @Serializable data object SignedOut : AuthState
    @Serializable data class Authenticating(val serverUrl: String) : AuthState
    @Serializable data class SignedIn(
        val serverUrl: String,
        val userId: String,
        val displayName: String,
        // JWT stored separately in EncryptedSharedPreferences — never here.
    ) : AuthState
    @Serializable data class Failed(val reason: String) : AuthState
}
