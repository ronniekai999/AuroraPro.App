package io.aurora.tv.core.ui.media

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
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
import io.aurora.tv.core.ui.FocusableCard

/**
 * Browse-row poster card. Used by every screen with a horizontal media row
 * (Home, Detail's "More like this," eventually Movies / Shows / Search).
 *
 * Layered composition (back to front):
 *  1. SubcomposeAsyncImage — real artwork in success state.
 *  2. Hue-derived gradient — fallback for both loading and error slots.
 *     Same HSV pair the profile-picker orbs use, so cards and orbs share
 *     visual grammar across the app.
 *  3. Top-right corner: small genre pill. Subtle so the artwork dominates.
 *  4. Bottom 45%: black-to-transparent vertical scrim for title legibility
 *     against any underlying image.
 *  5. Bottom: optional progress bar (Continue Watching only) + title +
 *     year. Title is SemiBold CardTitle; year is muted.
 *
 * The whole composition lives INSIDE FocusableCard, which provides scale,
 * shadow elevation, violet border, and click handling. Single source of
 * truth for focus grammar.
 */
@Composable
fun PosterCard(
    item: MediaItem,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val hueColor = Color.hsv(item.accentHue.toFloat(), 0.55f, 0.85f)
    val hueDeep  = Color.hsv(item.accentHue.toFloat(), 0.55f, 0.30f)

    val fallbackGradient = Brush.linearGradient(
        colors = listOf(hueColor, hueDeep),
        start  = Offset(0f, 0f),
        end    = Offset.Infinite,
    )

    FocusableCard(
        onClick = onClick,
        modifier = modifier.size(
            width  = AuroraDimensions.CardWidth,
            height = AuroraDimensions.CardPosterHeight,
        ),
    ) { _ ->
        Box(modifier = Modifier.fillMaxSize()) {
            SubcomposeAsyncImage(
                model              = item.posterUrl,
                contentDescription = "${item.title} poster",
                contentScale       = ContentScale.Crop,
                modifier           = Modifier.fillMaxSize(),
                loading = {
                    Box(modifier = Modifier
                        .fillMaxSize()
                        .background(fallbackGradient)
                    )
                },
                error = {
                    Box(modifier = Modifier
                        .fillMaxSize()
                        .background(fallbackGradient)
                    )
                },
            )

            item.genres.firstOrNull()?.let { genre ->
                Text(
                    // Display abbreviation: TMDB's TV genres include
                    // combined names like "Action & Adventure", "Sci-Fi
                    // & Fantasy", "War & Politics" that are 2-3x wider
                    // than single-word movie genres the badge was sized
                    // for. Splitting on " & " and taking the first token
                    // collapses those to "Action", "Sci-Fi", "War" while
                    // leaving single-word genres untouched. The full
                    // genre string stays in `item.genres` for the filter
                    // matchKey comparison — this only affects display.
                    text     = genre.substringBefore(" & ").uppercase(),
                    color    = Color.White,
                    fontSize = 9.sp,
                    fontWeight    = FontWeight.SemiBold,
                    letterSpacing = 0.12.em,
                    // Safety net: if a future genre name is somehow longer
                    // than the badge can fit even after the " & " split,
                    // truncate cleanly with ellipsis rather than wrapping.
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier
                        .align(Alignment.TopEnd)
                        .padding(top = 8.dp, end = 8.dp)
                        .clip(RoundedCornerShape(999.dp))
                        .background(Color.Black.copy(alpha = 0.65f))
                        .border(
                            width = 0.5.dp,
                            color = Color.White.copy(alpha = 0.28f),
                            shape = RoundedCornerShape(999.dp),
                        )
                        .padding(horizontal = 7.dp, vertical = 3.dp),
                )
            }

            Box(
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .fillMaxWidth()
                    .background(
                        Brush.verticalGradient(
                            0f    to Color.Transparent,
                            0.55f to Color.Black.copy(alpha = 0.55f),
                            1f    to Color.Black.copy(alpha = 0.85f),
                        ),
                    ),
            ) {
                Column(
                    modifier = Modifier.padding(horizontal = 10.dp, vertical = 9.dp),
                ) {
                    item.progressPercent?.let { pct ->
                        ProgressBar(percent = pct)
                        Spacer(Modifier.height(6.dp))
                    }
                    Text(
                        text     = item.title,
                        style    = AuroraTypography.CardTitle,
                        color    = Color.White,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                    // Suppress the year line when unknown (sentinel 0).
                    // Some feeds — Continue Watching in particular — don't
                    // ship year on the wire; rendering "0" looked broken.
                    if (item.year > 0) {
                        Text(
                            text  = item.year.toString(),
                            style = AuroraTypography.CardSub,
                            color = Color.White.copy(alpha = 0.70f),
                        )
                    }
                }
            }
        }
    }
}

/**
 * Progress strip for Continue-Watching cards. Two stacked Boxes — track
 * at white-alpha 0.20 + violet fill at fillMaxWidth(percent / 100f).
 * coerceIn guards against bad backend data.
 */
@Composable
private fun ProgressBar(percent: Int) {
    val fraction = (percent.coerceIn(0, 100)) / 100f
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(3.dp)
            .clip(RoundedCornerShape(2.dp))
            .background(Color.White.copy(alpha = 0.20f)),
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth(fraction)
                .fillMaxHeight()
                .background(AuroraColors.Accent),
        )
    }
}
