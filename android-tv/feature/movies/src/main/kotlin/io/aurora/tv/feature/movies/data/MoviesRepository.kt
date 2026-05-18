package io.aurora.tv.feature.movies.data

import io.aurora.tv.core.auth.AuroraApiProvider
import io.aurora.tv.core.auth.ServerUrlStore
import io.aurora.tv.core.ui.media.MediaItem
import java.io.IOException
import javax.inject.Inject
import javax.inject.Singleton
import retrofit2.HttpException

/**
 * Wraps Aurora's `GET /api/media?type=movie` endpoint, returning the UI's
 * domain `MediaItem` list along with a total count for the header line.
 *
 * Phase 1 scope: a single fetch of the first page. No pagination wired up
 * yet (server-side `page` / `per_page` are available; UI-side scrolling
 * pagination is a follow-up). The default `perPage = 50` covers about
 * 8 grid rows of 6 items, which is a comfortable initial fetch — bigger
 * than what fits on a 1080p screen at the current card size, so initial
 * scroll feels responsive without a paginated reload.
 *
 * Filter axes (Genre/Year/SortBy) are passed through to the server. The
 * UI's typed sealed classes carry a `matchKey: String?` that maps to the
 * server's expected query value (case-sensitive); `null` means "no filter
 * on this axis" and we omit the param.
 */
@Singleton
class MoviesRepository @Inject constructor(
    private val apiProvider: AuroraApiProvider,
    private val serverUrlStore: ServerUrlStore,
) {

    /**
     * Fetches movies from the server with the given filter/sort/pagination.
     * Returns:
     *  - [Result.Success] with the mapped items + total catalog size for
     *    the header count line
     *  - [Result.NotSignedIn] if the user isn't authenticated yet — the
     *    UI should route to SignIn (this should be a transient impossible
     *    state for the Movies tab, but we surface it cleanly anyway)
     *  - [Result.NetworkError] for IOExceptions (offline, DNS, TLS)
     *  - [Result.ServerError] for non-2xx responses
     *  - [Result.UnknownError] for everything else (most commonly a
     *    serialization mismatch from a server-side schema change)
     */
    suspend fun loadMovies(
        genre: String? = null,
        year: Int? = null,
        sortBy: String? = null,
        page: Int = 1,
        perPage: Int = 50,
    ): Result {
        val serverUrl = serverUrlStore.current()
            ?: return Result.NotSignedIn

        return try {
            val api = apiProvider.apiOrThrow()
            val response = api.listMedia(
                type    = "movie",
                genre   = genre,
                year    = year,
                sortBy  = sortBy,
                page    = page,
                perPage = perPage,
            )
            // Dedupe defensively. Aurora's listMedia already uses
            // DISTINCT ON server-side, but client-side dedupe protects
            // the LazyVerticalGrid's `key = { it.id }` from a duplicate
            // id ever reaching it (which crashes with
            // "Key was already used"). distinctBy preserves order.
            val items = response.data
                .distinctBy { it.id }
                .map { it.toMediaItem(serverUrl) }
            Result.Success(
                items       = items,
                totalCount  = response.totalItems.toInt(),
                currentPage = response.page,
                totalPages  = response.totalPages,
            )
        } catch (e: HttpException) {
            when (e.code()) {
                401 -> Result.NotSignedIn  // Token expired/invalid → treat as signed-out.
                in 400..499 -> Result.ServerError(code = e.code(), message = e.message())
                in 500..599 -> Result.ServerError(code = e.code(), message = e.message())
                else -> Result.UnknownError(e)
            }
        } catch (e: IOException) {
            Result.NetworkError(e)
        } catch (e: Throwable) {
            Result.UnknownError(e)
        }
    }

    /**
     * Result of a `loadMovies` call. The ViewModel exhaustive-whens on
     * this so adding a new failure mode (e.g. `RateLimited`) forces the
     * UI to handle it.
     */
    sealed interface Result {
        /**
         * @param items mapped page of MediaItems
         * @param totalCount total catalog size (across all pages)
         * @param currentPage 1-indexed page just fetched
         * @param totalPages total page count given the current per_page; the
         *   ViewModel uses `currentPage < totalPages` to decide whether
         *   there's more to fetch.
         */
        data class Success(
            val items: List<MediaItem>,
            val totalCount: Int,
            val currentPage: Int,
            val totalPages: Int,
        ) : Result
        data object NotSignedIn : Result
        data class NetworkError(val cause: Throwable) : Result
        data class ServerError(val code: Int, val message: String) : Result
        data class UnknownError(val cause: Throwable) : Result
    }
}
