package io.aurora.tv.feature.profiles

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import io.aurora.tv.feature.profiles.data.ProfileSelectionStore
import io.aurora.tv.feature.profiles.data.ProfilesRepository
import javax.inject.Inject
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * ViewModel for the "Who's Watching?" profile picker — Phase 1 wiring
 * against `GET /api/profiles/`.
 *
 * State is exposed as a single `StateFlow<UiState>` that the screen
 * exhaustive-whens on. Three states, mirroring [MoviesViewModel]'s
 * envelope so the cross-screen pattern stays consistent:
 *  - [UiState.Loading]   — initial fetch in flight; screen shows a spinner.
 *  - [UiState.Loaded]    — profiles arrived; screen renders the picker grid.
 *  - [UiState.Error]     — fetch failed; screen shows the message + retry CTA.
 *
 * Profile selection persists via [ProfileSelectionStore] so future
 * surfaces (Home's Continue Watching scoped by profile, parental gating)
 * can read the active profile id later in the session. We persist BEFORE
 * invoking the navigation callback so the next screen can already see
 * the selection on first composition.
 */
@HiltViewModel
class ProfileViewModel @Inject constructor(
    private val repository: ProfilesRepository,
    private val selectionStore: ProfileSelectionStore,
) : ViewModel() {

    private val _state = MutableStateFlow<UiState>(UiState.Loading)
    val state: StateFlow<UiState> = _state.asStateFlow()

    private var activeFetch: Job? = null

    init {
        fetch()
    }

    /** Re-runs the fetch. Wired to the Error → Retry CTA. */
    fun retry() { fetch() }

    /**
     * Persists the user's profile pick, then runs [afterPersisted] (which
     * the screen uses to invoke the navigation callback into Home). The
     * persist-then-navigate ordering matters because Home reads the
     * current selection on first composition to scope its rows by
     * profile id.
     *
     * If persistence fails (DataStore IOException — extremely rare) we
     * still proceed: blocking navigation on a disk write would feel
     * broken to the user, and the worst case is Home falls back to the
     * user-level (un-scoped) Continue Watching feed for the rest of the
     * session.
     */
    fun onProfileSelected(profile: Profile, afterPersisted: () -> Unit) {
        viewModelScope.launch {
            runCatching { selectionStore.setSelectedProfileId(profile.id) }
            afterPersisted()
        }
    }

    private fun fetch() {
        activeFetch?.cancel()
        // Always flip to Loading on a fresh fetch — the picker is a brief
        // interstitial, not a content surface that benefits from "quiet
        // refetch". A spinner during retry is the clearer signal here.
        _state.value = UiState.Loading
        activeFetch = viewModelScope.launch {
            _state.value = when (val result = repository.loadProfiles()) {
                is ProfilesRepository.Result.Success -> {
                    if (result.profiles.isEmpty()) {
                        // Empty profile list shouldn't happen — server creates
                        // a default profile when an account is created — but
                        // surfacing it as an error rather than a blank picker
                        // gives the user a recoverable path.
                        UiState.Error(
                            message = "No profiles found on this account.",
                            canRetry = true,
                        )
                    } else {
                        UiState.Loaded(result.profiles)
                    }
                }
                ProfilesRepository.Result.NotSignedIn -> UiState.Error(
                    message = "Your session expired. Sign in again to continue.",
                    canRetry = false,
                )
                is ProfilesRepository.Result.NetworkError -> UiState.Error(
                    message = "Couldn't reach Aurora. Check your network and try again.",
                    canRetry = true,
                )
                is ProfilesRepository.Result.ServerError -> UiState.Error(
                    message = "Aurora returned ${result.code}. Try again in a moment.",
                    canRetry = true,
                )
                is ProfilesRepository.Result.UnknownError -> UiState.Error(
                    message = "Something went wrong loading profiles (${result.cause::class.simpleName ?: "unknown"}).",
                    canRetry = true,
                )
            }
        }
    }

    sealed interface UiState {
        data object Loading : UiState
        data class Loaded(val profiles: List<Profile>) : UiState
        data class Error(val message: String, val canRetry: Boolean) : UiState
    }
}
