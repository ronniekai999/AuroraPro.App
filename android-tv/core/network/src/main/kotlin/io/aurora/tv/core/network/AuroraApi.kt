package io.aurora.tv.core.network

import io.aurora.tv.core.network.dto.ContinueWatchingItemDto
import io.aurora.tv.core.network.dto.LoginRequest
import io.aurora.tv.core.network.dto.MediaItemDto
import io.aurora.tv.core.network.dto.MediaListResponseDto
import io.aurora.tv.core.network.dto.RefreshRequest
import io.aurora.tv.core.network.dto.TokenResponse
import io.aurora.tv.core.network.dto.UserDto
import io.aurora.tv.core.network.dto.UserProfileDto
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Path
import retrofit2.http.Query

/**
 * Retrofit interface for Aurora's HTTP API. All paths are relative to the
 * server's base URL (e.g. `https://aurorapro.app/`); `AuroraApiProvider` in
 * :core:auth holds the base URL and constructs the Retrofit client.
 *
 * Method naming follows the URL path so cross-referencing the Go handler
 * is one grep away (e.g. `listMedia` ↔ `MediaHandler.List` ↔ `GET /api/media`).
 *
 * Phase 0 covers: auth (login/refresh/me) + media list/recent/search/detail.
 * Cast, episodes, watch progress, streaming, and admin endpoints land in
 * later slices once their UI surfaces are wired up.
 *
 * Why no `Result<T>` wrapper here: Retrofit + kotlinx.serialization throws
 * `HttpException` on non-2xx and `IOException` on network failures.
 * Repositories catch those and lift to a `Result<T>` sealed type at the
 * domain boundary — keeping the API surface itself clean.
 */
interface AuroraApi {

    // ── Auth ─────────────────────────────────────────────────────────────
    @POST("api/auth/login")
    suspend fun login(@Body request: LoginRequest): TokenResponse

    @POST("api/auth/refresh")
    suspend fun refresh(@Body request: RefreshRequest): TokenResponse

    @GET("api/auth/me")
    suspend fun me(): UserDto

    // ── Media ────────────────────────────────────────────────────────────
    /**
     * Paginated list of library items, filterable by type / genre / year /
     * max_rating, with full-text search via `q` and ordering via `sortBy`.
     * Pagination defaults: page=1, perPage=20 (server enforces 1..100).
     */
    @GET("api/media")
    suspend fun listMedia(
        @Query("type") type: String? = null,
        @Query("genre") genre: String? = null,
        @Query("year") year: Int? = null,
        @Query("max_rating") maxRating: String? = null,
        @Query("sort_by") sortBy: String? = null,
        @Query("q") query: String? = null,
        @Query("page") page: Int = 1,
        @Query("per_page") perPage: Int = 50,
    ): MediaListResponseDto

    /** Recently-added items — feeds Home's "Recently Added" row. */
    @GET("api/media/recent")
    suspend fun listRecent(
        @Query("limit") limit: Int = 20,
    ): List<MediaItemDto>

    /** Full-text search across the library. */
    @GET("api/media/search")
    suspend fun searchMedia(
        @Query("q") query: String,
        @Query("limit") limit: Int = 50,
    ): List<MediaItemDto>

    /** Detail view — TMDB-enriched single item. */
    @GET("api/media/{id}")
    suspend fun getMedia(@Path("id") id: Long): MediaItemDto

    // ── Watch progress / Continue Watching ──────────────────────────────
    /**
     * Continue Watching feed for the Home tab. Optional `profileId` scopes
     * the result to a specific profile — without it, the server falls back
     * to user-level progress (an aggregate across profiles).
     */
    @GET("api/progress/continue")
    suspend fun getContinueWatching(
        @Query("limit") limit: Int = 20,
        @Query("profile_id") profileId: Long? = null,
    ): List<ContinueWatchingItemDto>

    // ── Profiles ────────────────────────────────────────────────────────
    /**
     * All profiles for the currently-authenticated user. Used by the
     * "Who's watching?" picker. Server returns these unsorted; clients
     * typically sort by `isDefault DESC, name ASC` for display.
     */
    @GET("api/profiles/")
    suspend fun listProfiles(): List<UserProfileDto>
}
