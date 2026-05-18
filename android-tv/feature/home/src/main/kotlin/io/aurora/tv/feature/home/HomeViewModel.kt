package io.aurora.tv.feature.home

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import io.aurora.tv.feature.home.data.HomeContent
import io.aurora.tv.feature.home.data.HomeRepository
import javax.inject.Inject
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * Home-screen ViewModel — Phase 1 wiring against the real Aurora server.
 *
 * Three-state UiState envelope (Loading / Loaded / Error) consumed by the
 * screen via exhaustive when. Mirrors the shape used by MoviesViewModel,
 * minus pagination — every Home row is intentionally bounded (~20 items)
 * so there's nothing to page.
 */
@HiltViewModel
class HomeViewModel @Inject constructor(
    private val repository: HomeRepository,
) : ViewModel() {

    private val _state = MutableStateFlow<UiState>(UiState.Loading)
    val state: StateFlow<UiState> = _state.asStateFlow()

    private var activeFetch: Job? = null

    init {
        fetch()
    }

    /** Re-runs the load. Wired to Error → Retry. */
    fun retry() {
        fetch()
    }

    private fun fetch() {
        activeFetch?.cancel()
        activeFetch = viewModelScope.launch {
            // Only flip to Loading if there's nothing on screen yet —
            // otherwise let the previous content stay visible during the
            // refetch (the "quiet refetch" pattern Movies uses for
            // filter changes).
            if (_state.value !is UiState.Loaded) {
                _state.value = UiState.Loading
            }

            _state.value = when (val result = repository.loadHome()) {
                is HomeRepository.Result.Success -> UiState.Loaded(result.content)
                HomeRepository.Result.NotSignedIn -> UiState.Error(
                    message  = "Your session expired. Sign in again to continue.",
                    canRetry = false,
                )
                is HomeRepository.Result.NetworkError -> UiState.Error(
                    message  = "Couldn't reach Aurora. Check your network and try again.",
                    canRetry = true,
                )
                is HomeRepository.Result.ServerError -> UiState.Error(
                    message  = "Aurora returned ${result.code}. Try again in a moment.",
                    canRetry = true,
                )
                is HomeRepository.Result.UnknownError -> UiState.Error(
                    message  = "Something went wrong loading home (${result.cause::class.simpleName ?: "unknown"}).",
                    canRetry = true,
                )
            }
        }
    }

    sealed interface UiState {
        data object Loading : UiState
        data class Loaded(val content: HomeContent) : UiState
        data class Error(val message: String, val canRetry: Boolean) : UiState
    }
}
