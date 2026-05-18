package io.aurora.tv.feature.detail

import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
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
import io.aurora.tv.core.design.AuroraTypography
import io.aurora.tv.core.ui.NavTab
import io.aurora.tv.core.ui.TopNavBar
import io.aurora.tv.core.ui.media.MediaItem
import io.aurora.tv.core.ui.media.MediaRow
import io.aurora.tv.feature.detail.ui.CastStrip
import io.aurora.tv.feature.detail.ui.DetailHero
import io.aurora.tv.feature.detail.ui.MediaInfoSection

/**
 * Detail screen — single-focus showcase for one item.
 *
 * === STRUCTURE ===
 *  LazyColumn root (scrolls vertically):
 *    [0] DetailHero       — fills the full viewport. Backdrop + poster +
 *                           title + meta + CTAs + resolution badges.
 *    [1] CastStrip        — "Cast" header + LazyRow of 8 portraits
 *    [2] MediaInfoSection — Audio Tracks list + Subtitles list
 *    [3] MediaRow         — "More like this" + 5 related posters
 *  TopNavBar overlay      — same chrome as home; same show-on-focus
 *                           coordination so hero remains anchored when
 *                           the bar is reached again from below.
 *
 * === BAR / HERO COORDINATION (Stage-1 fix) ===
 * Detail mirrors HomeScreen's pattern:
 *  - `barVisible` state driven by TopNavBar's `onVisibilityChange`
 *  - `lazyTopPadding` animates 0dp ↔ 64dp on the same 200ms tween as
 *    the bar's own alpha/offset
 *  - `LaunchedEffect(barVisible)` scrolls back to item 0 when the bar
 *    re-emerges, so the user navigating up from cast / media-info /
 *    "more like this" lands with the hero fully in view, not clipped.
 *
 * === HOME-TAB NAVIGATION ===
 * `onHomeSelected` is provided by the nav host; clicking the Home tab
 * pops back to the home screen rather than no-opping. Other tabs and
 * icons remain no-ops until their destinations exist.
 */
@Composable
fun DetailScreen(
    /**
     * The server's primary key for the focal item. The screen fetches
     * everything fresh via `DetailViewModel` on entry — no nav-arg
     * snapshot to go stale. The id arrives via the typed Route.Detail
     * arg and is read from SavedStateHandle inside the VM.
     */
    mediaId: Long,
    /**
     * Called when the user activates a card in the "More like this" row.
     * The id is extracted upstream by AuroraNavHost.navigateToDetail.
     */
    onItemClick: (MediaItem) -> Unit = {},
    /**
     * Called when the user activates a tab in the top nav. Generic
     * `(NavTab) -> Unit` so the host's single routing helper handles
     * Home (pop back), Movies (navigate), and future destinations
     * uniformly — no special-cased per-tab callbacks on this screen.
     */
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
    viewModel: DetailViewModel = hiltViewModel(),
) {
    // mediaId is consumed by the VM via SavedStateHandle — referenced
    // here only so Compose's parameter-validation considers it used.
    @Suppress("UNUSED_VARIABLE")
    val routeId = mediaId

    val state by viewModel.state.collectAsStateWithLifecycle()

    // Symmetric focus routing — mirrors HomeScreen's pattern. Two
    // requesters created here:
    //   - watchFocusRequester    → attached to the Play button below;
    //                              used by every nav item as their
    //                              `down` target so DOWN from any tab/
    //                              icon focuses Play.
    //   - activeTabFocusRequester → attached to the active tab in the
    //                              bar; used by Play as its `up` target
    //                              so UP from Play returns to the bar
    //                              cleanly, regardless of where spatial
    //                              focus search would otherwise land.
    // Without this routing, the user gets a focus trap: UP from a CTA
    // lands on a bar tab via spatial nav, but `focusGroup()` on the bar
    // prevents focus from leaving the tab row — no DOWN, no LEFT/RIGHT
    // beyond the closest tab. Same trap we fixed on home; same fix here.
    val watchFocusRequester     = remember { FocusRequester() }
    val activeTabFocusRequester = remember { FocusRequester() }

    // Bar visibility — defaults to TRUE on detail because the bar takes
    // initial focus on entry (autoFocusActiveTab = true on TopNavBar).
    // This also means our LaunchedEffect(barVisible) below fires once at
    // frame 0 and snaps the LazyColumn to scroll 0, so the hero's title
    // is anchored at the top from the moment the screen appears — no
    // race with Compose's autofocus-driven bring-into-view machinery.
    var barVisible by remember { mutableStateOf(true) }

    // FIXED 108dp top contentPadding (was animated 0↔64dp).
    //
    // After three rounds chasing why the title kept clipping behind the
    // bar despite various attempts to position content inside the hero
    // (Row.padding, Column+Spacer, Modifier.offset), all of which were
    // silently absorbed by some layout interaction in detail's specific
    // composition tree — committing to a structural fix that can't fail.
    // contentPadding is a LazyColumn primitive that ALWAYS offsets the
    // first item by exact pixels; no measurement chain to absorb.
    //
    // 108dp = 64dp bar height + 44dp breathing room. With the bar visible,
    // 44dp of clear space between bar bottom and hero top. With the bar
    // hidden, 108dp of BgPrimary backdrop above the hero — slightly dead
    // when bar is hidden, but acceptable; Phase 1 polish can revisit if
    // needed (likely by always-visible bar on detail, dropping the
    // hide-on-blur behavior just on this screen).
    val listState = rememberLazyListState()

    // Force scroll-to-top once on screen entry. Reasons we need this even
    // though listState defaults to scroll-0 on cold launch:
    //  1. Watch button's autoFocus can trigger Compose's "bring focused
    //     item into view" auto-scroll on the LazyColumn, which pushes the
    //     hero's top off-screen because Watch sits ~470dp down the hero.
    //  2. listState is rememberSaveable-backed, so on second-and-later
    //     navigations to detail (or back-stack restoration) the scroll
    //     position would otherwise restore from saved state, not from 0.
    // scrollToItem (synchronous) rather than animateScrollToItem so this
    // happens immediately and overrides any auto-scroll race.
    LaunchedEffect(Unit) {
        listState.scrollToItem(0)
    }

    // Scroll back to the hero when the bar reveals. Animated because this
    // is a user-driven action (they pressed UP to reach the bar) and the
    // scroll-back-to-hero motion is part of the visual feedback.
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
        LazyColumn(
            state               = listState,
            verticalArrangement = Arrangement.spacedBy(AuroraDimensions.RowGap),
            // 64dp top inset — MATCHES HOME exactly. Hero starts at
            // viewport y=64, with the backdrop image visible immediately
            // beneath the bar's bottom edge. No dark stripe between bar
            // and hero. The title's 60dp breathing room is now created
            // INSIDE the hero (via Modifier.offset on the content Row in
            // DetailHero), so the title is below where the bar's bottom
            // sits but the backdrop image itself extends all the way up
            // to the bar — eliminating the "tall bar" visual artifact
            // the user pointed out. Bar uniformity across home and detail
            // matters because the chrome is a navigation surface; users
            // shouldn't see it as having two different sizes depending on
            // which screen they're on.
            contentPadding      = PaddingValues(top = 64.dp, bottom = 32.dp),
        ) {
            when (val s = state) {
                DetailViewModel.UiState.Loading -> {
                    item(key = "loading") {
                        DetailStatusTile(
                            primary = "Loading…",
                            secondary = null,
                        )
                    }
                }
                is DetailViewModel.UiState.Error -> {
                    item(key = "error") {
                        DetailStatusTile(
                            primary = s.message,
                            secondary = if (s.canRetry) "Press refresh to try again." else null,
                        )
                    }
                }
                is DetailViewModel.UiState.Loaded -> {
                    val content = s.content
                    item(key = "hero") {
                        DetailHero(
                            item                = content.item,
                            starRating          = content.starRating,
                            variants            = content.mediaVariants,
                            onWatch             = { /* P2: launch player */ },
                            onAddToList         = { /* P2: toggle list membership */ },
                            onMarkWatched       = { /* P2: toggle watched flag */ },
                            onResume            = { /* P2: launch player at offset */ },
                            onWatchParty        = onWatchParty,
                            onRefresh           = { viewModel.retry() },
                            watchFocusRequester = watchFocusRequester,
                            upFocusRequester    = activeTabFocusRequester,
                            modifier            = Modifier.height(420.dp),
                        )
                    }
                    item(key = "cast") {
                        CastStrip(
                            cast        = content.cast,
                            onCastClick = { /* P2: navigate to person detail */ },
                        )
                    }
                    item(key = "media-info") {
                        MediaInfoSection(
                            audioTracks = content.audioTracks,
                            subtitles   = content.subtitles,
                        )
                    }
                    item(key = "related") {
                        MediaRow(
                            title       = "More like this",
                            items       = content.related,
                            onItemClick = onItemClick,
                        )
                    }
                }
            }
        }

        // Top nav overlay. onTabSelected routes Home → onHomeSelected so
        // the user can reach home from any detail page; other destinations
        // remain no-ops until their screens exist (Slice D / E).
        TopNavBar(
            activeTab               = NavTab.Home,
            onTabSelected           = onTabSelected,
            onWatchParty            = onWatchParty,
            onSettings              = onSettings,
            onProfile               = onAccount,
            onSearch                = onSearch,
            // Bar takes initial focus on entry — mirrors home. Two wins:
            //  1. The bar's autoFocus + onVisibilityChange → barVisible=true
            //     → LaunchedEffect snaps the LazyColumn to scroll 0 → hero
            //     title locks at the top from frame 0. No race with
            //     Compose's autofocus-driven LazyColumn auto-scroll, which
            //     was clipping the title before this fix.
            //  2. UP from Play has somewhere to land (the active tab) and
            //     the tab row has explicit DOWN routing back to Play, so
            //     the focus traversal can't get stuck in the bar.
            autoFocusActiveTab      = true,
            // Explicit DOWN/UP routing — without this, focusGroup() on
            // the bar traps focus when entered from below. Same fix that
            // home uses; the only reason we hadn't applied it here was
            // an oversight in detail's first wiring.
            downFocusRequester      = watchFocusRequester,
            activeTabFocusRequester = activeTabFocusRequester,
            // Visibility coupling — drives the contentPadding animation
            // and the scroll-to-top above. Same pattern as home.
            onVisibilityChange      = { barVisible = it },
            modifier                = Modifier.align(Alignment.TopCenter),
        )
    }
}

@Composable
private fun DetailStatusTile(
    primary: String,
    secondary: String?,
) {
    androidx.compose.foundation.layout.Column(
        modifier = Modifier
            .fillMaxWidth()
            .height(420.dp)
            .padding(horizontal = 32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = androidx.compose.foundation.layout.Arrangement.Center,
    ) {
        Text(
            text      = primary,
            style     = TextStyle(fontSize = 18.sp, fontWeight = FontWeight.Medium),
            color     = AuroraColors.TextPrimary,
            textAlign = TextAlign.Center,
        )
        if (secondary != null) {
            androidx.compose.foundation.layout.Spacer(Modifier.height(12.dp))
            Text(
                text      = secondary,
                style     = AuroraTypography.Body,
                color     = AuroraColors.TextSecondary,
                textAlign = TextAlign.Center,
            )
        }
    }
}
