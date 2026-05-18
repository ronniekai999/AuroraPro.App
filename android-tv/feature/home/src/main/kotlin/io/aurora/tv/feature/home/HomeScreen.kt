package io.aurora.tv.feature.home

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateDpAsState
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
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.tv.material3.Text
import io.aurora.tv.core.design.AuroraColors
import io.aurora.tv.core.design.AuroraDimensions
import io.aurora.tv.core.ui.NavTab
import io.aurora.tv.core.ui.TopNavBar
import io.aurora.tv.core.ui.media.MediaItem
import io.aurora.tv.core.ui.media.MediaRow
import io.aurora.tv.feature.home.ui.HomeHero

/**
 * Home screen — the surface where the app stops being a setup flow and
 * starts being a streaming platform. First screen the user sees after
 * signing in and picking a profile.
 *
 * Phase 1 (this revision) replaces the static StubData snapshot with a
 * real network fetch via HomeRepository. The screen now branches on a
 * Loading / Loaded / Error envelope. The structural layout below — hero
 * band + N rows in a LazyColumn, TopNavBar overlay — only appears in
 * the Loaded state.
 */
@Composable
fun HomeScreen(
    onItemClick: (MediaItem) -> Unit = {},
    onTabSelected: (NavTab) -> Unit = {},
    onSearch: () -> Unit = {},
    onWatchParty: () -> Unit = {},
    onSettings: () -> Unit = {},
    onAccount: () -> Unit = {},
    viewModel: HomeViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    val watchFocusRequester     = remember { FocusRequester() }
    val activeTabFocusRequester = remember { FocusRequester() }

    var barVisible by remember { mutableStateOf(true) }

    val lazyTopPadding by animateDpAsState(
        targetValue   = if (barVisible) 64.dp else 0.dp,
        animationSpec = tween(durationMillis = 200),
        label = "lazy-top-padding",
    )

    val listState = rememberLazyListState()

    // Force scroll-to-top once on screen entry (see prior behavior — the
    // Home tab's mental model is "take me home," not "restore last
    // position when I navigate back here").
    LaunchedEffect(Unit) {
        listState.scrollToItem(0)
    }

    LaunchedEffect(barVisible) {
        if (barVisible) {
            listState.animateScrollToItem(index = 0, scrollOffset = 0)
        }
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(AuroraColors.BgPrimary),
    ) {
        when (val s = state) {
            HomeViewModel.UiState.Loading -> {
                LoadingState()
            }
            is HomeViewModel.UiState.Error -> {
                ErrorState(
                    message  = s.message,
                    canRetry = s.canRetry,
                    onRetry  = viewModel::retry,
                )
            }
            is HomeViewModel.UiState.Loaded -> {
                val content = s.content
                LazyColumn(
                    state               = listState,
                    verticalArrangement = Arrangement.spacedBy(AuroraDimensions.RowGap),
                    contentPadding      = PaddingValues(top = lazyTopPadding),
                ) {
                    // Hero is omitted entirely when there's nothing to
                    // anchor it on (no Continue Watching, no Recently
                    // Added). Rather than show a blank band, we let the
                    // first row sit at the top.
                    if (content.featured != null) {
                        item(key = "hero") {
                            HomeHero(
                                item                = content.featured,
                                onWatch             = { onItemClick(content.featured) },
                                onMoreInfo          = { onItemClick(content.featured) },
                                watchFocusRequester = watchFocusRequester,
                                upFocusRequester    = activeTabFocusRequester,
                            )
                        }
                    }
                    items(items = content.rows, key = { it.id }) { row ->
                        MediaRow(
                            title       = row.title,
                            items       = row.items,
                            onItemClick = onItemClick,
                        )
                    }
                }
            }
        }

        TopNavBar(
            activeTab               = NavTab.Home,
            onTabSelected           = onTabSelected,
            onWatchParty            = onWatchParty,
            onSettings              = onSettings,
            onProfile               = onAccount,
            onSearch                = onSearch,
            autoFocusActiveTab      = true,
            // DOWN target only meaningful when the hero is on-screen.
            // When the hero is omitted (empty home), Compose's spatial
            // focus search routes DOWN into the first row's first card,
            // which is the right behavior anyway.
            downFocusRequester      = watchFocusRequester,
            activeTabFocusRequester = activeTabFocusRequester,
            onVisibilityChange      = { barVisible = it },
            modifier                = Modifier.align(Alignment.TopCenter),
        )
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Loading / Error / Spinner — duplicated from MoviesScreen.kt for now.
// Promotion to :core:ui is a follow-up refactor; keeping it inline here
// avoids touching that module while two parallel agents are wiring up
// other features against it.
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun LoadingState() {
    Box(
        modifier         = Modifier.fillMaxSize(),
        contentAlignment = Alignment.Center,
    ) {
        AuroraSpinner(size = 56.dp, strokeWidth = 5.dp)
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
            .fillMaxSize()
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
    size: androidx.compose.ui.unit.Dp = 48.dp,
    strokeWidth: androidx.compose.ui.unit.Dp = 4.dp,
) {
    val transition = rememberInfiniteTransition(label = "aurora-spinner")
    val angle by transition.animateFloat(
        initialValue  = 0f,
        targetValue   = 360f,
        animationSpec = infiniteRepeatable(
            animation  = tween(durationMillis = 900, easing = LinearEasing),
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
            topLeft    = Offset(inset, inset),
            size       = Size(this.size.width - strokePx, this.size.height - strokePx),
            style      = Stroke(width = strokePx, cap = StrokeCap.Round),
        )
    }
}
