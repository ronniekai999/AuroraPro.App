package io.aurora.tv.core.auth

import io.aurora.tv.core.network.dto.LoginRequest
import io.aurora.tv.core.network.dto.UserDto
import java.io.IOException
import javax.inject.Inject
import javax.inject.Singleton
import retrofit2.HttpException

/**
 * Single point of truth for the sign-in / sign-out lifecycle.
 *
 * Responsibilities:
 *  - Drive the network-level login call (via [AuroraApiProvider.unauthenticated])
 *  - Persist tokens (AuthTokenStore) and server URL (ServerUrlStore)
 *  - Translate transport errors (HttpException, IOException) into a
 *    domain-level [SignInResult] sealed type that the UI can pattern-match
 *
 * The sign-in flow uses an unauthenticated client because the user
 * doesn't have a token yet. After login succeeds, the URL is persisted —
 * which means the next call to [AuroraApiProvider.apiOrThrow] returns a
 * Retrofit instance with the auth interceptor attached.
 *
 * Error mapping:
 *  - 400/401 from /api/auth/login → [SignInResult.InvalidCredentials]
 *  - Other 4xx → [SignInResult.ServerError] (client misconfig, e.g. wrong URL)
 *  - 5xx → [SignInResult.ServerError]
 *  - IOException (DNS, TLS, no internet) → [SignInResult.NetworkError]
 *  - Anything else → [SignInResult.UnknownError] (carries the throwable)
 *
 * The "wrong URL" case is tricky: hitting a non-Aurora server would
 * return a JSON-decode exception or a non-2xx HTML response. Both surface
 * as a generic `UnknownError` — the user-visible message ("Couldn't reach
 * Aurora at that URL") is constructed in the UI layer.
 */
@Singleton
class AuthRepository @Inject constructor(
    private val tokenStore: AuthTokenStore,
    private val serverUrlStore: ServerUrlStore,
    private val apiProvider: AuroraApiProvider,
) {

    suspend fun signIn(serverUrl: String, username: String, password: String): SignInResult {
        // Build a one-shot unauthenticated client against the provided URL.
        // We deliberately don't persist the URL until login confirms the
        // server is actually Aurora — otherwise a typo would poison the
        // store with a bad URL that subsequent attempts couldn't recover
        // from without explicit reset.
        val api = apiProvider.unauthenticated(serverUrl)
        return try {
            val response = api.login(LoginRequest(username = username, password = password))
            // Persist in this order: server URL first so any subsequent
            // authenticated call (rare during sign-in but possible if the
            // ViewModel kicks off a fetch before saveTokens completes) can
            // resolve the URL; tokens last so the auth interceptor never
            // sees a stale token paired with the new URL.
            serverUrlStore.setServerUrl(serverUrl)
            tokenStore.saveTokens(
                access  = response.accessToken,
                refresh = response.refreshToken,
            )
            SignInResult.Success(response.user)
        } catch (e: HttpException) {
            // Aurora returns 400 ("username and password required") and
            // 401 ("invalid credentials") on the login endpoint. Both
            // are surfaced to the user as "wrong credentials" because we
            // don't want to disclose whether the username exists.
            when (e.code()) {
                400, 401 -> SignInResult.InvalidCredentials
                in 402..499 -> SignInResult.ServerError(code = e.code(), message = e.message())
                in 500..599 -> SignInResult.ServerError(code = e.code(), message = e.message())
                else -> SignInResult.UnknownError(e)
            }
        } catch (e: IOException) {
            // DNS resolution failed, TLS handshake failed, host unreachable,
            // request timed out, etc. The most common real-world cause is
            // the user typing a URL that doesn't exist or the device being
            // offline.
            SignInResult.NetworkError(e)
        } catch (e: Throwable) {
            // Catches kotlinx.serialization SerializationException too —
            // happens when the response body isn't Aurora-shaped JSON
            // (e.g. user typed a URL pointing at a different service).
            SignInResult.UnknownError(e)
        }
    }

    /**
     * Clears all auth state. Caller is responsible for navigating to the
     * sign-in screen.
     */
    suspend fun signOut() {
        tokenStore.clear()
        serverUrlStore.clear()
    }

    /** Convenience accessor for callers that want to check session-presence. */
    fun isSignedIn(): Boolean = tokenStore.accessToken() != null
}

/**
 * Result of a sign-in attempt. The UI exhaustive-whens on this so adding
 * a new failure mode forces the screen to handle it.
 */
sealed interface SignInResult {
    data class Success(val user: UserDto) : SignInResult
    data object InvalidCredentials : SignInResult
    data class ServerError(val code: Int, val message: String) : SignInResult
    data class NetworkError(val cause: Throwable) : SignInResult
    data class UnknownError(val cause: Throwable) : SignInResult
}
