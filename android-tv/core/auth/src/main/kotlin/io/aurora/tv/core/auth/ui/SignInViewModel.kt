package io.aurora.tv.core.auth.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import io.aurora.tv.core.auth.AuthRepository
import io.aurora.tv.core.auth.AuthState
import io.aurora.tv.core.auth.SignInResult
import javax.inject.Inject
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * ViewModel for the sign-in screen.
 *
 * Phase 1 wiring: real network call via [AuthRepository.signIn]. Form
 * state and auth state remain separate Flows because their lifecycles
 * differ — form state is ephemeral (dies with the screen), while auth
 * state survives process death (via AuthTokenStore + ServerUrlStore).
 *
 * Error mapping translates [SignInResult] into [AuthState.Failed] with a
 * human-readable reason. UI shows the reason verbatim, so the strings
 * here are user-facing.
 */
@HiltViewModel
class SignInViewModel @Inject constructor(
    private val authRepository: AuthRepository,
) : ViewModel() {

    private val _form = MutableStateFlow(SignInForm())
    val form: StateFlow<SignInForm> = _form.asStateFlow()

    private val _state = MutableStateFlow<AuthState>(AuthState.SignedOut)
    val state: StateFlow<AuthState> = _state.asStateFlow()

    fun updateServer(v: String)   = _form.update { it.copy(serverUrl = v) }
    fun updateUsername(v: String) = _form.update { it.copy(username  = v) }
    fun updatePassword(v: String) = _form.update { it.copy(password  = v) }

    fun submit() {
        val f = _form.value
        if (f.serverUrl.isBlank() || f.username.isBlank() || f.password.isBlank()) {
            _state.value = AuthState.Failed(reason = "All fields are required.")
            return
        }
        viewModelScope.launch {
            _state.value = AuthState.Authenticating(f.serverUrl)
            val result = authRepository.signIn(
                serverUrl = f.serverUrl,
                username  = f.username,
                password  = f.password,
            )
            _state.value = when (result) {
                is SignInResult.Success -> AuthState.SignedIn(
                    serverUrl   = f.serverUrl,
                    userId      = result.user.id.toString(),
                    displayName = result.user.username,
                )
                SignInResult.InvalidCredentials -> AuthState.Failed(
                    reason = "Invalid username or password.",
                )
                is SignInResult.NetworkError -> AuthState.Failed(
                    reason = "Couldn't reach the server. Check the URL and your network connection.",
                )
                is SignInResult.ServerError -> AuthState.Failed(
                    reason = "Server returned ${result.code}: ${result.message}",
                )
                is SignInResult.UnknownError -> AuthState.Failed(
                    // Most common cause: URL points at a non-Aurora service
                    // and the response body isn't decodable. The exception
                    // class name is more useful than the message for debug.
                    reason = "Sign in failed (${result.cause::class.simpleName ?: "unknown error"}). Verify the server URL.",
                )
            }
        }
    }
}

data class SignInForm(
    /**
     * Default to the production Aurora server so the user (and dev cycle)
     * doesn't need to retype the URL on every cold launch. Override by
     * editing the field at sign-in time; the entered value persists via
     * ServerUrlStore once login succeeds.
     */
    val serverUrl: String = "https://aurorapro.app",
    val username:  String = "",
    val password:  String = "",
)
