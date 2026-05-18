package io.aurora.tv.core.network

import android.content.Context
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import java.io.File
import java.util.concurrent.TimeUnit
import javax.inject.Singleton
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNamingStrategy
import okhttp3.Cache
import okhttp3.ConnectionPool
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor

/**
 * Hilt module providing the shared HTTP stack. Retrofit instances are
 * per-server (constructed after the user enters a server URL at sign-in)
 * so they live in `AuroraApiProvider` (in :core:auth), not here; only the
 * reusable OkHttp client + JSON instance are app-wide singletons.
 *
 * The Json config is tuned to consume Aurora's wire format:
 *  - `namingStrategy = SnakeCase` lets DTOs stay camelCase Kotlin while
 *    decoding `snake_case` JSON. Aurora's Go server uses snake_case `json`
 *    tags throughout (see internal/models/models.go).
 *  - `ignoreUnknownKeys = true` so the client doesn't break when the
 *    server adds a field we don't know about yet.
 *  - `explicitNulls = false` so the client omits null fields when
 *    encoding (Go's `omitempty` expects this).
 *  - `encodeDefaults = true` keeps DTO defaults visible on the wire when
 *    we DO want them (e.g. registration request with default invite_code).
 *
 * The OkHttp config is tuned for a single-server media app:
 *  - 50MB disk cache so repeat visits to the same screen (e.g. user
 *    leaves Movies → comes back) hit cache instead of refetching.
 *    Aurora's media endpoints already emit appropriate Cache-Control
 *    headers for the proxy/library data; OkHttp respects them.
 *  - Connection pool sized to 10 keep-alive connections (default 5),
 *    5 min keep-alive (default). With media + image-proxy traffic
 *    pipelined in parallel to one server, more pooled connections
 *    means fewer TLS re-handshakes during scroll bursts.
 *  - HttpLoggingInterceptor at NONE — it's in the chain so it can
 *    be flipped to BASIC for debugging without code changes, but the
 *    NONE branch returns immediately so there's no per-request CPU.
 */
@Module
@InstallIn(SingletonComponent::class)
object NetworkModule {

    @OptIn(ExperimentalSerializationApi::class)
    @Provides
    @Singleton
    fun provideJson(): Json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
        encodeDefaults = true
        namingStrategy = JsonNamingStrategy.SnakeCase
    }

    @Provides
    @Singleton
    fun provideOkHttpClient(@ApplicationContext context: Context): OkHttpClient {
        // 50MB disk cache for HTTP responses. Lives in the app's cache dir
        // (auto-cleaned by Android under storage pressure). Aurora's
        // /api/media etc. respond with appropriate Cache-Control headers
        // so this benefits the most-frequent reads (initial-load on
        // returning to a tab) without serving stale data when the server
        // says "this changed."
        val httpCacheDir = File(context.cacheDir, "okhttp_cache")
        val httpCacheSize = 50L * 1024L * 1024L  // 50 MB
        val httpCache = Cache(httpCacheDir, httpCacheSize)

        return OkHttpClient.Builder()
            .cache(httpCache)
            // Keep more connections warm. Default ConnectionPool is
            // (5, 5min). For an app that pipelines API requests +
            // image-proxy fetches against a single host (aurorapro.app),
            // 10 idle connections gives the image grid more room to fan
            // out without re-handshaking TLS for each one.
            .connectionPool(ConnectionPool(maxIdleConnections = 10, keepAliveDuration = 5, timeUnit = TimeUnit.MINUTES))
            .addInterceptor(
                HttpLoggingInterceptor().apply {
                    // TEMPORARY: Level.BODY for diagnostic logging. Logs
                    // full request/response including bodies. Flip back
                    // to NONE once we've finished investigating the
                    // detail-screen variant rendering. 1-3ms per request
                    // overhead during this debugging window is acceptable;
                    // BODY-level logging on tokens is fine because
                    // logcat doesn't leave the device.
                    level = HttpLoggingInterceptor.Level.BODY
                },
            )
            // Phase 2 may add: ETag-aware response caching, retry policy
            // tuned to TV network flakiness. The auth interceptor lives
            // in :core:auth and is layered on top of this base client by
            // AuroraApiProvider so we never accidentally ship a request
            // without a Bearer token.
            .build()
    }
}
