package io.aurora.tv.core.ui

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.scale
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import io.aurora.tv.core.design.AuroraColors
import io.aurora.tv.core.design.AuroraDimensions

/**
 * Primitive focusable card used by every row across the TV app.
 *
 * Rationale (directly addresses research findings):
 *  - Focus-as-state: we expose `focused` as a local state flag rather than
 *    mutating view tree; in Compose-for-TV, onFocusChanged fires cleanly
 *    and doesn't interact with playback-key dispatch. This avoids the
 *    Jellyfin class of bug where D-pad events in one subtree accidentally
 *    drive media playback (jellyfin-androidtv#1391).
 *  - Visible-focus latency: animateFloatAsState with tween 120ms gives the
 *    scale change sub-frame visibility on modern TVs while still feeling
 *    kinetic rather than snappy-jittery.
 *  - Elevation + border are both applied so focus is legible regardless of
 *    background (a plain ring is hard to see against a dark backdrop).
 */
@Composable
fun FocusableCard(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    onFocusChanged: (Boolean) -> Unit = {},
    content: @Composable (focused: Boolean) -> Unit,
) {
    var focused by remember { mutableStateOf(false) }
    val scale by animateFloatAsState(
        targetValue = if (focused) AuroraDimensions.FocusScaleFactor else 1f,
        animationSpec = tween(durationMillis = 120),
        label = "focus-scale",
    )

    val interactionSource = remember { MutableInteractionSource() }
    val shape = RoundedCornerShape(10.dp)

    Box(
        modifier = modifier
            .scale(scale)
            .shadow(
                elevation = if (focused) 16.dp else 0.dp,
                shape = shape,
                ambientColor = AuroraColors.AccentGlow,
                spotColor    = AuroraColors.AccentGlow,
            )
            .background(AuroraColors.BgCard, shape)
            .border(
                width = if (focused) AuroraDimensions.FocusRingWidth else 0.dp,
                color = if (focused) AuroraColors.Accent else Color.Transparent,
                shape = shape,
            )
            .onFocusChanged {
                focused = it.isFocused
                onFocusChanged(it.isFocused)
            }
            // NOTE: no separate `.focusable(...)` here. `Modifier.clickable`
            // is already focusable internally, and stacking an explicit
            // `.focusable()` above it creates TWO focus targets — the outer
            // one wins focus but doesn't translate D-pad SELECT into a
            // click, so SELECT silently no-ops on every poster. The shared
            // interactionSource still drives focus state via the clickable
            // node, and `onFocusChanged` above observes it without needing
            // an explicit focusable modifier.
            .clickable(interactionSource = interactionSource, indication = null) { onClick() },
    ) {
        content(focused)
    }
}
