package io.aurora.tv.core.ui

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import io.aurora.tv.core.design.AuroraColors

/**
 * Shimmer placeholder for poster cards.
 *
 * Directly addresses research finding P1 — Plex's "1 minute home screen"
 * regression is partly perception: when cards render empty dark rectangles
 * during fetch, users read it as "hung." A moving shimmer signals "loading,"
 * not "broken." Netflix, HBO Max, Disney+ all use this pattern.
 *
 * The shimmer is a single moving highlight band rather than a full gradient
 * sweep — lower GPU cost across 20+ placeholder cards on low-end Android TV
 * boxes (e.g. 2019 Chromecast with Google TV hardware).
 */
@Composable
fun ShimmerPoster(modifier: Modifier = Modifier) {
    val transition = rememberInfiniteTransition(label = "shimmer")
    val progress by transition.animateFloat(
        initialValue = -1f,
        targetValue  = 2f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 1200),
            repeatMode = RepeatMode.Restart,
        ),
        label = "shimmer-progress",
    )

    val shape = RoundedCornerShape(10.dp)
    androidx.compose.foundation.layout.Box(
        modifier = modifier
            .clip(shape)
            .background(AuroraColors.BgCard)
            .drawWithContent {
                drawContent()
                val highlightWidth = size.width * 0.4f
                val x = progress * size.width
                drawRect(
                    brush = Brush.linearGradient(
                        colors = listOf(
                            Color.Transparent,
                            Color.White.copy(alpha = 0.06f),
                            Color.Transparent,
                        ),
                        start = Offset(x - highlightWidth, 0f),
                        end   = Offset(x + highlightWidth, size.height),
                    ),
                    blendMode = BlendMode.SrcOver,
                )
            },
    ) {
        androidx.compose.foundation.layout.Spacer(Modifier.fillMaxSize())
    }
}
