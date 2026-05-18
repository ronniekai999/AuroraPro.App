package io.aurora.tv.feature.shows

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import io.aurora.tv.core.ui.media.MediaItem
import io.aurora.tv.feature.shows.data.Genre
import io.aurora.tv.feature.shows.data.ShowsContent
import io.aurora.tv.feature.shows.data.ShowsFilters
import io.aurora.tv.feature.shows.data.ShowsRepository
import io.aurora.tv.feature.shows.data.SortBy
import io.aurora.tv.feature.shows.data.Year
import javax.inject.Inject
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * Shows-screen ViewModel — Phase 1 wiring against Aurora's `?type=show`
 * media endpoint, with infinite-scroll pagination.
 *
 * Structurally identical to MoviesViewModel — same UiState shape, same
 * pagination model, same client-side post-sort fallback for sort modes
 * the server doesn't natively support, same race-handling guards
 * (cancel-in-flight on filter change; no-op overlapping loadMores).
 *
 * Filter axes are Genre / Year / Sort (not the original Genre / Network /
 * Sort). The Network axis was dropped because Aurora's server doesn't
 * expose a network field on media items; see ShowsContent.kt's docstring
 * for the rationale.
 */
@HiltViewModel
class ShowsViewModel @Inject constructor(
    private val repository: ShowsRepository,
) : ViewModel() {

    private val _filters = MutableStateFlow(ShowsFilters())
    val filters: StateFlow<ShowsFilters> = _filters.asStateFlow()

    private val _state = MutableStateFlow<UiState>(UiState.Loading)
    val state: StateFlow<UiState> = _state.asStateFlow()

    private var activeFetch: Job? = null
    private var loadMoreJob: Job? = null

    init {
        refetch()
    }

    fun setGenre(genre: Genre)   { _filters.update { it.copy(genre = genre) }; refetch() }
    fun setYear(year: Year)      { _filters.update { it.copy(year  = year)  }; refetch() }
    fun setSort(sort: SortBy)    { _filters.update { it.copy(sort  = sort)  }; refetch() }

    fun retry() { refetch() }

    /**
     * Fetch the next page and append. No-op if not in Loaded state, or
     * we've already fetched all pages, or a loadMore is already in flight.
     * See MoviesViewModel for the full reasoning around race handling.
     */
    fun loadMore() {
        val current = _state.value as? UiState.Loaded ?: return
        if (!current.hasMore || current.isLoadingMore) return

        val nextPage = current.currentPage + 1
        loadMoreJob?.cancel()

        _state.value = current.copy(isLoadingMore = true)

        loadMoreJob = viewModelScope.launch {
            val f = _filters.value
            val result = repository.loadShows(
                genre   = f.genre.matchKey,
                year    = f.year.value,
                sortBy  = f.sort.serverKey,
                page    = nextPage,
                perPage = PER_PAGE,
            )

            // Filter changed mid-fetch → drop the response.
            if (_filters.value != f) return@launch

            val now = _state.value as? UiState.Loaded ?: return@launch
            if (now.currentPage != current.currentPage) return@launch

            _state.value = when (result) {
                is ShowsRepository.Result.Success -> {
                    // Dedupe across page boundaries — see MoviesViewModel
                    // for the full rationale. Same crash class as Cast.
                    val combined = (now.content.items + result.items).distinctBy { it.id }
                    val sorted = applyClientSort(combined, f.sort)
                    now.copy(
                        content       = now.content.copy(items = sorted),
                        currentPage   = result.currentPage,
                        totalPages    = result.totalPages,
                        hasMore       = result.currentPage < result.totalPages,
                        isLoadingMore = false,
                    )
                }
                ShowsRepository.Result.NotSignedIn -> UiState.Error(
                    message = "Your session expired. Sign in again to continue.",
                    canRetry = false,
                )
                is ShowsRepository.Result.NetworkError -> {
                    // Same "keep what we have" approach as Movies — failing
                    // a pagination request shouldn't punish the user by
                    // erasing already-loaded content.
                    now.copy(isLoadingMore = false, hasMore = false)
                }
                is ShowsRepository.Result.ServerError -> now.copy(
                    isLoadingMore = false,
                    hasMore = false,
                )
                is ShowsRepository.Result.UnknownError -> now.copy(
                    isLoadingMore = false,
                    hasMore = false,
                )
            }
        }
    }

    private fun refetch() {
        activeFetch?.cancel()
        loadMoreJob?.cancel()
        activeFetch = viewModelScope.launch {
            val f = _filters.value

            if (_state.value !is UiState.Loaded) {
                _state.value = UiState.Loading
            }

            val result = repository.loadShows(
                genre   = f.genre.matchKey,
                year    = f.year.value,
                sortBy  = f.sort.serverKey,
                page    = 1,
                perPage = PER_PAGE,
            )
            _state.value = when (result) {
                is ShowsRepository.Result.Success -> {
                    val active = f.genre != Genre.All || f.year != Year.All
                    UiState.Loaded(
                        content = ShowsContent(
                            totalCount    = result.totalCount,
                            items         = applyClientSort(result.items, f.sort),
                            filters       = f,
                            filtersActive = active,
                        ),
                        currentPage   = result.currentPage,
                        totalPages    = result.totalPages,
                        hasMore       = result.currentPage < result.totalPages,
                        isLoadingMore = false,
                    )
                }
                ShowsRepository.Result.NotSignedIn -> UiState.Error(
                    message = "Your session expired. Sign in again to continue.",
                    canRetry = false,
                )
                is ShowsRepository.Result.NetworkError -> UiState.Error(
                    message = "Couldn't reach Aurora. Check your network and try again.",
                    canRetry = true,
                )
                is ShowsRepository.Result.ServerError -> UiState.Error(
                    message = "Aurora returned ${result.code}. Try again in a moment.",
                    canRetry = true,
                )
                is ShowsRepository.Result.UnknownError -> UiState.Error(
                    message = "Something went wrong loading shows (${result.cause::class.simpleName ?: "unknown"}).",
                    canRetry = true,
                )
            }
        }
    }

    /** Same client-side sort fallback as Movies. See MoviesViewModel for caveats. */
    private fun applyClientSort(items: List<MediaItem>, sort: SortBy): List<MediaItem> = when (sort) {
        SortBy.TitleAsc, SortBy.YearDesc -> items
        SortBy.YearAsc     -> items.sortedBy { it.year }
        SortBy.RuntimeDesc -> items.sortedByDescending { it.runtimeMinutes }
        SortBy.RuntimeAsc  -> items.sortedBy { it.runtimeMinutes }
    }

    sealed interface UiState {
        data object Loading : UiState
        data class Loaded(
            val content: ShowsContent,
            val currentPage: Int,
            val totalPages: Int,
            val hasMore: Boolean,
            val isLoadingMore: Boolean,
        ) : UiState
        data class Error(val message: String, val canRetry: Boolean) : UiState
    }

    private companion object {
        const val PER_PAGE = 50
    }
}
