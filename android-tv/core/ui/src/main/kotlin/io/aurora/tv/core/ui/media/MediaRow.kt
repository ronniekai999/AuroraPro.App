package io.aurora.tv.core.ui.media

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.focusRestorer
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Text
import io.aurora.tv.core.design.AuroraColors
import io.aurora.tv.core.design.AuroraDimensions
import io.aurora.tv.core.design.AuroraTypography

/**
 * One titled horizontal row. Reused by Home, Detail ("More like this"),
 * and any future screen with a labeled media-row pattern.
 *
 * === API CHANGE FROM EARLIER ===
 * Previously took a feature-specific `HomeRow` data class; now takes
 * `(title, items, onItemClick)` directly. Decoupling lets multiple
 * features supply the row's content from their own data shapes
 * without requiring a shared row type.
 *
 * === LAYOUT NOTE ===
 * The row title gets `padding(start = SafeAreaHorizontal)` so it aligns
 * with the hero's left edge. The LazyRow uses `contentPadding(horizontal
 * = SafeAreaHorizontal)` rather than wrapping in a padded Column. Reason:
 * contentPadding lets cards scroll OFF the safe-area edge during focus-
 * induced scroll, so the focused card can sit at any column position
 * rather than always snapping back inside the safe area.
 *
 * `key = { it.id }` enables LazyRow to retain Composable instances across
 * recompositions — necessary for `focusRestorer()` to actually restore.
 */
@Composable
fun MediaRow(
    title: String,
    items: List<MediaItem>,
    onItemClick: (MediaItem) -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(modifier = modifier.fillMaxWidth()) {
        Text(
            text  = title,
            style = AuroraTypography.SectionTitle,
            color = AuroraColors.TextPrimary,
            modifier = Modifier
                .padding(start = AuroraDimensions.SafeAreaHorizontal)
                .padding(bottom = 12.dp),
        )

        LazyRow(
            modifier              = Modifier.focusRestorer(),
            horizontalArrangement = Arrangement.spacedBy(AuroraDimensions.CardGap),
            contentPadding        = PaddingValues(
                horizontal = AuroraDimensions.SafeAreaHorizontal,
            ),
        ) {
            items(items = items, key = { it.id }) { item ->
                PosterCard(
                    item    = item,
                    onClick = { onItemClick(item) },
                )
            }
        }
    }
}
