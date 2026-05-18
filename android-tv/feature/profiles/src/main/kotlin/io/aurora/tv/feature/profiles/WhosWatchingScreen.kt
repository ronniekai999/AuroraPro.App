package io.aurora.tv.feature.profiles

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
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
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.tv.material3.Text
import io.aurora.tv.core.design.AuroraColors
import io.aurora.tv.core.design.AuroraDimensions
import io.aurora.tv.core.design.AuroraTypography
import io.aurora.tv.core.ui.PhaseZeroBadge
import io.aurora.tv.core.ui.auroraBackdrop

/**
 * "Who's Watching?" profile picker — the Netflix-style launch screen that
 * Jellyfin users have been asking for for years (discussion #4528).
 *
 * === WHY PROFILE-PICKER-ON-LAUNCH MATTERS ===
 *  - Each profile has its own Continue Watching, watch history, and
 *    parental level. Without a picker, everyone's progress merges.
 *  - Android TV's system-level profile switching doesn't log apps out,
 *    so the profile context must be app-managed.
 *  - Per-profile hiding of restricted content (P2 parental controls)
 *    requires knowing which profile is active before populating home rows.
 *
 * === DESIGN INTENT ===
 * Unlike sign-in, this screen is *about the profiles*, not about the Aurora
 * brand — the user already had the brand moment one screen ago. So we drop
 * the Aurora mark and the kicker; the profiles themselves are the visual
 * hero. We keep the shared aurora backdrop and the Phase-0 badge for
 * cross-screen visual consistency.
 *
 * Focus grammar (P2 "focus is state"):
 *  - 1.08x scale on focus — same factor as poster cards. One grammar across
 *    every focusable surface in the app.
 *  - 3dp violet ring around the avatar on focus. Outside the avatar art so
 *    it doesn't fight the per-profile hue color.
 *  - Shadow tint shifts: unfocused = the profile's own hueColor (subtle
 *    color identity), focused = AuroraColors.Accent (violet). The shift
 *    reinforces "focus is violet" without overwriting profile identity.
 *  - Name below: TextSecondary → TextPrimary on focus. Redundant signal
 *    for which tile is selected — useful when the ring is partly clipped
 *    or contrast is reduced.
 *
 * Phase 0 renders 4 stub avatars. P1 connects to the server's real profile
 * list and persists the 24h re-prompt timestamp.
 */
@Composable
fun WhosWatchingScreen(
    onProfilePicked: (Profile) -> Unit,
    viewModel: ProfileViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    Box(
        modifier = Modifier
            .fillMaxSize()
            .auroraBackdrop(),
    ) {
        PhaseZeroBadge(
            modifier = Modifier
                .align(Alignment.TopEnd)
                .padding(top = 20.dp, end = 24.dp),
        )

        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(
                    horizontal = AuroraDimensions.SafeAreaHorizontal,
                    vertical   = AuroraDimensions.SafeAreaVertical,
                ),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            // Heading — inline 48sp instead of AuroraTypography.HeroTitle (72sp,
            // which dominates this comparatively sparse screen). Negative
            // letter-spacing is the same -0.02em we use across the app's display
            // type so headlines feel cohesive.
            Text(
                text  = "Who's watching?",
                style = TextStyle(
                    fontSize      = 48.sp,
                    fontWeight    = FontWeight.Bold,
                    letterSpacing = (-0.02).em,
                ),
                color = AuroraColors.TextPrimary,
            )

            Spacer(Modifier.height(48.dp))

            // Branch on UiState — Loading shows a small centered spinner,
            // Error shows the message + retry, Loaded renders the existing
            // profile-grid layout. The header above stays anchored across
            // all three so the screen's vertical rhythm is consistent.
            when (val s = state) {
                ProfileViewModel.UiState.Loading -> {
                    AuroraSpinner(size = 48.dp, strokeWidth = 4.dp)
                }
                is ProfileViewModel.UiState.Error -> {
                    ErrorBlock(
                        message  = s.message,
                        canRetry = s.canRetry,
                        onRetry  = viewModel::retry,
                    )
                }
                is ProfileViewModel.UiState.Loaded -> {
                    Row(horizontalArrangement = Arrangement.spacedBy(36.dp)) {
                        s.profiles.forEachIndexed { index, profile ->
                            ProfileTile(
                                profile   = profile,
                                autoFocus = index == 0,
                                onClick   = {
                                    viewModel.onProfileSelected(profile) {
                                        onProfilePicked(profile)
                                    }
                                },
                            )
                        }
                    }
                }
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Loading + error affordances — small, screen-local. Modeled on MoviesScreen's
// equivalents but inlined here to avoid a cross-feature shared-widgets module
// for two short composables.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Indeterminate spinner — violet arc rotating clockwise. Matches the shape
 * and motion of [io.aurora.tv.feature.movies.MoviesScreen]'s spinner so the
 * loading affordance feels consistent across screens; kept local rather
 * than extracted because the picker is the only other current consumer.
 */
@Composable
private fun AuroraSpinner(
    size: Dp = 48.dp,
    strokeWidth: Dp = 4.dp,
) {
    val transition = rememberInfiniteTransition(label = "profile-picker-spinner")
    val angle by transition.animateFloat(
        initialValue  = 0f,
        targetValue   = 360f,
        animationSpec = infiniteRepeatable(
            animation  = tween(durationMillis = 900, easing = LinearEasing),
            repeatMode = RepeatMode.Restart,
        ),
        label = "profile-picker-spinner-angle",
    )
    Canvas(
        modifier = Modifier
            .size(size)
            .rotate(angle),
    ) {
        val strokePx = strokeWidth.toPx()
        val inset    = strokePx / 2f
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

/**
 * Error block — centered message with an optional Retry CTA. `canRetry =
 * false` is reserved for terminal errors (e.g. NotSignedIn) where retrying
 * the same fetch can't recover. Auto-focuses the retry button when shown
 * so the remote's center-press can recover without an extra D-pad nudge.
 */
@Composable
private fun ErrorBlock(
    message: String,
    canRetry: Boolean,
    onRetry: () -> Unit,
) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = Modifier.padding(horizontal = 24.dp),
    ) {
        Text(
            text  = message,
            style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.Medium),
            color = AuroraColors.TextPrimary,
        )
        if (canRetry) {
            Spacer(Modifier.height(20.dp))
            RetryButton(onClick = onRetry)
        }
    }
}

/**
 * Focusable retry CTA. Same focus grammar as the rest of the app: subtle
 * accent border + soft fill on focus, label color shifts to TextPrimary.
 */
@Composable
private fun RetryButton(onClick: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    val requester = remember { FocusRequester() }
    LaunchedEffect(Unit) { requester.requestFocus() }

    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(8.dp))
            .background(if (focused) AuroraColors.Accent.copy(alpha = 0.18f) else Color.Transparent)
            .border(
                width = 1.dp,
                color = if (focused) AuroraColors.Accent else AuroraColors.Divider,
                shape = RoundedCornerShape(8.dp),
            )
            .focusRequester(requester)
            .clickable(
                interactionSource = interaction,
                indication        = null,
                onClick           = onClick,
            )
            .padding(horizontal = 18.dp, vertical = 10.dp),
    ) {
        Text(
            text  = "Retry",
            style = TextStyle(
                fontSize   = 15.sp,
                fontWeight = FontWeight.Medium,
                textAlign  = TextAlign.Center,
            ),
            color = if (focused) AuroraColors.TextPrimary else AuroraColors.TextSecondary,
        )
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Profile tile — circular avatar with focus-as-state polish
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun ProfileTile(
    profile: Profile,
    autoFocus: Boolean = false,
    onClick: () -> Unit,
) {
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    val requester = remember { FocusRequester() }

    if (autoFocus) {
        LaunchedEffect(Unit) { requester.requestFocus() }
    }

    // Per-profile identity color — HSV so the saturation/value stay constant
    // across profiles regardless of hue. accentHue is the only varying axis.
    // hueDeep is the same hue at lower V — used as the gradient's middle stop
    // so the orb is fully opaque end-to-end. (Previously the middle stop had
    // alpha=0.35, which let the platform shadow's polygon approximation —
    // Android rasterizes circle shadows as 16-gons for performance — bleed
    // through the orb as a visible dark octagon. Opaque mid stop fixes that.)
    val hueColor = Color.hsv(
        hue        = profile.accentHue.toFloat(),
        saturation = 0.55f,
        value      = 0.85f,
    )
    val hueDeep = Color.hsv(
        hue        = profile.accentHue.toFloat(),
        saturation = 0.55f,
        value      = 0.30f,
    )

    // Focus animations — 120ms tween across all three. Same duration as the
    // FocusableCard primitive so cross-screen focus moves feel uniform.
    val scale by animateFloatAsState(
        targetValue = if (focused) AuroraDimensions.FocusScaleFactor else 1f,
        label = "tile-scale",
    )
    val ringWidth by animateDpAsState(
        targetValue = if (focused) 3.dp else 0.dp,
        label = "tile-ring-width",
    )
    val elevation by animateDpAsState(
        targetValue = if (focused) 22.dp else 6.dp,
        label = "tile-elevation",
    )
    // Shadow color shifts from per-profile hue (unfocused, subtle) to violet
    // (focused, brand-consistent). Color tween is the smooth way to do this;
    // a hard switch would feel snappy in a way that fights the scale lerp.
    val shadowTint by animateColorAsState(
        targetValue = if (focused) AuroraColors.Accent else hueColor,
        label = "tile-shadow-tint",
    )
    val nameColor by animateColorAsState(
        targetValue = if (focused) AuroraColors.TextPrimary else AuroraColors.TextSecondary,
        label = "tile-name-color",
    )

    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Box(
            modifier = Modifier
                .size(160.dp)
                .graphicsLayer {
                    scaleX             = scale
                    scaleY             = scale
                    shadowElevation    = elevation.toPx()
                    shape              = CircleShape
                    clip               = false                 // let shadow bleed past the circle
                    ambientShadowColor = shadowTint
                    spotShadowColor    = shadowTint
                }
                .clip(CircleShape)
                // Radial gradient: saturated hue at center → darker opaque
                // hue mid → BgCard at edge. All stops are fully opaque so
                // the platform shadow stays where it belongs (behind, never
                // bleeding through into the orb interior).
                .background(
                    brush = Brush.radialGradient(
                        colors = listOf(
                            hueColor,
                            hueDeep,
                            AuroraColors.BgCard,
                        ),
                    ),
                )
                .border(
                    width = ringWidth,
                    color = AuroraColors.Accent,
                    shape = CircleShape,
                )
                .focusRequester(requester)
                .clickable(
                    interactionSource = interaction,
                    indication        = null,            // scale + ring + shadow IS the indication
                    onClick           = onClick,
                ),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text  = profile.displayName.take(1).uppercase(),
                style = TextStyle(
                    fontSize   = 56.sp,
                    fontWeight = FontWeight.Bold,
                ),
                color = AuroraColors.TextPrimary,
            )
        }

        Spacer(Modifier.height(14.dp))

        Text(
            text  = profile.displayName,
            style = AuroraTypography.RowTitle,
            color = nameColor,
        )

        if (profile.isKidProfile) {
            Spacer(Modifier.height(6.dp))
            KidsBadge()
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// "KIDS" pill — distinct amber palette so parents spot it from across the room
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun KidsBadge() {
    // Amber #FBBF24 deliberately chosen instead of violet — kid-profile
    // signaling shouldn't share the brand color (which is also our focus
    // color). Different hue = different semantic role at a glance.
    val amber = Color(0xFFFBBF24)
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .clip(RoundedCornerShape(999.dp))
            .background(amber.copy(alpha = 0.18f))
            .border(
                width = 1.dp,
                color = amber.copy(alpha = 0.45f),
                shape = RoundedCornerShape(999.dp),
            )
            .padding(horizontal = 10.dp, vertical = 4.dp),
    ) {
        Box(
            Modifier
                .size(6.dp)
                .clip(CircleShape)
                .background(amber),
        )
        Spacer(Modifier.width(6.dp))
        Text(
            text  = "KIDS",
            style = AuroraTypography.Caption,
            color = amber,
        )
    }
}
