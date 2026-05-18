package io.aurora.tv.core.auth

import javax.inject.Inject
import javax.inject.Singleton
import okhttp3.Interceptor
import okhttp3.Response

/**
 * OkHttp interceptor that attaches the current access token to every
 * authenticated request.
 *
 * Phase 0 scope: Bearer-token attachment only. The 401-refresh-retry flow
 * (where we transparently refresh the access token on auth failure and
 * retry the original request once) is deliberately deferred — it requires
 * an `Authenticator` (different OkHttp primitive) plus single-flight
 * coordination so concurrent failing requests don't all kick off
 * simultaneous refreshes. We'll add it in a follow-up; for now an expired
 * access token surfaces as a 401 to the caller, who can react by signing
 * the user out.
 *
 * The /api/auth/login and /api/auth/refresh endpoints are NOT
 * authenticated (you can't have a Bearer before logging in), so we skip
 * the header for those. /api/auth/setup-status is also public. Path-prefix
 * matching is sufficient for Aurora's URL space; if the API ever sprouts
 * deeper auth-required paths starting with /api/auth/, this filter would
 * need revisiting.
 */
@Singleton
class AuthInterceptor @Inject constructor(
    private val tokenStore: AuthTokenStore,
) : Interceptor {

    override fun intercept(chain: Interceptor.Chain): Response {
        val original = chain.request()
        val path = original.url.encodedPath

        if (path in PUBLIC_PATHS || original.header(HEADER_AUTH) != null) {
            // Either the endpoint is public (no Bearer needed), or the
            // caller already attached an Authorization header (e.g. for
            // a one-off admin call) — don't clobber it.
            return chain.proceed(original)
        }

        val token = tokenStore.accessToken()
            ?: return chain.proceed(original)
            // No token yet (e.g. fresh install, pre-login API probe) —
            // let the request through unauthenticated; the server will
            // 401 and the caller can react.

        val authed = original.newBuilder()
            .header(HEADER_AUTH, "Bearer $token")
            .build()
        return chain.proceed(authed)
    }

    private companion object {
        const val HEADER_AUTH = "Authorization"
        val PUBLIC_PATHS = setOf(
            "/api/auth/login",
            "/api/auth/register",
            "/api/auth/refresh",
            "/api/auth/setup-status",
            "/api/health",
        )
    }
}
