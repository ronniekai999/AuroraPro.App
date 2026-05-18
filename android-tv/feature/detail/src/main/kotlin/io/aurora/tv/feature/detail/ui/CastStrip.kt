package io.aurora.tv.feature.detail.ui

import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.focus.focusRestorer
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.TextStyle
import androidx.tv.material3.Text
import coil3.compose.SubcomposeAsyncImage
import io.aurora.tv.core.design.AuroraColors
import io.aurora.tv.core.design.AuroraDimensions
import io.aurora.tv.core.design.AuroraTypography
import io.aurora.tv.feature.detail.data.CastMember

/**
 * Horizontal "Cast" strip — section header + LazyRow of circular portraits.
 *
 * Each portrait is a 96dp circle (headshot) above two stacked text rows
 * (name in TextPrimary, role in TextSecondary). Focus grammar mirrors the
 * profile picker's orb pattern: scale 1.08 + 3dp violet ring on focus,
 * violet-tinted shadow at elevated z. Same focus restoration via
 * `Modifier.focusRestorer()` so leaving and returning the row preserves
 * which cast member you were on.
 *
 * Cast members aren't currently clickable to anything (no per-person
 * detail screen exists in Phase 0). The clickable modifier wires the
 * onClick hook so we can plug it into navigation later without
 * touching this component.
 *
 * === LOADING / ERROR FALLBACK ===
 * If the headshot URL fails or hasn't loaded yet, the circle shows the
 * first letter of the cast member's name centered on a flat BgCard
 * disc — same "initial on dark" pattern the profile picker uses for
 * empty avatars. Cohesive grammar across the app's portrait surfaces.
 */
@Composable
fun CastStrip(
    cast: List<CastMember>,
    onCastClick: (CastMember) -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(modifier = modifier.fillMaxWidth()) {
        Text(
            text  = "Cast",
            style = AuroraTypography.SectionTitle,
            color = AuroraColors.TextPrimary,
            modifier = Modifier
                .padding(start = AuroraDimensions.SafeAreaHorizontal)
                .padding(bottom = 12.dp),
        )

        LazyRow(
            modifier              = Modifier.focusRestorer(),
            horizontalArrangement = Arrangement.spacedBy(20.dp),
            contentPadding        = PaddingValues(
                horizontal = AuroraDimensions.SafeAreaHorizontal,
            ),
        ) {
            // Composite key of `id-index`. Earlier versions tried `name`
            // and `id` separately; both collide in real data:
            //   - `name`: a single person can be credited multiple times
            //     (e.g. director + writer of the same show)
            //   - `id`: Aurora's cast endpoint returns the PERSON id, not
            //     a unique credit-row pk, so the same person in multiple
            //     roles produces duplicate id values
            // Combining `id` with the list `index` guarantees uniqueness
            // (index alone would be sufficient, but pairing with id keeps
            // recomposition behavior stable across cast refreshes —
            // cast members at the same index but with different ids
            // recompose correctly).
            itemsIndexed(items = cast, key = { idx, m -> "${m.id}-$idx" }) { _, member ->
                CastPortrait(
                    member  = member,
                    onClick = { onCastClick(member) },
                )
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// One cast member: circle headshot + name + role, with focus state polish
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun CastPortrait(
    member: CastMember,
    onClick: () -> Unit,
) {
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()

    val scale     by animateFloatAsState(
        targetValue = if (focused) 1.08f else 1f,
        label = "cast-scale",
    )
    val elevation by animateDpAsState(
        targetValue = if (focused) 18.dp else 4.dp,
        label = "cast-elevation",
    )
    val ringWidth by animateDpAsState(
        targetValue = if (focused) 3.dp else 0.dp,
        label = "cast-ring",
    )

    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Box(
            modifier = Modifier
                .size(96.dp)
                .graphicsLayer {
                    scaleX             = scale
                    scaleY             = scale
                    shadowElevation    = elevation.toPx()
                    shape              = CircleShape
                    clip               = false
                    ambientShadowColor = AuroraColors.Accent
                    spotShadowColor    = AuroraColors.Accent
                }
                .clip(CircleShape)
                .background(AuroraColors.BgCard)
                .border(
                    width = ringWidth,
                    color = AuroraColors.Accent,
                    shape = CircleShape,
                )
                .focusable(interactionSource = interaction)
                .clickable(
                    interactionSource = interaction,
                    indication        = null,
                    onClick           = onClick,
                ),
        ) {
            SubcomposeAsyncImage(
                model              = member.headshotUrl,
                contentDescription = member.name,
                contentScale       = ContentScale.Crop,
                modifier           = Modifier.fillMaxSize(),
                loading = { InitialFallback(name = member.name) },
                error   = { InitialFallback(name = member.name) },
            )
        }

        Spacer(Modifier.height(10.dp))
        Text(
            text     = member.name,
            style    = AuroraTypography.CardTitle,
            color    = AuroraColors.TextPrimary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Text(
            text     = member.role,
            style    = AuroraTypography.CardSub,
            color    = AuroraColors.TextSecondary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/**
 * The "no headshot loaded" fallback — first letter of the name, centered,
 * white-on-BgCard. Mirrors the profile picker's empty-avatar grammar.
 */
@Composable
private fun InitialFallback(name: String) {
    val initial = name.firstOrNull()?.uppercaseChar()?.toString() ?: "?"
    Box(
        modifier         = Modifier
            .fillMaxSize()
            .background(AuroraColors.BgCard),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text  = initial,
            style = TextStyle(
                fontSize   = 32.sp,
                fontWeight = FontWeight.Bold,
            ),
            color = AuroraColors.TextPrimary,
        )
    }
}
