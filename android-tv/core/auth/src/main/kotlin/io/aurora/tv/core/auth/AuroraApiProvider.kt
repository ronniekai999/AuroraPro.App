package io.aurora.tv.core.auth

import com.jakewharton.retrofit2.converter.kotlinx.serialization.asConverterFactory
import io.aurora.tv.core.network.AuroraApi
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import retrofit2.Retrofit

/**
 * Provides a single `AuroraApi` Retrofit instance scoped to the currently-
 * configured server URL. The first call to [api] reads the URL from
 * [ServerUrlStore] and constructs the client; subsequent calls return the
 * cached instance unless the URL has changed (e.g. user signed out and
 * pointed at a different server).
 *
 * Why per-server: Aurora is self-hosted, so the base URL comes from the
 * user at sign-in time. A single app-wide `Retrofit @Singleton` would have
 * to be torn down and rebuilt anyway when the URL changes — this provider
 * just makes that lifecycle explicit and gives every consumer a single
 * place to ask for the current API.
 *
 * Caller must `apiOrThrow()` only after sign-in has populated the URL.
 * The auth flow itself uses [unauthenticated] to construct a one-shot
 * client against an arbitrary URL — it's the only path that needs to call
 * the API *before* persisting the URL, since the URL only becomes
 * canonical once we successfully reach the server.
 */
@Singleton
class AuroraApiProvider @Inject constructor(
    private val baseClient: OkHttpClient,
    private val json: Json,
    private val authInterceptor: AuthInterceptor,
    private val serverUrlStore: ServerUrlStore,
) {
    private val mutex = Mutex()

    @Volatile private var cachedUrl: String? = null
    @Volatile private var cachedApi: AuroraApi? = null

    /**
     * Returns the current authenticated AuroraApi. Suspends because we
     * need to read the persisted server URL from DataStore (a suspend
     * call). Throws IllegalStateException if no URL has been configured —
     * callers should treat that as "user must sign in first."
     */
    suspend fun apiOrThrow(): AuroraApi {
        val url = serverUrlStore.current()
            ?: error("No server URL configured. The user must sign in before any authenticated API call.")
        return mutex.withLock {
            val cached = cachedApi
            if (cached != null && cachedUrl == url) {
                cached
            } else {
                buildApi(url, authenticated = true).also {
                    cachedUrl = url
                    cachedApi = it
                }
            }
        }
    }

    /**
     * One-shot AuroraApi against an arbitrary URL, with NO auth interceptor
     * attached. Used solely by AuthRepository.signIn — at sign-in time we
     * don't yet have a token, and we don't want to persist the URL until
     * we've confirmed it actually responds. Not cached.
     */
    fun unauthenticated(serverUrl: String): AuroraApi {
        return buildApi(serverUrl, authenticated = false)
    }

    @OptIn(ExperimentalSerializationApi::class)
    private fun buildApi(serverUrl: String, authenticated: Boolean): AuroraApi {
        val client = if (authenticated) {
            baseClient.newBuilder()
                .addInterceptor(authInterceptor)
                .build()
        } else {
            baseClient
        }
        // Retrofit requires baseUrl to end with `/` for the relative-path
        // concatenation to behave. ServerUrlStore.setServerUrl normalizes
        // the trailing slash off, so we add it back here.
        val normalizedBase = serverUrl.trimEnd('/') + "/"
        val retrofit = Retrofit.Builder()
            .baseUrl(normalizedBase)
            .client(client)
            .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
            .build()
        return retrofit.create(AuroraApi::class.java)
    }
}
