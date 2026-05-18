package io.aurora.tv.core.ui

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Text
import io.aurora.tv.core.design.AuroraColors
import io.aurora.tv.core.design.AuroraTypography

/**
 * Phase-0 "offline preview" corner badge with a breathing dot.
 *
 * Purpose: a visible label on every phase-0 screen so users know auth /
 * data is stubbed. Removed in P1 once real backend wiring lands — this
 * file should be deleted with that ticket, not just unreferenced.
 *
 * The dot alpha pulses 0.4 ↔ 1.0 on a 1800ms RepeatMode.Reverse tween
 * (3.6s full cycle) — deliberately slow, so it reads as a heartbeat
 * rather than an error blink. Alpha is applied to the Color directly
 * (not via graphicsLayer.alpha) so the render stays in a single draw
 * pass — no layer allocation per frame.
 */
@Composable
fun PhaseZeroBadge(modifier: Modifier = Modifier) {
    val transition = rememberInfiniteTransition(label = "phase0-pulse")
    val dotAlpha by transition.animateFloat(
        initialValue  = 0.4f,
        targetValue   = 1.0f,
        animationSpec = infiniteRepeatable(
            animation  = tween(durationMillis = 1800),
            repeatMode = RepeatMode.Reverse,
        ),
        label = "phase0-dot-alpha",
    )

    Row(
        modifier = modifier
            .clip(RoundedCornerShape(999.dp))
            .background(AuroraColors.AccentSoft)
            .border(
                width = 1.dp,
                color = AuroraColors.Accent.copy(alpha = 0.35f),
                shape = RoundedCornerShape(999.dp),
            )
            .padding(horizontal = 14.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(8.dp)
                .clip(CircleShape)
                .background(AuroraColors.Accent.copy(alpha = dotAlpha)),
        )
        Spacer(Modifier.width(8.dp))
        Text(
            text  = "Phase 0 · offline preview",
            style = AuroraTypography.Caption,
            color = AuroraColors.Accent,
        )
    }
}
