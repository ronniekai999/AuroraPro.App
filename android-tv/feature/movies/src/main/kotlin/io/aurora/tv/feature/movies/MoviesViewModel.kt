package io.aurora.tv.feature.movies

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import io.aurora.tv.core.ui.media.MediaItem
import io.aurora.tv.feature.movies.data.Genre
import io.aurora.tv.feature.movies.data.MoviesContent
import io.aurora.tv.feature.movies.data.MoviesFilters
import io.aurora.tv.feature.movies.data.MoviesRepository
import io.aurora.tv.feature.movies.data.SortBy
import io.aurora.tv.feature.movies.data.Year
import javax.inject.Inject
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * Movies-screen ViewModel — Phase 1 wiring against the real Aurora server,
 * with infinite-scroll pagination.
 *
 * State is exposed as a single `StateFlow<UiState>` that the screen
 * exhaustive-whens on. Three states:
 *  - [UiState.Loading]   — initial fetch in flight; shows a centered spinner
 *  - [UiState.Loaded]    — got items; renders the catalog grid. Carries
 *                          `hasMore` and `isLoadingMore` so the screen can
 *                          render a footer loader and trigger `loadMore()`
 *                          when the user nears the end of the grid.
 *  - [UiState.Error]     — network/server/unknown failure; shows a retry CTA
 *
 * === Pagination model ===
 * Server-side paged via Aurora's `?page=N&per_page=M` query params.
 * `PER_PAGE = 50` is a balance: large enough that the user has runway to
 * scroll for several seconds before another fetch fires (prefetching is the
 * only thing keeping infinite scroll from feeling laggy on TV remotes), and
 * well under the server's 100-item cap. The trigger threshold in the screen
 * (load when within ~12 items of the end) is sized so the next page lands
 * before the user actually hits the bottom row.
 *
 * Filter changes (Genre/Year/Sort) reset to page 1 and reload the full set,
 * because filtering against an in-memory partial page would lie to the user
 * about how many movies match.
 *
 * === Client-side post-sort + pagination ===
 * For the sort modes Aurora doesn't natively support (YearAsc / RuntimeDesc /
 * RuntimeAsc), we re-sort the entire accumulated list each time a new page
 * lands. That's O((current items) × log(current items)) per page boundary —
 * trivial for the scales we're at (< 10k items would still complete in a
 * single frame budget). The alternative — per-page sort followed by
 * lexicographic merge — is more efficient but the bookkeeping isn't worth
 * the gain at this size.
 *
 * Note: client-side post-sort is fundamentally an approximation when the
 * server returns more pages than the client has fetched. A user picking
 * "Runtime (longest)" sees the longest movie in the FETCHED prefix, not
 * necessarily in the full catalog. Title (A-Z) and Year (newest) are
 * server-sorted globally and remain correct across all pages.
 */
@HiltViewModel
class MoviesViewModel @Inject constructor(
    private val repository: MoviesRepository,
) : ViewModel() {

    private val _filters = MutableStateFlow(MoviesFilters())
    val filters: StateFlow<MoviesFilters> = _filters.asStateFlow()

    private val _state = MutableStateFlow<UiState>(UiState.Loading)
    val state: StateFlow<UiState> = _state.asStateFlow()

    /** Tracks the active fetch so a rapid filter-change can cancel it. */
    private var activeFetch: Job? = null

    /**
     * Tracks the active loadMore() so we don't fire overlapping requests
     * for the same page. Distinct from `activeFetch` because filter
     * refetches and pagination loadMores have different cancellation
     * semantics: a filter change should cancel an in-flight loadMore and
     * a fresh load; a loadMore mid-loadMore should be a no-op (latest
     * wins isn't useful when we're appending sequential pages).
     */
    private var loadMoreJob: Job? = null

    init {
        // Initial load on VM creation — same behavior the stub-backed
        // version had; the screen never sees an empty Loaded state.
        refetch()
    }

    fun setGenre(genre: Genre)   { _filters.update { it.copy(genre = genre) }; refetch() }
    fun setYear(year: Year)      { _filters.update { it.copy(year  = year)  }; refetch() }
    fun setSort(sort: SortBy)    { _filters.update { it.copy(sort  = sort)  }; refetch() }

    /** Re-runs the fetch with the current filters. Used by Error → Retry. */
    fun retry() { refetch() }

    /**
     * Fetches the next page and appends to the current list. No-op if:
     *  - We're not in a Loaded state (initial load hasn't completed yet)
     *  - We've already fetched all pages (`hasMore = false`)
     *  - A loadMore is already in flight
     *
     * The screen calls this when the user scrolls within ~12 items of the
     * end of the grid; throttling against double-fires is built in here so
     * the screen doesn't have to reason about it.
     */
    fun loadMore() {
        val current = _state.value as? UiState.Loaded ?: return
        if (!current.hasMore || current.isLoadingMore) return

        val nextPage = current.currentPage + 1
        loadMoreJob?.cancel()

        // Surface the loading-more state immediately so the screen can
        // render the bottom spinner without waiting for the network.
        _state.value = current.copy(isLoadingMore = true)

        loadMoreJob = viewModelScope.launch {
            val f = _filters.value
            val result = repository.loadMovies(
                genre   = f.genre.matchKey,
                year    = f.year.value,
                sortBy  = f.sort.serverKey,
                page    = nextPage,
                perPage = PER_PAGE,
            )

            // The user may have changed filters mid-fetch. If filters no
            // longer match what we requested, drop the response — the
            // refetch() that filter change kicked off will own state.
            if (_filters.value != f) return@launch

            // The state may also have flipped to Error or Loading via a
            // refetch in the meantime. Only proceed if we're still on
            // the same Loaded snapshot (id matched by currentPage).
            val now = _state.value as? UiState.Loaded ?: return@launch
            if (now.currentPage != current.currentPage) return@launch

            _state.value = when (result) {
                is MoviesRepository.Result.Success -> {
                    // Append the new page to existing items, then re-sort
                    // the combined list if the sort mode requires
                    // client-side ordering. Server-sorted modes (TitleAsc,
                    // YearDesc) skip the re-sort because the server's
                    // global ordering is already correct across pages.
                    // Concatenate pages, then dedupe by id. Even if each
                    // individual page has unique items, a single item can
                    // span two pages when the server's ordering doesn't
                    // have a strict tie-breaker (e.g., two items with the
                    // same year on a year-sorted query). Without dedupe
                    // the LazyVerticalGrid would crash on duplicate keys.
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
                MoviesRepository.Result.NotSignedIn -> UiState.Error(
                    message = "Your session expired. Sign in again to continue.",
                    canRetry = false,
                )
                is MoviesRepository.Result.NetworkError -> {
                    // Network failure during pagination — keep the items
                    // we have, just stop trying to load more for now. The
                    // user can scroll back up or retry by triggering a
                    // filter change. We DON'T flip the whole screen to
                    // Error because that would erase the items already on
                    // display, which feels punitive when only the next
                    // page failed.
                    now.copy(isLoadingMore = false, hasMore = false)
                }
                is MoviesRepository.Result.ServerError -> now.copy(
                    isLoadingMore = false,
                    hasMore = false,
                )
                is MoviesRepository.Result.UnknownError -> now.copy(
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

            // Only flip to Loading if there's nothing already on screen —
            // otherwise let the last good content stay visible during the
            // network round-trip. This is the "quiet refetch" pattern that
            // keeps filter clicks from flashing empty.
            if (_state.value !is UiState.Loaded) {
                _state.value = UiState.Loading
            }

            val result = repository.loadMovies(
                genre   = f.genre.matchKey,
                year    = f.year.value,
                sortBy  = f.sort.serverKey,
                page    = 1,
                perPage = PER_PAGE,
            )
            _state.value = when (result) {
                is MoviesRepository.Result.Success -> {
                    val active = f.genre != Genre.All || f.year != Year.All
                    UiState.Loaded(
                        content = MoviesContent(
                            totalCount    = result.totalCount,
                            // Apply client-side sort for the modes the
                            // server doesn't natively support. See SortBy
                            // docstring (data/MoviesContent.kt) for why.
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
                MoviesRepository.Result.NotSignedIn -> UiState.Error(
                    message = "Your session expired. Sign in again to continue.",
                    canRetry = false,
                )
                is MoviesRepository.Result.NetworkError -> UiState.Error(
                    message = "Couldn't reach Aurora. Check your network and try again.",
                    canRetry = true,
                )
                is MoviesRepository.Result.ServerError -> UiState.Error(
                    message = "Aurora returned ${result.code}. Try again in a moment.",
                    canRetry = true,
                )
                is MoviesRepository.Result.UnknownError -> UiState.Error(
                    message = "Something went wrong loading movies (${result.cause::class.simpleName ?: "unknown"}).",
                    canRetry = true,
                )
            }
        }
    }

    /**
     * Re-sort items locally for sort modes the server's `/api/media`
     * endpoint can't honor natively (currently YearAsc, RuntimeDesc,
     * RuntimeAsc — see SortBy in data/MoviesContent.kt).
     *
     * Across pagination this re-sorts the entire accumulated list each
     * time a new page lands. Cost is O(N log N) where N is the items
     * fetched so far — trivial at our scales (a 2,400-movie library
     * fully fetched would re-sort in well under a frame budget). Caveat:
     * the sort is over the FETCHED prefix, not the entire server-side
     * catalog, so picking "Runtime (longest)" early in scrolling shows
     * the longest movie *currently fetched*, not necessarily the longest
     * in the full library. The two server-supported sort modes (Title
     * A-Z and Year newest) are correctly globally-ordered across pages.
     */
    private fun applyClientSort(items: List<MediaItem>, sort: SortBy): List<MediaItem> = when (sort) {
        SortBy.TitleAsc, SortBy.YearDesc -> items // server-sorted; trust it
        SortBy.YearAsc     -> items.sortedBy { it.year }
        SortBy.RuntimeDesc -> items.sortedByDescending { it.runtimeMinutes }
        SortBy.RuntimeAsc  -> items.sortedBy { it.runtimeMinutes }
    }

    /**
     * Three-state UI envelope: the screen renders one of Loading / Loaded /
     * Error. `Loaded` carries pagination metadata so the screen knows when
     * to render the bottom loader and when to stop firing loadMore().
     */
    sealed interface UiState {
        data object Loading : UiState
        data class Loaded(
            val content: MoviesContent,
            /** 1-indexed page most recently fetched. */
            val currentPage: Int,
            /** Total page count given the active filters and PER_PAGE. */
            val totalPages: Int,
            /** True iff `currentPage < totalPages`. */
            val hasMore: Boolean,
            /** True while a loadMore() fetch is in flight. */
            val isLoadingMore: Boolean,
        ) : UiState
        data class Error(val message: String, val canRetry: Boolean) : UiState
    }

    private companion object {
        /**
         * Items per page. Big enough for ~8 grid rows of headroom before the
         * next fetch fires (so prefetching makes scrolling feel seamless),
         * well under the server's 100-item cap (Aurora forces perPage to
         * 20 if we send anything > 100 or < 1).
         */
        const val PER_PAGE = 50
    }
}
