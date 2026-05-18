package io.aurora.tv.core.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import io.aurora.tv.core.design.AuroraColors

/**
 * Aurora's brand mark: a violet-outlined circle wrapping a right-facing play
 * triangle. Mirrors the SVG favicon baked into static/aurora_pro.html so the
 * TV and web experiences share a unified identity.
 *
 * Rendered as Canvas (not vector drawable) because Canvas scales cleanly to
 * any `size` without asset multipliers, and the shape is simple enough to
 * not warrant a second source of truth.
 */
@Composable
fun AuroraMark(
    modifier: Modifier = Modifier,
    size: Dp = 36.dp,
) {
    Box(modifier = modifier.size(size), contentAlignment = Alignment.Center) {
        Canvas(modifier = Modifier.size(size)) {
            val stroke = 2.5.dp.toPx()
            val radius = (size.toPx() / 2f) - stroke
            val center = Offset(size.toPx() / 2f, size.toPx() / 2f)
            // Outer circle
            drawCircle(
                color  = AuroraColors.Accent,
                radius = radius,
                center = center,
                style  = Stroke(width = stroke),
            )
            // Play triangle — slightly offset right so it looks optically centered
            val triW = radius * 0.80f
            val triH = radius * 0.95f
            val triLeft = center.x - triW * 0.40f
            val triTop  = center.y - triH / 2f
            val path = Path().apply {
                moveTo(triLeft, triTop)
                lineTo(triLeft + triW, center.y)
                lineTo(triLeft, triTop + triH)
                close()
            }
            drawPath(path = path, color = AuroraColors.Accent)
        }
    }
}
