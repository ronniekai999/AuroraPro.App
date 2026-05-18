package io.aurora.tv.feature.shows.data

import io.aurora.tv.core.auth.AuroraApiProvider
import io.aurora.tv.core.auth.ServerUrlStore
import io.aurora.tv.core.ui.media.MediaItem
import java.io.IOException
import javax.inject.Inject
import javax.inject.Singleton
import retrofit2.HttpException

/**
 * Wraps Aurora's `GET /api/media?type=show` endpoint. Mirrors
 * MoviesRepository exactly, with `type = "show"` swapped in. Same
 * pagination/result/error contract.
 */
@Singleton
class ShowsRepository @Inject constructor(
    private val apiProvider: AuroraApiProvider,
    private val serverUrlStore: ServerUrlStore,
) {

    suspend fun loadShows(
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
                type    = "show",
                genre   = genre,
                year    = year,
                sortBy  = sortBy,
                page    = page,
                perPage = perPage,
            )
            // Defensive dedupe; see MoviesRepository for rationale.
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
                401 -> Result.NotSignedIn
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

    sealed interface Result {
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
