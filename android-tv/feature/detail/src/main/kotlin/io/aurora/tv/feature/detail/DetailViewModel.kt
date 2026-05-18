package io.aurora.tv.feature.detail

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import io.aurora.tv.feature.detail.data.DetailContent
import io.aurora.tv.feature.detail.data.DetailRepository
import javax.inject.Inject
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * Detail-screen ViewModel — Phase 1 wiring against `/api/media/{id}`
 * with cast, files, and tracks all coming from the enriched response.
 *
 * The media id arrives via SavedStateHandle. Compose Navigation 2.8
 * (with our typed `Route.Detail(id: Long)` route) puts route args into
 * the SavedStateHandle automatically; we just `require()` the id and
 * fetch on init. No need for the screen to push the id in via a side
 * channel.
 *
 * State shape mirrors Movies/Shows: `Loading` (initial), `Loaded`
 * (got everything), `Error` (with retry where it makes sense). The
 * `NotFound` repository result becomes `Error(canRetry = false)` —
 * a deleted item won't come back from a retry.
 */
@HiltViewModel
class DetailViewModel @Inject constructor(
    private val repository: DetailRepository,
    savedStateHandle: SavedStateHandle,
) : ViewModel() {

    /**
     * The media id this screen is showing. Pulled from the typed route
     * arg via SavedStateHandle. `requireNotNull` because the route
     * declaration guarantees the arg is present — an absent id here
     * means a developer error (someone navigated to Route.Detail without
     * supplying an id), which we want to fail-fast on rather than
     * silently render an empty screen.
     */
    private val mediaId: Long = requireNotNull(savedStateHandle.get<Long>("id")) {
        "Detail screen launched without an id route argument."
    }

    private val _state = MutableStateFlow<UiState>(UiState.Loading)
    val state: StateFlow<UiState> = _state.asStateFlow()

    private var activeFetch: Job? = null

    init {
        fetch()
    }

    fun retry() { fetch() }

    private fun fetch() {
        activeFetch?.cancel()
        activeFetch = viewModelScope.launch {
            // Always flip to Loading on a fresh fetch — unlike Movies'
            // "quiet refetch" pattern, the detail screen has no useful
            // previous content to keep visible across a reload (it's a
            // single-item view, not a list that gets refined). A
            // momentary spinner is honest here.
            _state.value = UiState.Loading
            _state.value = when (val result = repository.loadDetail(mediaId)) {
                is DetailRepository.Result.Success -> UiState.Loaded(result.content)
                DetailRepository.Result.NotSignedIn -> UiState.Error(
                    message = "Your session expired. Sign in again to continue.",
                    canRetry = false,
                )
                DetailRepository.Result.NotFound -> UiState.Error(
                    message = "This item is no longer in your library.",
                    canRetry = false,
                )
                is DetailRepository.Result.NetworkError -> UiState.Error(
                    message = "Couldn't reach Aurora. Check your network and try again.",
                    canRetry = true,
                )
                is DetailRepository.Result.ServerError -> UiState.Error(
                    message = "Aurora returned ${result.code}. Try again in a moment.",
                    canRetry = true,
                )
                is DetailRepository.Result.UnknownError -> UiState.Error(
                    message = "Something went wrong loading this item " +
                        "(${result.cause::class.simpleName ?: "unknown"}).",
                    canRetry = true,
                )
            }
        }
    }

    sealed interface UiState {
        data object Loading : UiState
        data class Loaded(val content: DetailContent) : UiState
        data class Error(val message: String, val canRetry: Boolean) : UiState
    }
}
