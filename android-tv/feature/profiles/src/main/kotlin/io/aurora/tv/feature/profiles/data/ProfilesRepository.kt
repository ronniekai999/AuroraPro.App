package io.aurora.tv.feature.profiles.data

import io.aurora.tv.core.auth.AuroraApiProvider
import io.aurora.tv.core.auth.ServerUrlStore
import io.aurora.tv.feature.profiles.Profile
import java.io.IOException
import javax.inject.Inject
import javax.inject.Singleton
import retrofit2.HttpException

/**
 * Wraps Aurora's `GET /api/profiles/` endpoint, returning the UI's
 * domain `Profile` list.
 *
 * Server returns the profiles unsorted; we sort by `(isDefault DESC,
 * name ASC)` here so the picker's first tile is always the user's
 * default profile. Doing it at the repository boundary (rather than in
 * the ViewModel) keeps the UI layer ignorant of the server's ordering
 * quirks — every consumer of `loadProfiles()` gets the same display order.
 *
 * The `Profile` UI model doesn't carry `isDefault` (the picker doesn't
 * surface a default-profile badge yet), so we sort the DTO list before
 * mapping — this lets us key the sort directly on the DTO's `isDefault`
 * field without round-tripping it through the UI model.
 *
 * Error mapping mirrors `AuthRepository` and `MoviesRepository`:
 *  - 401 → [Result.NotSignedIn] (token expired/invalid; UI should route
 *    back to sign-in)
 *  - Other 4xx/5xx → [Result.ServerError]
 *  - IOException → [Result.NetworkError]
 *  - Anything else (most commonly a serialization error from a server-side
 *    schema change) → [Result.UnknownError]
 */
@Singleton
class ProfilesRepository @Inject constructor(
    private val apiProvider: AuroraApiProvider,
    private val serverUrlStore: ServerUrlStore,
) {

    suspend fun loadProfiles(): Result {
        val serverUrl = serverUrlStore.current()
            ?: return Result.NotSignedIn

        return try {
            val api = apiProvider.apiOrThrow()
            val response = api.listProfiles()
            val profiles = response
                // Sort on the DTO so we can key on `isDefault` directly,
                // without piping the flag through the UI model.
                .sortedWith(
                    compareByDescending<io.aurora.tv.core.network.dto.UserProfileDto> { it.isDefault }
                        .thenBy { it.name.lowercase() },
                )
                .map { it.toProfile(serverUrl) }
            Result.Success(profiles)
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
        data class Success(val profiles: List<Profile>) : Result
        data object NotSignedIn : Result
        data class NetworkError(val cause: Throwable) : Result
        data class ServerError(val code: Int, val message: String) : Result
        data class UnknownError(val cause: Throwable) : Result
    }
}
