package io.aurora.tv.feature.movies

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.tv.material3.Text
import io.aurora.tv.core.design.AuroraColors
import io.aurora.tv.core.design.AuroraDimensions
import io.aurora.tv.core.design.AuroraTypography
import io.aurora.tv.core.ui.FilterDropdown
import io.aurora.tv.core.ui.NavTab
import io.aurora.tv.core.ui.TopNavBar
import io.aurora.tv.core.ui.media.MediaItem
import io.aurora.tv.core.ui.media.PosterCard
import io.aurora.tv.feature.movies.data.Genre
import io.aurora.tv.feature.movies.data.MoviesFilters
import io.aurora.tv.feature.movies.data.SortBy
import io.aurora.tv.feature.movies.data.Year

/**
 * Movies tab — catalog grid view of the entire film library.
 *
 * Mirrors the Aurora web app's Movies page: a "Movies" header with the
 * total library count, a row of three filter dropdowns (Genre/Year/Sort),
 * and a 6-column grid of poster cards. No hero, no genre rows — Movies
 * is a pure catalog browse, distinct from Home's "what's recommended"
 * surface.
 *
 * === FOCUS CONTRACT ===
 * Mirrors home/detail's pattern but with one new wrinkle: the bar's
 * DOWN target is the *first filter button* (Genre), not a hero CTA.
 * Pressing DOWN from any nav tab routes to Genre; from there spatial
 * nav handles RIGHT through Year/Sort and DOWN into the grid. UP from
 * any filter button routes back to the active tab via explicit
 * focusProperties — same pattern home and detail use.
 *
 * === FILTERS ===
 * Each filter button opens a TV-friendly `FilterMenu` overlay anchored
 * directly under the trigger via the shared `FilterDropdown` primitive
 * in core/ui. Selecting an option updates the MoviesViewModel's filter
 * state, which re-derives the visible grid via a StateFlow<MoviesContent>.
 * The "Movies" header reads the filtered count alongside the always-on
 * "of N total" library size — when no filters narrow the result, the
 * count reverts to "M movies."
 */
@Composable
fun MoviesScreen(
    onItemClick: (MediaItem) -> Unit = {},
    onTabSelected: (NavTab) -> Unit = {},
    /**
     * Forwarded to TopNavBar's search affordance. AuroraNavHost wires this
     * to its `navigateToSearch` helper so the magnifying-glass icon opens
     * Route.Search regardless of which screen launched it.
     */
    onSearch: () -> Unit = {},
    /**
     * Three right-cluster icon callbacks. AuroraNavHost wires these to
     * `navigateToWatchParty / navigateToSettings / navigateToAccount`.
     */
    onWatchParty: () -> Unit = {},
    onSettings: () -> Unit = {},
    onAccount: () -> Unit = {},
    viewModel: MoviesViewModel = hiltViewModel(),
) {
    // We collect state + filters separately so the header (with filter
    // dropdowns) renders consistently across all UI states. During
    // Loading the user can't change filters yet, but during Error they
    // CAN — adjusting a filter triggers a fresh fetch via the VM, which
    // is often how users recover from "no results for this combination."
    val state   by viewModel.state.collectAsStateWithLifecycle()
    val filters by viewModel.filters.collectAsStateWithLifecycle()

    val firstFilterFocusRequester = remember { FocusRequester() }
    val activeTabFocusRequester   = remember { FocusRequester() }

    // Header data for the count line: only filled in once we have a
    // Loaded state. Loading/Error suppress the count entirely (rather
    // than show "0 movies", which would be misleading).
    val totalCount  = (state as? MoviesViewModel.UiState.Loaded)?.content?.totalCount    ?: 0
    val visibleCount = (state as? MoviesViewModel.UiState.Loaded)?.content?.items?.size  ?: 0
    val filtersActive = (state as? MoviesViewModel.UiState.Loaded)?.content?.filtersActive ?: false
    val showCountLine = state is MoviesViewModel.UiState.Loaded

    // Grid scroll state — needed so we can detect "user is near the end"
    // and trigger loadMore() before they actually hit the bottom row.
    val gridState = rememberLazyGridState()

    // `derivedStateOf` recomputes only when its inputs (the grid's layout
    // info) actually change, NOT on every recomposition. Without this we'd
    // re-evaluate the threshold check on every state tick, which is
    // wasteful even though the work itself is cheap.
    //
    // Threshold: trigger when the LAST visible item is within `LOAD_MORE_THRESHOLD`
    // of the total list size. With 6-column grid that's roughly two rows of
    // headroom — enough that the next page lands while the user is still
    // scrolling, not after they've stopped at the bottom and gone "where's
    // the rest?"
    val shouldLoadMore by remember {
        derivedStateOf {
            val layout = gridState.layoutInfo
            val lastVisible = layout.visibleItemsInfo.lastOrNull() ?: return@derivedStateOf false
            val total = layout.totalItemsCount
            // total == 0 happens during very-first-frame composition; bail.
            total > 0 && lastVisible.index >= total - LOAD_MORE_THRESHOLD
        }
    }

    // Drive loadMore. The VM guards against double-fires internally
    // (no-op if already loading or no more pages), so we don't need to
    // throttle here. Keying on `shouldLoadMore` means the effect re-runs
    // when the boolean flips; once it's true, we fire once, and subsequent
    // checks while it stays true are quiet.
    LaunchedEffect(shouldLoadMore) {
        if (shouldLoadMore) viewModel.loadMore()
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(AuroraColors.BgPrimary),
    ) {
        LazyVerticalGrid(
            state                 = gridState,
            columns               = GridCells.Fixed(6),
            contentPadding        = PaddingValues(
                top    = 64.dp,
                bottom = 32.dp,
                start  = AuroraDimensions.SafeAreaHorizontal,
                end    = AuroraDimensions.SafeAreaHorizontal,
            ),
            verticalArrangement   = Arrangement.spacedBy(20.dp),
            horizontalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            item(span = { GridItemSpan(maxLineSpan) }, key = "header") {
                MoviesHeader(
                    totalCount                = totalCount,
                    visibleCount              = visibleCount,
                    filtersActive             = filtersActive,
                    showCountLine             = showCountLine,
                    filters                   = filters,
                    firstFilterFocusRequester = firstFilterFocusRequester,
                    upFocusRequester          = activeTabFocusRequester,
                    onGenreSelected           = viewModel::setGenre,
                    onYearSelected            = viewModel::setYear,
                    onSortSelected            = viewModel::setSort,
                )
            }

            // Body — switches on UiState. Loading and Error states render
            // a single full-width tile (span = maxLineSpan) so the header
            // stays anchored at the top while the central content is the
            // spinner / error message.
            when (val s = state) {
                MoviesViewModel.UiState.Loading -> {
                    item(span = { GridItemSpan(maxLineSpan) }, key = "loading") {
                        LoadingState()
                    }
                }
                is MoviesViewModel.UiState.Loaded -> {
                    items(
                        items = s.content.items,
                        key   = { it.id },
                    ) { item ->
                        Box(
                            modifier         = Modifier.fillMaxWidth(),
                            contentAlignment = Alignment.Center,
                        ) {
                            PosterCard(
                                item    = item,
                                onClick = { onItemClick(item) },
                            )
                        }
                    }
                    // Bottom pagination indicator. Rendered as a full-width
                    // grid row spanning all 6 columns. We show it whenever
                    // there's MORE to load (regardless of whether a fetch is
                    // currently in flight) so the user has a visible signal
                    // that scrolling further is meaningful — and it doubles
                    // as the spinner during the actual fetch via
                    // `isLoadingMore`. When `hasMore = false` we skip the
                    // footer entirely; the grid simply ends.
                    if (s.hasMore || s.isLoadingMore) {
                        item(
                            span = { GridItemSpan(maxLineSpan) },
                            key  = "load-more-footer",
                        ) {
                            LoadingMoreFooter(visible = s.isLoadingMore)
                        }
                    }
                }
                is MoviesViewModel.UiState.Error -> {
                    item(span = { GridItemSpan(maxLineSpan) }, key = "error") {
                        ErrorState(
                            message  = s.message,
                            canRetry = s.canRetry,
                            onRetry  = viewModel::retry,
                        )
                    }
                }
            }
        }

        TopNavBar(
            activeTab               = NavTab.Movies,
            onTabSelected           = onTabSelected,
            onWatchParty            = onWatchParty,
            onSettings              = onSettings,
            onProfile               = onAccount,
            onSearch                = onSearch,
            autoFocusActiveTab      = true,
            downFocusRequester      = firstFilterFocusRequester,
            activeTabFocusRequester = activeTabFocusRequester,
            modifier                = Modifier.align(Alignment.TopCenter),
        )
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Header — "Movies" title + count + filter row
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun MoviesHeader(
    totalCount: Int,
    visibleCount: Int,
    filtersActive: Boolean,
    /**
     * False during Loading and Error states — suppresses the count line
     * entirely rather than displaying "0 movies" while we wait. The title
     * + filter row stay visible so the header height is consistent.
     */
    showCountLine: Boolean,
    filters: MoviesFilters,
    firstFilterFocusRequester: FocusRequester,
    upFocusRequester: FocusRequester,
    onGenreSelected: (Genre) -> Unit,
    onYearSelected: (Year) -> Unit,
    onSortSelected: (SortBy) -> Unit,
) {
    Column(modifier = Modifier.padding(top = 24.dp, bottom = 16.dp)) {
        Text(
            text  = "Movies",
            style = TextStyle(
                fontSize      = 48.sp,
                fontWeight    = FontWeight.Bold,
                letterSpacing = (-0.02).em,
            ),
            color = AuroraColors.TextPrimary,
        )

        Spacer(Modifier.height(6.dp))

        // Count row. When filters narrow the result, show "Showing N of M";
        // otherwise the bare "M movies" string from the original design.
        // Suppressed entirely while we don't have data yet (Loading / Error)
        // so the user doesn't see a spurious "0 movies" before the first
        // network response lands.
        if (showCountLine && filtersActive) {
            Text(
                text  = "Showing $visibleCount of $totalCount",
                style = AuroraTypography.Body,
                color = AuroraColors.TextSecondary,
            )
        } else if (showCountLine) {
            Text(
                text  = "$totalCount movies",
                style = AuroraTypography.Body,
                color = AuroraColors.TextSecondary,
            )
        }

        Spacer(Modifier.height(28.dp))

        Row(
            horizontalArrangement = Arrangement.spacedBy(20.dp),
            verticalAlignment     = Alignment.CenterVertically,
        ) {
            FilterDropdown(
                label                  = "Genre",
                value                  = filters.genre.label,
                options                = Genre.options,
                selected               = filters.genre,
                labelOf                = { it.label },
                onSelected             = onGenreSelected,
                externalFocusRequester = firstFilterFocusRequester,
                upFocusRequester       = upFocusRequester,
            )
            FilterDropdown(
                label            = "Year",
                value            = filters.year.label,
                options          = Year.options,
                selected         = filters.year,
                labelOf          = { it.label },
                onSelected       = onYearSelected,
                upFocusRequester = upFocusRequester,
            )
            FilterDropdown(
                label            = "Sort",
                value            = filters.sort.label,
                options          = SortBy.options,
                selected         = filters.sort,
                labelOf          = { it.label },
                onSelected       = onSortSelected,
                upFocusRequester = upFocusRequester,
            )
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Loading / Error tiles — full-width grid items shown when there's no data
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How close to the end of the grid (in items, not rows) before we trigger
 * `loadMore()`. With 6 columns, 12 items ≈ 2 rows of headroom — enough
 * that the next page's network round-trip can complete before the user
 * actually hits the bottom row, so scrolling feels seamless.
 *
 * If you bump PER_PAGE in MoviesViewModel, consider proportional bumping
 * here too: too-high a threshold relative to a small per_page wastes
 * fetches on every minor scroll; too-low and the user out-scrolls the
 * loader.
 */
private const val LOAD_MORE_THRESHOLD = 12

/**
 * Centered Aurora-colored spinner shown while the initial fetch is in
 * flight. Sized to fill a comfortable amount of vertical space — about
 * 320dp — so the screen reads as "loading something" rather than "tiny
 * spinner stuck at the top." We don't fillMaxSize because the LazyVertical-
 * Grid's item slot sizes itself to its content; a fixed height keeps the
 * header anchored visibly above.
 */
@Composable
private fun LoadingState() {
    Box(
        modifier         = Modifier
            .fillMaxWidth()
            .height(320.dp),
        contentAlignment = Alignment.Center,
    ) {
        AuroraSpinner(size = 56.dp, strokeWidth = 5.dp)
    }
}

/**
 * Footer rendered as a full-width grid row at the end of the catalog,
 * shown only when more pages exist (or one is in flight). Smaller than
 * [LoadingState] — this is a "loading the next chunk" affordance, not a
 * "screen-blocking initial load." Reserves a constant height even when
 * not actively spinning so the user's near-end-of-grid scroll feel is
 * stable: scrolling past the last poster always reveals the same
 * footer-shaped element, with the spinner fading in/out inside.
 *
 * `visible` controls whether the spinner actually animates. When false,
 * we still render the same Box (so the grid's totalItemsCount and
 * "near bottom" detection threshold stay consistent across loading
 * transitions) but with no spinner inside.
 */
@Composable
private fun LoadingMoreFooter(visible: Boolean) {
    Box(
        modifier         = Modifier
            .fillMaxWidth()
            .height(64.dp),
        contentAlignment = Alignment.Center,
    ) {
        if (visible) {
            AuroraSpinner(size = 28.dp, strokeWidth = 3.dp)
        }
    }
}

/**
 * Custom indeterminate spinner — a violet arc rotating clockwise.
 *
 * Why custom rather than `androidx.compose.material3.CircularProgressIndicator`:
 * we don't depend on Material3 in :feature:movies (the app uses
 * `androidx.tv.material3` for TV-specific components, which doesn't ship
 * a progress indicator). Adding the full Material3 module just for one
 * composable would be a big dependency for a tiny UI element. The custom
 * spinner is ~30 lines, uses only `androidx.compose.foundation` /
 * `androidx.compose.animation.core` primitives that are already on the
 * classpath, and matches the rest of the design system because it pulls
 * directly from `AuroraColors.Accent`.
 *
 * The animation uses `infiniteRepeatable` with `RepeatMode.Restart` and a
 * 900ms linear sweep — fast enough to feel responsive, slow enough that a
 * 1080p TV viewer across the room can track the motion. 5dp stroke gives
 * the arc visible weight at TV viewing distances; Material's default 4dp
 * reads hairline-thin from the couch.
 */
@Composable
private fun AuroraSpinner(
    size: androidx.compose.ui.unit.Dp = 48.dp,
    strokeWidth: androidx.compose.ui.unit.Dp = 4.dp,
) {
    val transition = rememberInfiniteTransition(label = "aurora-spinner")
    val angle by transition.animateFloat(
        initialValue  = 0f,
        targetValue   = 360f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 900, easing = LinearEasing),
            repeatMode = RepeatMode.Restart,
        ),
        label = "aurora-spinner-angle",
    )

    Canvas(
        modifier = Modifier
            .size(size)
            .rotate(angle),
    ) {
        // Inset the arc by half the stroke so the line doesn't clip
        // against the canvas edges.
        val strokePx = strokeWidth.toPx()
        val inset = strokePx / 2f
        drawArc(
            color      = AuroraColors.Accent,
            // Sweep less than a full circle so motion is visible — a full
            // 360° arc would render as a static ring.
            startAngle = 0f,
            sweepAngle = 280f,
            useCenter  = false,
            topLeft    = androidx.compose.ui.geometry.Offset(inset, inset),
            size       = Size(this.size.width - strokePx, this.size.height - strokePx),
            style      = Stroke(width = strokePx, cap = StrokeCap.Round),
        )
    }
}

/**
 * Error tile with a message and an optional Retry button. Shown when the
 * initial fetch (or a refetch triggered by a filter change / explicit
 * retry) fails. Retry button calls `onRetry`, which the VM wires to
 * `MoviesViewModel.retry()` — same effect as flipping a filter.
 *
 * `canRetry = false` is for terminal errors (e.g. NotSignedIn) where
 * retrying without changing state is futile; the button is hidden in
 * that case to avoid suggesting a remedy that doesn't exist.
 */
@Composable
private fun ErrorState(
    message: String,
    canRetry: Boolean,
    onRetry: () -> Unit,
) {
    Column(
        modifier              = Modifier
            .fillMaxWidth()
            .height(320.dp)
            .padding(horizontal = 24.dp),
        horizontalAlignment   = Alignment.CenterHorizontally,
        verticalArrangement   = Arrangement.Center,
    ) {
        Text(
            text      = message,
            style     = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.Medium),
            color     = AuroraColors.TextPrimary,
            textAlign = TextAlign.Center,
        )
        if (canRetry) {
            Spacer(Modifier.height(20.dp))
            RetryButton(onClick = onRetry)
        }
    }
}

/**
 * Focusable retry CTA. Same focus grammar as FilterMenuItem / KeyButton:
 * `.clickable` only (no stacked `.focusable()`), accent border + soft fill
 * on focus, label color shifts to TextPrimary.
 */
@Composable
private fun RetryButton(onClick: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()

    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(8.dp))
            .background(
                if (focused) AuroraColors.Accent.copy(alpha = 0.18f) else Color.Transparent,
            )
            .border(
                width = 1.dp,
                color = if (focused) AuroraColors.Accent else AuroraColors.Divider,
                shape = RoundedCornerShape(8.dp),
            )
            .clickable(
                interactionSource = interaction,
                indication        = null,
                onClick           = onClick,
            )
            .padding(horizontal = 20.dp, vertical = 10.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text  = "Try again",
            style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
            color = if (focused) AuroraColors.TextPrimary else AuroraColors.TextSecondary,
        )
    }
}
