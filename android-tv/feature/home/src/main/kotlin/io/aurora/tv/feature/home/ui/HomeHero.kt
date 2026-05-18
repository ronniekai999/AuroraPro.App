package io.aurora.tv.feature.home.ui

import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Text
import coil3.compose.SubcomposeAsyncImage
import io.aurora.tv.core.design.AuroraColors
import io.aurora.tv.core.design.AuroraDimensions
import io.aurora.tv.core.design.AuroraTypography
import io.aurora.tv.core.ui.media.MediaItem

/**
 * Hero band — top 400dp of the home screen, anchoring one featured item.
 *
 * === LAYERS (back to front) ===
 *  1. Backdrop: linear gradient using the item's accentHue. Same HSV pair
 *     the poster cards use, so the hero's color identity matches the item's
 *     poster card in the row below — visual continuity.
 *  2. Bottom scrim: vertical gradient fading to BgPrimary. Two jobs: makes
 *     the title legible against the bright backdrop, AND blends the hero
 *     visually into the row below so they read as one composition rather
 *     than a hard 400dp band on top of black.
 *  3. Content column: left-aligned, max 680dp wide (HeroContentWidth).
 *     verticalArrangement = Bottom — the title block sinks to the lower
 *     half so the upper half is "open art space," same composition Netflix
 *     and Plex use.
 *  4. CTA row: primary "Watch" + secondary "More info". Watch auto-focuses
 *     on screen entry so the user lands on a clear action.
 *
 * Slice C: backdrop becomes a Coil-loaded backdrop image, gradient becomes
 * the scrim layer applied OVER the image. Layout stays the same.
 */
@Composable
fun HomeHero(
    item: MediaItem,
    onWatch: () -> Unit,
    onMoreInfo: () -> Unit,
    modifier: Modifier = Modifier,
    /**
     * Optional external FocusRequester for the Watch button. The home screen
     * passes one in and ALSO hands it to the TopNavBar as its
     * `downFocusRequester` — the result is that DOWN on any nav item focuses
     * Watch, regardless of how spatial focus search would otherwise behave.
     */
    watchFocusRequester: FocusRequester? = null,
    /**
     * Optional FocusRequester to redirect UP-arrow on the hero CTAs. Symmetric
     * to `watchFocusRequester` — the home screen creates one, attaches it to
     * the active tab in the TopNavBar, and passes it here so pressing UP from
     * Watch or More info focuses the active tab and the bar fades back in.
     */
    upFocusRequester: FocusRequester? = null,
) {
    val backdropTop = Color.hsv(item.accentHue.toFloat(), 0.55f, 0.55f)
    val backdropMid = Color.hsv(item.accentHue.toFloat(), 0.55f, 0.30f)

    // Gradient brush extracted as a value so the image's loading and
    // error slots both render the same hue-derived backdrop. Real
    // artwork is the success path; fallback is graceful — the user
    // gets the brand-color backdrop they would have had pre-Slice-C
    // rather than a black hole.
    val fallbackBackdrop = Brush.linearGradient(
        colors = listOf(backdropTop, backdropMid, AuroraColors.BgPrimary),
        start  = Offset(0f, 0f),
        end    = Offset.Infinite,
    )

    Box(
        modifier = modifier
            .fillMaxWidth()
            .height(AuroraDimensions.HeroHeight),
    ) {
        // Layer 1: backdrop artwork. SubcomposeAsyncImage gives us
        // separate slots for loading / error / success — both fallback
        // states render the gradient, so the user never sees a black
        // hero band even on a cold network. ContentScale.Crop fills
        // the 400dp band and crops overflow on aspect mismatch.
        SubcomposeAsyncImage(
            model              = item.backdropUrl,
            contentDescription = "${item.title} backdrop",
            contentScale       = ContentScale.Crop,
            modifier           = Modifier.fillMaxSize(),
            loading = {
                Box(modifier = Modifier
                    .fillMaxSize()
                    .background(fallbackBackdrop)
                )
            },
            error = {
                Box(modifier = Modifier
                    .fillMaxSize()
                    .background(fallbackBackdrop)
                )
            },
        )

        // Layer 2: bottom scrim — fades the hero into BgPrimary so the row
        // beneath feels continuous with it rather than separated by a hard
        // edge. Also darkens the title region for legibility.
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(
                    Brush.verticalGradient(
                        0f    to Color.Transparent,
                        0.55f to AuroraColors.BgPrimary.copy(alpha = 0.55f),
                        1f    to AuroraColors.BgPrimary,
                    ),
                ),
        )

        // Layer 3: content column, anchored to bottom-left
        Column(
            modifier = Modifier
                .fillMaxHeight()
                .widthIn(max = AuroraDimensions.HeroContentWidth)
                .padding(
                    start  = AuroraDimensions.SafeAreaHorizontal,
                    end    = AuroraDimensions.SafeAreaHorizontal,
                    top    = AuroraDimensions.SafeAreaVertical,
                    bottom = AuroraDimensions.SafeAreaVertical,
                ),
            verticalArrangement = Arrangement.Bottom,
        ) {
            // Hero title — 56sp inline rather than HeroTitle (72sp) so it
            // doesn't overflow on long titles and leaves room for metadata
            // and description below.
            Text(
                text  = item.title,
                style = TextStyle(
                    fontSize      = 56.sp,
                    fontWeight    = FontWeight.Bold,
                    letterSpacing = (-0.02).em,
                    lineHeight    = 60.sp,
                ),
                color    = AuroraColors.TextPrimary,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )

            Spacer(Modifier.height(8.dp))
            HeroMetaRow(item)

            Spacer(Modifier.height(12.dp))
            Text(
                text     = item.description,
                style    = AuroraTypography.BodyLarge,
                color    = AuroraColors.TextSecondary,
                maxLines = 3,
                overflow = TextOverflow.Ellipsis,
            )

            Spacer(Modifier.height(20.dp))
            HeroCtaRow(
                onWatch             = onWatch,
                onMoreInfo          = onMoreInfo,
                watchFocusRequester = watchFocusRequester,
                upFocusRequester    = upFocusRequester,
            )
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Meta row — year · runtime · rating · genres
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Single horizontal line of metadata. Bullets are baked into the strings
 * rather than rendered as separate Text composables — fewer composables,
 * cleaner spacing, and the typography stays consistent across separators.
 */
@Composable
private fun HeroMetaRow(item: MediaItem) {
    // Each part is conditionally added — sentinel values from feeds with
    // sparse metadata (e.g. ContinueWatchingItem doesn't carry year/rating/
    // genres) would render as "0  ·  0m  ·  " without these guards. Empty
    // strings from `rating`/`genres` are filtered out the same way.
    val parts = buildList {
        if (item.year > 0) add(item.year.toString())
        if (item.runtimeMinutes > 0) add(formatRuntime(item.runtimeMinutes))
        if (item.rating.isNotBlank()) add(item.rating)
        addAll(item.genres.filter { it.isNotBlank() })
    }
    if (parts.isEmpty()) return
    Text(
        text  = parts.joinToString("  ·  "),
        style = AuroraTypography.Body,
        color = AuroraColors.TextSecondary.copy(alpha = 0.95f),
    )
}

private fun formatRuntime(minutes: Int): String {
    val h = minutes / 60
    val m = minutes % 60
    return if (h > 0) "${h}h ${m}m" else "${m}m"
}

// ─────────────────────────────────────────────────────────────────────────────
// CTA row — Watch (primary) + More info (secondary)
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun HeroCtaRow(
    onWatch: () -> Unit,
    onMoreInfo: () -> Unit,
    watchFocusRequester: FocusRequester? = null,
    upFocusRequester: FocusRequester? = null,
) {
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        // No autoFocus here — the TopNavBar's Home tab grabs initial focus
        // on cold launch (autoFocusActiveTab=true on HomeScreen). Watch is
        // wired with the externally-provided FocusRequester so that DOWN
        // from any nav item lands here in one keypress; UP from either CTA
        // routes back to the active tab so the bar fades in promptly.
        HeroPrimaryButton(
            label                  = "Watch",
            onClick                = onWatch,
            externalFocusRequester = watchFocusRequester,
            upFocusRequester       = upFocusRequester,
        )
        HeroSecondaryButton(
            label            = "More info",
            onClick          = onMoreInfo,
            upFocusRequester = upFocusRequester,
        )
    }
}

/**
 * Primary CTA — gradient-filled, violet shadow on focus, scales 1.04x.
 * Same visual grammar as AuroraPrimaryButton on sign-in. Inlined here
 * rather than extracted because Slice B may expose differences (icons,
 * compact variant); we extract once a real second consumer materializes.
 */
@Composable
private fun HeroPrimaryButton(
    label: String,
    onClick: () -> Unit,
    autoFocus: Boolean = false,
    /**
     * Optional FocusRequester provided by the screen so an external
     * composable (here: TopNavBar's `downFocusRequester`) can route focus
     * directly to this button. When null, falls back to a local requester
     * so autoFocus still works for screens that don't need external routing.
     */
    externalFocusRequester: FocusRequester? = null,
    /** UP-arrow target — typically the active tab in TopNavBar. */
    upFocusRequester: FocusRequester? = null,
) {
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    val localRequester = remember { FocusRequester() }
    val requester = externalFocusRequester ?: localRequester
    if (autoFocus) {
        LaunchedEffect(Unit) { requester.requestFocus() }
    }

    val scale     by animateFloatAsState(
        targetValue = if (focused) 1.04f else 1f,
        label = "hero-primary-scale",
    )
    val elevation by animateDpAsState(
        targetValue = if (focused) 22.dp else 6.dp,
        label = "hero-primary-elevation",
    )

    val fill = if (focused) {
        Brush.linearGradient(0f to AuroraColors.Accent, 1f to AuroraColors.AccentBold)
    } else {
        Brush.linearGradient(0f to AuroraColors.AccentBold, 1f to AuroraColors.AccentDeep)
    }
    val shape = RoundedCornerShape(12.dp)

    Box(
        modifier = Modifier
            .height(48.dp)
            .widthIn(min = 132.dp)
            .graphicsLayer {
                scaleX             = scale
                scaleY             = scale
                shadowElevation    = elevation.toPx()
                this.shape         = shape
                clip               = false
                ambientShadowColor = AuroraColors.Accent
                spotShadowColor    = AuroraColors.Accent
            }
            .background(brush = fill, shape = shape)
            .then(
                if (focused) Modifier.border(
                    width = 1.5.dp,
                    color = Color.White.copy(alpha = 0.55f),
                    shape = shape,
                ) else Modifier
            )
            .focusRequester(requester)
            // Explicit UP routing — pressing UP from this button focuses the
            // active tab in TopNavBar directly, regardless of spatial-search
            // outcomes. Mirror of the bar's `down = watchFocusRequester`.
            .then(
                if (upFocusRequester != null) {
                    Modifier.focusProperties { up = upFocusRequester }
                } else Modifier
            )
            .clickable(
                interactionSource = interaction,
                indication        = null,
                onClick           = onClick,
            )
            .padding(horizontal = 22.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text  = label,
            style = AuroraTypography.Button,
            color = Color.White,
        )
    }
}

/**
 * Secondary CTA — outlined, low-fill. White-tinted shadow on focus
 * (instead of violet) so the eye registers it as "supporting action,"
 * not "alternate primary." Compose lacks a built-in outline-button in
 * the TV material set, so we build it the same way as the primary.
 */
@Composable
private fun HeroSecondaryButton(
    label: String,
    onClick: () -> Unit,
    upFocusRequester: FocusRequester? = null,
) {
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()

    val scale     by animateFloatAsState(
        targetValue = if (focused) 1.04f else 1f,
        label = "hero-secondary-scale",
    )
    val elevation by animateDpAsState(
        targetValue = if (focused) 16.dp else 0.dp,
        label = "hero-secondary-elevation",
    )
    val fillAlpha by animateFloatAsState(
        targetValue = if (focused) 0.18f else 0.08f,
        label = "hero-secondary-fill-alpha",
    )
    val borderAlpha by animateFloatAsState(
        targetValue = if (focused) 0.85f else 0.35f,
        label = "hero-secondary-border-alpha",
    )

    val shape = RoundedCornerShape(12.dp)

    Box(
        modifier = Modifier
            .height(48.dp)
            .widthIn(min = 132.dp)
            .graphicsLayer {
                scaleX             = scale
                scaleY             = scale
                shadowElevation    = elevation.toPx()
                this.shape         = shape
                clip               = false
                ambientShadowColor = Color.White
                spotShadowColor    = Color.White
            }
            .background(
                color = Color.White.copy(alpha = fillAlpha),
                shape = shape,
            )
            .border(
                width = 1.5.dp,
                color = Color.White.copy(alpha = borderAlpha),
                shape = shape,
            )
            // Same UP routing as HeroPrimaryButton — pressing UP focuses the
            // active tab so the bar fades back in regardless of geometry.
            .then(
                if (upFocusRequester != null) {
                    Modifier.focusProperties { up = upFocusRequester }
                } else Modifier
            )
            .clickable(
                interactionSource = interaction,
                indication        = null,
                onClick           = onClick,
            )
            .padding(horizontal = 22.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text  = label,
            style = AuroraTypography.Button,
            color = Color.White,
        )
    }
}
