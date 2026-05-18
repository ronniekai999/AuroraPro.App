package io.aurora.tv.feature.detail.ui

import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.outlined.BookmarkBorder
import androidx.compose.material.icons.outlined.Groups
import androidx.compose.material.icons.outlined.PlayCircle
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
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
import io.aurora.tv.feature.detail.data.MediaVariant

/**
 * Detail-screen hero — single-focus showcase for one item, designed to
 * match the Aurora web app's detail page.
 *
 * === LAYOUT (back to front) ===
 *  1. Backdrop image — SubcomposeAsyncImage filling the full hero band.
 *     Loading and error fall back to the same accentHue gradient that
 *     PosterCard uses, so cold-network state is graceful, not broken.
 *  2. Bottom scrim — vertical gradient fading to BgPrimary so text reads
 *     against any underlying photo and the hero blends cleanly into the
 *     cast strip beneath it.
 *  3. Content row, anchored to the bottom of the hero band:
 *       [ Poster (220×330dp) ]   [ Content column (flex-fill):
 *                                    Title (56sp bold)
 *                                    ★ rating · year · runtime · cert · genre badges
 *                                    Description (4 lines, BodyLarge)
 *                                    [ Play | In My Library | Mark Watched
 *                                      | Resume at Xm | Watch Party ]
 *                                    [ Refresh | 4K + size + codecs
 *                                              | 1080p + size + codecs ]
 *                                 ]
 *
 * === FILL THE VIEWPORT ===
 * Hero takes its size from the modifier passed in (the screen passes
 * `fillParentMaxHeight()`). That's how the backdrop reads as cinematic
 * full-bleed rather than a 400dp band — same trick Apple TV+ uses on
 * its detail surfaces.
 *
 * === FOCUS ENTRY ===
 * Watch (the primary CTA) auto-focuses on first composition so the
 * detail screen lands on its primary action. UP from there reaches
 * the top nav via Compose's spatial focus search; the layout is flat
 * enough on detail that explicit `focusProperties { up = ... }` routing
 * isn't required.
 */
@Composable
fun DetailHero(
    item: MediaItem,
    starRating: Float,
    variants: List<MediaVariant>,
    onWatch: () -> Unit,
    onAddToList: () -> Unit,
    onMarkWatched: () -> Unit,
    onResume: () -> Unit,
    onWatchParty: () -> Unit,
    onRefresh: () -> Unit,
    modifier: Modifier = Modifier,
    /**
     * Optional FocusRequester attached to the Watch (Play) button. The
     * detail screen passes one in and ALSO hands it to the TopNavBar as
     * `downFocusRequester` — DOWN on any nav item routes here.
     */
    watchFocusRequester: FocusRequester? = null,
    /**
     * Optional FocusRequester to redirect UP-arrow on the Play button.
     * Symmetric to `watchFocusRequester` — the detail screen passes its
     * `activeTabFocusRequester` here so UP from Play returns to the
     * bar's active tab regardless of geometry.
     */
    upFocusRequester: FocusRequester? = null,
) {
    val backdropTop = Color.hsv(item.accentHue.toFloat(), 0.55f, 0.55f)
    val backdropMid = Color.hsv(item.accentHue.toFloat(), 0.55f, 0.30f)
    val fallbackBackdrop = Brush.linearGradient(
        colors = listOf(backdropTop, backdropMid, AuroraColors.BgPrimary),
        start  = Offset(0f, 0f),
        end    = Offset.Infinite,
    )

    Box(modifier = modifier.fillMaxWidth()) {
        // Layer 1: backdrop artwork
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

        // Layer 2: top + bottom scrim. Top scrim ensures text legibility
        // for the title block; bottom scrim feathers the hero into the
        // BgPrimary that the cast strip renders on.
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(
                    Brush.verticalGradient(
                        0f    to AuroraColors.BgPrimary.copy(alpha = 0.55f),
                        0.35f to AuroraColors.BgPrimary.copy(alpha = 0.30f),
                        0.65f to AuroraColors.BgPrimary.copy(alpha = 0.55f),
                        1f    to AuroraColors.BgPrimary,
                    ),
                ),
        )

        // Layer 3: content row, pushed down 60dp via Modifier.offset.
        //
        // Why offset NOW when it didn't seem to work in earlier rounds:
        // in those rounds, contentPadding was animating between 0/64
        // based on barVisible, and the screenshots that looked "broken"
        // were captured in barVisible=false state where contentPadding=0.
        // Offset WAS being applied; the hero was just at viewport y=0
        // instead of y=64. Now contentPadding is fixed at 64, so the
        // hero is reliably at y=64, and the offset puts content at
        // viewport y=124 — clear of the bar with 60dp breathing room.
        //
        // Visual win: the backdrop image fills the hero from y=64
        // (immediately below the bar) all the way down — no dark stripe
        // between bar and content. Bar visually matches home's bar.
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .offset(y = 60.dp)
                .padding(horizontal = AuroraDimensions.SafeAreaHorizontal),
            verticalAlignment = Alignment.Top,
        ) {
            HeroPoster(item)
            Spacer(Modifier.width(40.dp))
            HeroContentColumn(
                item                = item,
                starRating          = starRating,
                variants            = variants,
                onWatch             = onWatch,
                onAddToList         = onAddToList,
                onMarkWatched       = onMarkWatched,
                onResume            = onResume,
                onWatchParty        = onWatchParty,
                onRefresh           = onRefresh,
                watchFocusRequester = watchFocusRequester,
                upFocusRequester    = upFocusRequester,
                modifier            = Modifier.weight(1f),
            )
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Hero poster — large 2:3 image on the left of the hero
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun HeroPoster(item: MediaItem) {
    val hueColor = Color.hsv(item.accentHue.toFloat(), 0.55f, 0.85f)
    val hueDeep  = Color.hsv(item.accentHue.toFloat(), 0.55f, 0.30f)
    val fallback = Brush.linearGradient(
        colors = listOf(hueColor, hueDeep),
        start  = Offset(0f, 0f),
        end    = Offset.Infinite,
    )
    val shape = RoundedCornerShape(12.dp)
    Box(
        modifier = Modifier
            .size(width = 220.dp, height = 330.dp)
            // Drop shadow matches the web app's elevated-poster look — gives
            // the artwork a discrete "object on a backdrop" feel rather than
            // looking flat-pasted onto the gradient. graphicsLayer used so
            // we can keep clip = false and let the shadow bleed past the
            // poster's bounds; pure black tint (no color) for understated
            // depth.
            .graphicsLayer {
                shadowElevation    = 16.dp.toPx()
                this.shape         = shape
                clip               = false
                ambientShadowColor = Color.Black
                spotShadowColor    = Color.Black
            }
            .clip(shape)
            .background(brush = fallback, shape = shape),
    ) {
        SubcomposeAsyncImage(
            model              = item.posterUrl,
            contentDescription = "${item.title} poster",
            contentScale       = ContentScale.Crop,
            modifier           = Modifier.fillMaxSize(),
            loading = { Box(modifier = Modifier.fillMaxSize().background(fallback)) },
            error   = { Box(modifier = Modifier.fillMaxSize().background(fallback)) },
        )
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Content column — title, meta, description, CTAs, refresh+variants
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun HeroContentColumn(
    item: MediaItem,
    starRating: Float,
    variants: List<MediaVariant>,
    onWatch: () -> Unit,
    onAddToList: () -> Unit,
    onMarkWatched: () -> Unit,
    onResume: () -> Unit,
    onWatchParty: () -> Unit,
    onRefresh: () -> Unit,
    modifier: Modifier = Modifier,
    watchFocusRequester: FocusRequester? = null,
    upFocusRequester: FocusRequester? = null,
) {
    Column(
        modifier            = modifier,
        // Top-arranged so the title is at the top of the column. Combined
        // with the outer Row's Alignment.Top, content (title → meta →
        // description → CTAs → bottom-row) stacks downward from the upper
        // edge of the hero. This is what gives the screen the "content
        // dropped into place at the top" feel the web app has.
        verticalArrangement = Arrangement.Top,
    ) {
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

        Spacer(Modifier.height(10.dp))
        HeroMetaRow(item = item, starRating = starRating)

        Spacer(Modifier.height(14.dp))
        Text(
            text     = item.description,
            style    = AuroraTypography.BodyLarge,
            color    = AuroraColors.TextSecondary,
            maxLines = 4,
            overflow = TextOverflow.Ellipsis,
        )

        Spacer(Modifier.height(20.dp))
        HeroCtaRow(
            onWatch             = onWatch,
            onAddToList         = onAddToList,
            onMarkWatched       = onMarkWatched,
            onResume            = onResume,
            onWatchParty        = onWatchParty,
            watchFocusRequester = watchFocusRequester,
            upFocusRequester    = upFocusRequester,
        )

        Spacer(Modifier.height(12.dp))
        HeroBottomRow(
            variants  = variants,
            onRefresh = onRefresh,
        )
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Meta row — ★ rating · year · runtime · cert · genre badges
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun HeroMetaRow(item: MediaItem, starRating: Float) {
    Row(
        verticalAlignment     = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        // ★ 7.4 — yellow star + bold rating
        Row(verticalAlignment = Alignment.CenterVertically) {
            Image(
                imageVector        = Icons.Filled.Star,
                contentDescription = null,
                colorFilter        = ColorFilter.tint(Color(0xFFFBBF24)),
                modifier           = Modifier.size(18.dp),
            )
            Spacer(Modifier.width(6.dp))
            Text(
                text  = "%.1f".format(starRating),
                style = TextStyle(
                    fontSize   = 16.sp,
                    fontWeight = FontWeight.SemiBold,
                ),
                color = AuroraColors.TextPrimary,
            )
        }

        DotSeparator()
        MetaText(item.year.toString())

        DotSeparator()
        MetaText(formatRuntime(item.runtimeMinutes))

        DotSeparator()
        MetaText(item.rating)

        // Genre badges — pills with subtle dark background
        item.genres.forEach { genre ->
            GenreBadge(label = genre)
        }
    }
}

@Composable
private fun MetaText(text: String) {
    Text(
        text  = text,
        style = AuroraTypography.Body,
        color = AuroraColors.TextSecondary,
    )
}

@Composable
private fun DotSeparator() {
    Text(
        text  = "·",
        style = AuroraTypography.Body,
        color = AuroraColors.TextMuted,
    )
}

@Composable
private fun GenreBadge(label: String) {
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(6.dp))
            .background(AuroraColors.BgCard)
            .padding(horizontal = 10.dp, vertical = 4.dp),
    ) {
        Text(
            text  = label,
            style = TextStyle(
                fontSize   = 13.sp,
                fontWeight = FontWeight.Medium,
            ),
            color = AuroraColors.TextSecondary,
        )
    }
}

private fun formatRuntime(minutes: Int): String {
    val h = minutes / 60
    val m = minutes % 60
    return if (h > 0) "${h}h ${m}m" else "${m}m"
}

// ─────────────────────────────────────────────────────────────────────────────
// CTA row — five buttons: Play (primary) + 4 secondary
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Five CTA buttons in a FlowRow so they wrap to a second row when the
 * content-column width can't fit all five at their natural sizes. Web
 * has more horizontal room than TV (1920+ vs 960 dp viewport) — the
 * CTA list that single-rows on web naturally needs to wrap on TV. The
 * D-pad still navigates left/right within the same visual row, then up/
 * down to traverse rows, so the focus story stays clean.
 */
@Composable
private fun HeroCtaRow(
    onWatch: () -> Unit,
    onAddToList: () -> Unit,
    onMarkWatched: () -> Unit,
    onResume: () -> Unit,
    onWatchParty: () -> Unit,
    watchFocusRequester: FocusRequester? = null,
    upFocusRequester: FocusRequester? = null,
) {
    FlowRow(
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalArrangement   = Arrangement.spacedBy(8.dp),
    ) {
        DetailPrimaryButton(
            label                  = "Play",
            icon                   = Icons.Filled.PlayArrow,
            onClick                = onWatch,
            // No autoFocus — bar's autoFocusActiveTab takes initial focus.
            // The detail screen's bar is wired with this same Watch
            // FocusRequester as its `down` target, so DOWN from any tab
            // routes here directly. UP from here routes to the active tab.
            externalFocusRequester = watchFocusRequester,
            upFocusRequester       = upFocusRequester,
        )
        DetailSecondaryButton(
            label   = "In My Library",
            icon    = Icons.Outlined.BookmarkBorder,
            onClick = onAddToList,
        )
        DetailSecondaryButton(
            label   = "Mark Watched",
            icon    = Icons.Outlined.Visibility,
            onClick = onMarkWatched,
        )
        DetailSecondaryButton(
            label   = "Resume at 36m",
            icon    = Icons.Outlined.PlayCircle,
            onClick = onResume,
        )
        DetailSecondaryButton(
            label   = "Watch Party",
            icon    = Icons.Outlined.Groups,
            onClick = onWatchParty,
        )
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Bottom row — refresh button + resolution variant badges
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun HeroBottomRow(
    variants: List<MediaVariant>,
    onRefresh: () -> Unit,
) {
    Row(
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment     = Alignment.CenterVertically,
    ) {
        RefreshButton(onClick = onRefresh)
        variants.forEach { variant ->
            VariantBadge(variant)
        }
    }
}

@Composable
private fun RefreshButton(onClick: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    val borderAlpha by animateFloatAsState(
        targetValue = if (focused) 0.85f else 0.30f,
        label = "refresh-border",
    )
    Row(
        modifier = Modifier
            .clip(RoundedCornerShape(10.dp))
            .background(AuroraColors.BgCard.copy(alpha = if (focused) 0.95f else 0.75f))
            .border(
                width = 1.dp,
                // Bumped baseline alpha 0.30 → 0.45 so the pill border is
                // legible against the hero backdrop overlay. The previous
                // value disappeared on busy / dark-toned backdrops.
                color = Color.White.copy(alpha = if (focused) 0.85f else 0.45f),
                shape = RoundedCornerShape(10.dp),
            )
            .clickable(
                interactionSource = interaction,
                indication        = null,
                onClick           = onClick,
            )
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment     = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Image(
            imageVector        = Icons.Outlined.Refresh,
            contentDescription = "Refresh metadata",
            // Was TextSecondary — promoted to TextPrimary so the icon is
            // reliably visible against any backdrop. Same rationale as
            // the text below.
            colorFilter        = ColorFilter.tint(AuroraColors.TextPrimary),
            modifier           = Modifier.size(16.dp),
        )
        Text(
            text  = "Refresh",
            style = TextStyle(
                fontSize   = 14.sp,
                fontWeight = FontWeight.Medium,
            ),
            // TextSecondary on top of the backdrop overlay was washing
            // out — the pill read as empty in screenshots. TextPrimary
            // is white and reliably readable.
            color = AuroraColors.TextPrimary,
        )
    }
}

/**
 * Resolution variant badge: e.g. "4K [4K Movies]" with secondary line
 * "18.1 GB · hevc/truehd". Preferred variant gets a violet accent border;
 * non-preferred renders flat. Non-focusable — informational chrome.
 */
@Composable
private fun VariantBadge(variant: MediaVariant) {
    Column(
        modifier = Modifier
            .clip(RoundedCornerShape(10.dp))
            // Bumped background opacity for stronger contrast against the
            // hero backdrop. Was 0.65; the badge was washing out on
            // dark/busy backdrops.
            .background(AuroraColors.BgCard.copy(alpha = 0.85f))
            .border(
                width = 1.dp,
                color = if (variant.isPreferred)
                    AuroraColors.Accent.copy(alpha = 0.85f)  // was 0.55 — more visible
                else
                    Color.White.copy(alpha = 0.30f),         // was 0.10 — visible at TV distance
                shape = RoundedCornerShape(10.dp),
            )
            .padding(horizontal = 14.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                modifier = Modifier
                    .clip(RoundedCornerShape(4.dp))
                    .background(
                        if (variant.isPreferred) AuroraColors.AccentBold
                        else AuroraColors.BgCard,
                    )
                    .padding(horizontal = 8.dp, vertical = 3.dp),
            ) {
                Text(
                    text  = variant.label,
                    style = TextStyle(
                        // 11sp → 13sp. Readable at TV viewing distance
                        // (8-10ft on a 55"+ screen) without dominating
                        // the hero's primary chrome.
                        fontSize   = 13.sp,
                        fontWeight = FontWeight.Bold,
                    ),
                    color = AuroraColors.TextPrimary,
                )
            }
            Spacer(Modifier.width(10.dp))
            Text(
                text  = variant.tag,
                style = TextStyle(
                    fontSize   = 14.sp,    // 12sp → 14sp
                    fontWeight = FontWeight.Medium,
                ),
                // TextSecondary was washing out on busy backdrops.
                // TextPrimary is more legible; the size hierarchy
                // (smaller than CTA text) still makes it read as
                // secondary chrome.
                color = AuroraColors.TextPrimary,
            )
        }
        // Second line is the size + codec summary. Skip entirely when
        // both are missing — produced "0.0 GB · " for sparse-data files
        // before this guard, which read as broken UI rather than absent
        // data. Building the line piecewise lets us render half if only
        // one field is present.
        val sizeText  = if (variant.sizeBytes > 0) formatGigabytes(variant.sizeBytes) else ""
        val codecText = variant.codecLabel
        val secondLine = listOf(sizeText, codecText).filter { it.isNotBlank() }.joinToString(" · ")
        if (secondLine.isNotBlank()) {
            Text(
                text  = secondLine,
                style = TextStyle(fontSize = 12.sp),  // 11sp → 12sp
                // TextMuted was nearly invisible on dark backdrops.
                // TextSecondary is more legible while still reading as
                // tertiary information beneath the primary label.
                color = AuroraColors.TextSecondary,
            )
        }
    }
}

private fun formatGigabytes(bytes: Long): String {
    val gb = bytes / 1024.0 / 1024.0 / 1024.0
    return "%.1f GB".format(gb)
}

// ─────────────────────────────────────────────────────────────────────────────
// Buttons
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun DetailPrimaryButton(
    label: String,
    icon: ImageVector,
    onClick: () -> Unit,
    autoFocus: Boolean = false,
    /**
     * Optional FocusRequester provided by the screen so the TopNavBar's
     * `down` target can route focus here directly. Falls back to a local
     * requester when null.
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

    val scale by animateFloatAsState(
        targetValue = if (focused) 1.04f else 1f,
        label = "detail-primary-scale",
    )
    val elevation by animateDpAsState(
        targetValue = if (focused) 22.dp else 6.dp,
        label = "detail-primary-elevation",
    )

    val fill = if (focused) {
        Brush.linearGradient(0f to AuroraColors.Accent, 1f to AuroraColors.AccentBold)
    } else {
        Brush.linearGradient(0f to AuroraColors.AccentBold, 1f to AuroraColors.AccentDeep)
    }
    val shape = RoundedCornerShape(12.dp)

    Box(
        modifier = Modifier
            .height(46.dp)
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
            // Explicit UP routing — pressing UP from this button focuses
            // the active tab in the TopNavBar directly, regardless of
            // spatial-search outcomes. Without this, focus might land
            // anywhere in the bar (or fail), and `focusGroup()` on the
            // bar would then trap the user. Mirror of HomeHero's setup.
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
            .padding(horizontal = 16.dp),
        contentAlignment = Alignment.Center,
    ) {
        Row(
            verticalAlignment     = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Image(
                imageVector        = icon,
                contentDescription = null,
                colorFilter        = ColorFilter.tint(Color.White),
                modifier           = Modifier.size(18.dp),
            )
            Text(
                text     = label,
                style    = AuroraTypography.Button,
                color    = Color.White,
                maxLines = 1,
                softWrap = false,
            )
        }
    }
}

@Composable
private fun DetailSecondaryButton(
    label: String,
    icon: ImageVector,
    onClick: () -> Unit,
) {
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()

    val scale       by animateFloatAsState(
        targetValue = if (focused) 1.04f else 1f,
        label = "detail-secondary-scale",
    )
    val elevation   by animateDpAsState(
        targetValue = if (focused) 16.dp else 0.dp,
        label = "detail-secondary-elevation",
    )
    val fillAlpha   by animateFloatAsState(
        targetValue = if (focused) 0.18f else 0.08f,
        label = "detail-secondary-fill-alpha",
    )
    val borderAlpha by animateFloatAsState(
        targetValue = if (focused) 0.85f else 0.30f,
        label = "detail-secondary-border-alpha",
    )

    val shape = RoundedCornerShape(12.dp)

    Box(
        modifier = Modifier
            .height(46.dp)
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
            .clickable(
                interactionSource = interaction,
                indication        = null,
                onClick           = onClick,
            )
            .padding(horizontal = 14.dp),
        contentAlignment = Alignment.Center,
    ) {
        Row(
            verticalAlignment     = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Image(
                imageVector        = icon,
                contentDescription = null,
                colorFilter        = ColorFilter.tint(Color.White),
                modifier           = Modifier.size(16.dp),
            )
            Text(
                text     = label,
                style    = TextStyle(
                    fontSize   = 14.sp,
                    fontWeight = FontWeight.SemiBold,
                ),
                color    = Color.White,
                maxLines = 1,
                softWrap = false,
            )
        }
    }
}
