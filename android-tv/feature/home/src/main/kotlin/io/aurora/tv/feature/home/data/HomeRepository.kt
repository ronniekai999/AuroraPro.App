package io.aurora.tv.feature.home.data

import io.aurora.tv.core.auth.AuroraApiProvider
import io.aurora.tv.core.auth.ServerUrlStore
import java.io.IOException
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import retrofit2.HttpException

/**
 * Backs the Home tab against Aurora's REST API.
 *
 * The Home surface is a composition of five independent fetches — one
 * Continue Watching feed plus four catalog slices (Recently Added + three
 * canned genre rows). We fan them out with `async{}` inside a
 * `coroutineScope`, so the wall-clock cost of loading the screen is
 * `max(per-fetch latency)` rather than a serial sum. On a warm server
 * round-trip this is the difference between ~250ms and ~1.2s — visible
 * to the user and worth the small structural complication.
 *
 * === Failure semantics ===
 * Per-row failures are tolerated: if "Action" 502s but the rest succeed,
 * the user gets four populated rows and one missing row, not an error
 * screen. The whole-load fails ONLY when:
 *  - The server URL is missing (NotSignedIn) — this is a guard; a
 *    user reaching Home without a server URL is in an inconsistent
 *    auth state and should be routed back to sign-in.
 *  - The first fetch (Continue Watching) raises an HttpException —
 *    this catches the 401 case cleanly, since CW is the only fetch
 *    that's guaranteed authenticated and so its 401 is the most
 *    reliable signal that the session expired.
 *  - All five fetches threw — there's nothing meaningful to render,
 *    and we surface a single error state rather than five blank rows.
 */
@Singleton
class HomeRepository @Inject constructor(
    private val apiProvider: AuroraApiProvider,
    private val serverUrlStore: ServerUrlStore,
) {

    suspend fun loadHome(): Result {
        val serverUrl = serverUrlStore.current()
            ?: return Result.NotSignedIn

        return try {
            val api = apiProvider.apiOrThrow()

            // Fan-out: every row fetch runs in parallel. Each individual
            // call is wrapped in runCatching so a single row failure doesn't
            // cancel the sibling jobs in the same scope.
            coroutineScope {
                val cwDeferred     = async { runCatching { api.getContinueWatching(limit = 20) } }
                val recentDeferred = async { runCatching { api.listRecent(limit = 20) } }
                val dramaDeferred  = async { runCatching { api.listMedia(genre = "Drama",  perPage = 20) } }
                val comedyDeferred = async { runCatching { api.listMedia(genre = "Comedy", perPage = 20) } }
                val actionDeferred = async { runCatching { api.listMedia(genre = "Action", perPage = 20) } }

                val cwResult     = cwDeferred.await()
                val recentResult = recentDeferred.await()
                val dramaResult  = dramaDeferred.await()
                val comedyResult = comedyDeferred.await()
                val actionResult = actionDeferred.await()

                // Auth-failure shortcut: if Continue Watching threw an
                // HttpException, surface that to the caller as a single
                // typed error rather than treating it as just a missing
                // row. 401 → NotSignedIn so the host routes to sign-in.
                cwResult.exceptionOrNull()?.let { e ->
                    if (e is HttpException) return@coroutineScope mapHttpException(e)
                }

                // Map each successful list to UI rows. Failures fold into
                // null and are filtered out below.
                val cwRow = cwResult.getOrNull()
                    ?.takeIf { it.isNotEmpty() }
                    ?.distinctBy { it.mediaItemId }
                    ?.map { it.toMediaItem(serverUrl) }
                    ?.let { HomeRow(id = "continue-watching", title = "Continue watching", items = it) }

                val recentRow = recentResult.getOrNull()
                    ?.distinctBy { it.id }
                    ?.map { it.toMediaItem(serverUrl) }
                    ?.takeIf { it.isNotEmpty() }
                    ?.let { HomeRow(id = "recently-added", title = "Recently added", items = it) }

                val dramaRow = dramaResult.getOrNull()?.data
                    ?.distinctBy { it.id }
                    ?.map { it.toMediaItem(serverUrl) }
                    ?.takeIf { it.isNotEmpty() }
                    ?.let { HomeRow(id = "drama", title = "Drama", items = it) }

                val comedyRow = comedyResult.getOrNull()?.data
                    ?.distinctBy { it.id }
                    ?.map { it.toMediaItem(serverUrl) }
                    ?.takeIf { it.isNotEmpty() }
                    ?.let { HomeRow(id = "comedy", title = "Comedy", items = it) }

                val actionRow = actionResult.getOrNull()?.data
                    ?.distinctBy { it.id }
                    ?.map { it.toMediaItem(serverUrl) }
                    ?.takeIf { it.isNotEmpty() }
                    ?.let { HomeRow(id = "action", title = "Action", items = it) }

                val rows = listOfNotNull(cwRow, recentRow, dramaRow, comedyRow, actionRow)

                // Whole-load failure: every fetch threw. If even one row
                // came back we'd rather render a partial home than an
                // error screen — the user's information density is higher
                // and recovery is one tap (open a row, come back).
                if (rows.isEmpty()) {
                    val firstFailure = listOf(
                        cwResult, recentResult, dramaResult, comedyResult, actionResult,
                    ).firstNotNullOfOrNull { it.exceptionOrNull() }
                    return@coroutineScope when (firstFailure) {
                        is IOException   -> Result.NetworkError(firstFailure)
                        is HttpException -> mapHttpException(firstFailure)
                        null             -> Result.UnknownError(IllegalStateException("All home fetches succeeded but produced no rows."))
                        else             -> Result.UnknownError(firstFailure)
                    }
                }

                // Featured: prefer the first Continue Watching item (the
                // user's most-recent in-progress media), falling back to
                // Recently Added, then to nothing. Null featured tells the
                // screen to omit the hero entirely.
                val featured = cwRow?.items?.firstOrNull()
                    ?: recentRow?.items?.firstOrNull()

                Result.Success(
                    content = HomeContent(
                        featured = featured,
                        rows     = rows,
                    ),
                )
            }
        } catch (e: HttpException) {
            mapHttpException(e)
        } catch (e: IOException) {
            Result.NetworkError(e)
        } catch (e: Throwable) {
            Result.UnknownError(e)
        }
    }

    private fun mapHttpException(e: HttpException): Result = when (e.code()) {
        401 -> Result.NotSignedIn
        in 400..599 -> Result.ServerError(code = e.code(), message = e.message())
        else -> Result.UnknownError(e)
    }

    sealed interface Result {
        data class Success(val content: HomeContent) : Result
        data object NotSignedIn : Result
        data class NetworkError(val cause: Throwable) : Result
        data class ServerError(val code: Int, val message: String) : Result
        data class UnknownError(val cause: Throwable) : Result
    }
}
