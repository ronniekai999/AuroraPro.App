package io.aurora.tv.feature.shows

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
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
import androidx.compose.ui.unit.Dp
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
import io.aurora.tv.feature.shows.data.Genre
import io.aurora.tv.feature.shows.data.ShowsFilters
import io.aurora.tv.feature.shows.data.SortBy
import io.aurora.tv.feature.shows.data.Year

/**
 * Shows tab — catalog grid view of the entire TV-series library, wired
 * against Aurora's `?type=show` media endpoint.
 *
 * Structurally identical to MoviesScreen. The Loading / Loaded / Error
 * UiState branching, the infinite-scroll pagination via gridState +
 * derivedStateOf, and the bottom LoadingMoreFooter are all the same.
 * Filter dropdowns are Genre / Year / Sort (the original Genre / Network
 * / Sort changed because Aurora doesn't expose a network field on media
 * items — see ShowsContent.kt for rationale).
 *
 * Several of the private composables (LoadingState, ErrorState, RetryButton,
 * LoadingMoreFooter, AuroraSpinner) are duplicated from MoviesScreen
 * verbatim. They're cheap to maintain in lockstep for now; promoting to
 * core/ui as `CatalogStates.kt` is a clean follow-up once a third
 * catalog-style screen (My Library, Requests) appears and the pattern
 * stabilizes.
 */
@Composable
fun ShowsScreen(
    onItemClick: (MediaItem) -> Unit = {},
    onTabSelected: (NavTab) -> Unit = {},
    onSearch: () -> Unit = {},
    onWatchParty: () -> Unit = {},
    onSettings: () -> Unit = {},
    onAccount: () -> Unit = {},
    viewModel: ShowsViewModel = hiltViewModel(),
) {
    val state   by viewModel.state.collectAsStateWithLifecycle()
    val filters by viewModel.filters.collectAsStateWithLifecycle()

    val firstFilterFocusRequester = remember { FocusRequester() }
    val activeTabFocusRequester   = remember { FocusRequester() }

    // Header data — only meaningful in Loaded state. Loading/Error
    // suppress the count line.
    val totalCount   = (state as? ShowsViewModel.UiState.Loaded)?.content?.totalCount    ?: 0
    val visibleCount = (state as? ShowsViewModel.UiState.Loaded)?.content?.items?.size  ?: 0
    val filtersActive = (state as? ShowsViewModel.UiState.Loaded)?.content?.filtersActive ?: false
    val showCountLine = state is ShowsViewModel.UiState.Loaded

    // Grid state for "near bottom" pagination trigger.
    val gridState = rememberLazyGridState()

    // Recomputes only when grid layout actually changes (not on every
    // tick). See MoviesScreen for the full rationale on this pattern.
    val shouldLoadMore by remember {
        derivedStateOf {
            val layout = gridState.layoutInfo
            val lastVisible = layout.visibleItemsInfo.lastOrNull() ?: return@derivedStateOf false
            val total = layout.totalItemsCount
            total > 0 && lastVisible.index >= total - LOAD_MORE_THRESHOLD
        }
    }

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
                ShowsHeader(
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

            when (val s = state) {
                ShowsViewModel.UiState.Loading -> {
                    item(span = { GridItemSpan(maxLineSpan) }, key = "loading") {
                        LoadingState()
                    }
                }
                is ShowsViewModel.UiState.Loaded -> {
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
                    if (s.hasMore || s.isLoadingMore) {
                        item(
                            span = { GridItemSpan(maxLineSpan) },
                            key  = "load-more-footer",
                        ) {
                            LoadingMoreFooter(visible = s.isLoadingMore)
                        }
                    }
                }
                is ShowsViewModel.UiState.Error -> {
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
            activeTab               = NavTab.Shows,
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
// Header — "Shows" title + count + filter row
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun ShowsHeader(
    totalCount: Int,
    visibleCount: Int,
    filtersActive: Boolean,
    showCountLine: Boolean,
    filters: ShowsFilters,
    firstFilterFocusRequester: FocusRequester,
    upFocusRequester: FocusRequester,
    onGenreSelected: (Genre) -> Unit,
    onYearSelected: (Year) -> Unit,
    onSortSelected: (SortBy) -> Unit,
) {
    Column(modifier = Modifier.padding(top = 24.dp, bottom = 16.dp)) {
        Text(
            text  = "Shows",
            style = TextStyle(
                fontSize      = 48.sp,
                fontWeight    = FontWeight.Bold,
                letterSpacing = (-0.02).em,
            ),
            color = AuroraColors.TextPrimary,
        )

        Spacer(Modifier.height(6.dp))

        if (showCountLine && filtersActive) {
            Text(
                text  = "Showing $visibleCount of $totalCount",
                style = AuroraTypography.Body,
                color = AuroraColors.TextSecondary,
            )
        } else if (showCountLine) {
            Text(
                text  = "$totalCount shows",
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
// Loading / Error / Pagination tiles — duplicated from MoviesScreen.
// Promote to core/ui once a third catalog-style screen needs them.
// ─────────────────────────────────────────────────────────────────────────────

private const val LOAD_MORE_THRESHOLD = 12

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

@Composable
private fun AuroraSpinner(
    size: Dp = 48.dp,
    strokeWidth: Dp = 4.dp,
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
        val strokePx = strokeWidth.toPx()
        val inset = strokePx / 2f
        drawArc(
            color      = AuroraColors.Accent,
            startAngle = 0f,
            sweepAngle = 280f,
            useCenter  = false,
            topLeft    = androidx.compose.ui.geometry.Offset(inset, inset),
            size       = Size(this.size.width - strokePx, this.size.height - strokePx),
            style      = Stroke(width = strokePx, cap = StrokeCap.Round),
        )
    }
}
