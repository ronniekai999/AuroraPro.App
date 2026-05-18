package io.aurora.tv.core.ui

import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import io.aurora.tv.core.design.AuroraColors

/**
 * Shared "aurora" backdrop — vertical gradient base with painted radial
 * glows evoking the actual aurora phenomenon. Use on every full-screen
 * Phase-0 surface (sign-in, profile picker, settings modal) so the app
 * reads as one visual composition even as screens change.
 *
 * === IMPLEMENTATION NOTES ===
 *  - `drawBehind` is zero-allocation per recomposition — the brushes are
 *    built inside the draw scope, not captured at composition time.
 *  - No blur shader. Low-end Android TV hardware (older Chromecasts, some
 *    smart-TV firmwares) rasterizes Compose blurs on the CPU, which
 *    stutters during focus animations. Painted radial gradients give us
 *    similar perceived depth at essentially zero GPU cost.
 *  - Violet top-left + teal bottom-right is the aurora-borealis color nod.
 *    The mid-right violet pulse happens to halo the sign-in form column;
 *    harmless on centered layouts — it's a broad, soft gradient that reads
 *    as "the screen itself is glowing" rather than a positional spotlight.
 */
fun Modifier.auroraBackdrop(): Modifier = this.drawBehind {
    // Base: vertical gradient BgPrimary → BgSecondary → BgPrimary.
    drawRect(
        brush = Brush.verticalGradient(
            0f    to AuroraColors.BgPrimary,
            0.55f to AuroraColors.BgSecondary,
            1f    to AuroraColors.BgPrimary,
        ),
        size = size,
    )

    // Violet ribbon — large, off-screen top-left so only the falloff shows.
    drawRect(
        brush = Brush.radialGradient(
            0f   to AuroraColors.Accent.copy(alpha = 0.35f),
            0.4f to AuroraColors.AccentDeep.copy(alpha = 0.18f),
            1f   to Color.Transparent,
            center = Offset(x = size.width * 0.15f, y = size.height * 0.18f),
            radius = size.maxDimension * 0.55f,
        ),
        size = size,
    )

    // Teal aurora hint — bottom-right, subtler, color-mixes with violet.
    drawRect(
        brush = Brush.radialGradient(
            0f   to Color(0xFF14B8A6).copy(alpha = 0.22f),
            0.5f to Color(0xFF0891B2).copy(alpha = 0.10f),
            1f   to Color.Transparent,
            center = Offset(x = size.width * 0.92f, y = size.height * 0.85f),
            radius = size.maxDimension * 0.45f,
        ),
        size = size,
    )

    // Mid-right violet pulse — halos right-aligned form content on sign-in.
    // Broad enough to read as ambient warmth on centered layouts too.
    drawRect(
        brush = Brush.radialGradient(
            0f to AuroraColors.AccentBold.copy(alpha = 0.14f),
            1f to Color.Transparent,
            center = Offset(x = size.width * 0.72f, y = size.height * 0.50f),
            radius = size.maxDimension * 0.30f,
        ),
        size = size,
    )
}
