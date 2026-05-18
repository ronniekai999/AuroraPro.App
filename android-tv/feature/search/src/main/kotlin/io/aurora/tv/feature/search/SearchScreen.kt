package io.aurora.tv.feature.search

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateFloatAsState
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
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Backspace
import androidx.compose.material.icons.filled.Close
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.tv.material3.Icon
import androidx.tv.material3.Text
import io.aurora.tv.core.design.AuroraColors
import io.aurora.tv.core.design.AuroraDimensions
import io.aurora.tv.core.design.AuroraTypography
import io.aurora.tv.core.ui.media.MediaItem
import io.aurora.tv.core.ui.media.PosterCard

/**
 * Search screen — Phase 0 implementation.
 *
 * Layout: header bar (title + close), large query display, then a two-column
 * split — on-screen character keyboard on the left, LazyVerticalGrid of
 * results on the right. ViewModel holds query state; the keyboard mutates it
 * via appendChar / backspace / clear and the result grid renders whatever
 * `results` derives from the current query.
 *
 * Focus grammar: the first key auto-focuses on entry so the user can start
 * typing immediately. Compose's spatial focus search handles intra-keyboard
 * D-pad navigation and the keyboard ↔ result-grid hand-off; we deliberately
 * do not over-engineer this for Phase 0.
 */
@Composable
fun SearchScreen(
    onItemClick: (MediaItem) -> Unit = {},
    onBack: () -> Unit = {},
    viewModel: SearchViewModel = hiltViewModel(),
) {
    val query   by viewModel.query.collectAsStateWithLifecycle()
    val results by viewModel.results.collectAsStateWithLifecycle()

    val firstKeyFocusRequester = remember { FocusRequester() }

    // Initial focus on the first key. We wait ONE frame before calling
    // requestFocus(), because LaunchedEffect(Unit) fires immediately after
    // the first composition pass — earlier than Compose has bound the
    // requester to its node. Without `withFrameNanos`, requestFocus()
    // throws IllegalStateException ("FocusRequester is not initialized")
    // on the unbound node, the call is silently lost (it does NOT retry),
    // and the screen opens with nothing focused. Waiting one frame is
    // the canonical fix for this race.
    LaunchedEffect(Unit) {
        withFrameNanos { /* one frame elapsed; requester is now bound */ }
        firstKeyFocusRequester.requestFocus()
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(AuroraColors.BgPrimary),
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(
                    start = AuroraDimensions.SafeAreaHorizontal,
                    end   = AuroraDimensions.SafeAreaHorizontal,
                    top   = 24.dp,
                ),
        ) {
            // ── Top row: "Search" header + close button ────────────────────
            Row(
                modifier              = Modifier.fillMaxWidth(),
                verticalAlignment     = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    text  = "Search",
                    style = AuroraTypography.RowTitle,
                    color = AuroraColors.TextPrimary,
                )
                CloseButton(onClick = onBack)
            }

            Spacer(Modifier.height(20.dp))

            // ── Query display ──────────────────────────────────────────────
            if (query.isEmpty()) {
                Text(
                    text  = "Type to search…",
                    style = TextStyle(fontSize = 32.sp, fontWeight = FontWeight.Bold),
                    color = AuroraColors.TextSecondary,
                )
            } else {
                Text(
                    text  = query,
                    style = TextStyle(fontSize = 32.sp, fontWeight = FontWeight.Bold),
                    color = AuroraColors.TextPrimary,
                )
            }

            Spacer(Modifier.height(24.dp))

            // ── Two-column split: keyboard | results ───────────────────────
            Row(
                modifier              = Modifier
                    .fillMaxWidth()
                    .fillMaxHeight(),
                horizontalArrangement = Arrangement.spacedBy(32.dp),
            ) {
                Box(modifier = Modifier.weight(0.40f).fillMaxHeight()) {
                    Keyboard(
                        firstKeyFocusRequester = firstKeyFocusRequester,
                        onKey = { key ->
                            when (key) {
                                is Key.Char  -> viewModel.appendChar(key.c)
                                Key.Space    -> viewModel.appendChar(' ')
                                Key.Backspace-> viewModel.backspace()
                                Key.Clear    -> viewModel.clear()
                            }
                        },
                    )
                }

                Box(modifier = Modifier.weight(0.60f).fillMaxHeight()) {
                    if (results.isEmpty()) {
                        // Empty-results state. Critical detail: when the user
                        // has TYPED something and got no matches, the right
                        // pane needs a focusable affordance — otherwise
                        // pressing D-pad RIGHT from the rightmost keyboard
                        // column lands on a Text node, which isn't focusable,
                        // so spatial focus search keeps focus on the keyboard
                        // and the keypress is silently consumed. Empty pane
                        // looks dead; user has no way to recover except
                        // backspacing. We render a focusable "Clear search"
                        // button below the message so RIGHT has a target.
                        //
                        // When query is empty (cold-launch state), there's
                        // nothing to clear; the message stays a plain Text.
                        // RIGHT-from-keyboard is a no-op in that state, but
                        // the user hasn't engaged yet so it reads as
                        // "nothing to do here, type something."
                        Column(
                            modifier = Modifier
                                .align(Alignment.TopStart)
                                .padding(top = 12.dp),
                            verticalArrangement = Arrangement.spacedBy(16.dp),
                        ) {
                            val msg = if (query.isNotEmpty()) {
                                "No results for \"$query\""
                            } else {
                                "Type to search by title, genre, or year."
                            }
                            Text(
                                text  = msg,
                                style = AuroraTypography.Body,
                                color = AuroraColors.TextSecondary,
                            )
                            if (query.isNotEmpty()) {
                                ClearSearchButton(onClick = viewModel::clear)
                            }
                        }
                    } else {
                        LazyVerticalGrid(
                            columns               = GridCells.Fixed(4),
                            verticalArrangement   = Arrangement.spacedBy(AuroraDimensions.RowGap),
                            horizontalArrangement = Arrangement.spacedBy(AuroraDimensions.CardGap),
                            modifier              = Modifier.fillMaxSize(),
                            contentPadding        = androidx.compose.foundation.layout.PaddingValues(
                                bottom = AuroraDimensions.SafeAreaVertical,
                            ),
                        ) {
                            items(results, key = { it.id }) { item ->
                                PosterCard(
                                    item    = item,
                                    onClick = { onItemClick(item) },
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

/* ─────────────────────────── Keyboard ─────────────────────────── */

private sealed class Key {
    data class Char(val c: kotlin.Char) : Key()
    data object Backspace : Key()
    data object Clear : Key()
    data object Space : Key()
}

/**
 * On-screen character grid keyboard. Six keys per row: A-Z then 0-9, then
 * a final row of utility keys (Space / Backspace / Clear). The first letter
 * key gets the supplied FocusRequester so the screen can land focus on
 * entry; D-pad spatial nav handles every other key.
 */
@Composable
private fun Keyboard(
    firstKeyFocusRequester: FocusRequester,
    onKey: (Key) -> Unit,
) {
    val letters: List<Key> = ('A'..'Z').map { Key.Char(it) }
    val digits:  List<Key> = ('0'..'9').map { Key.Char(it) }
    val keys: List<Key> = letters + digits + listOf(Key.Space, Key.Backspace, Key.Clear)

    val columns = 6
    val rows = keys.chunked(columns)

    Column(
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        rows.forEachIndexed { rowIdx, rowKeys ->
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                rowKeys.forEachIndexed { colIdx, key ->
                    val isFirst = rowIdx == 0 && colIdx == 0
                    KeyButton(
                        key            = key,
                        onClick        = { onKey(key) },
                        focusRequester = if (isFirst) firstKeyFocusRequester else null,
                    )
                }
            }
        }
    }
}

@Composable
private fun KeyButton(
    key: Key,
    onClick: () -> Unit,
    focusRequester: FocusRequester?,
) {
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()

    val bgAlpha by animateFloatAsState(
        targetValue = if (focused) 0.18f else 0.0f,
        label = "key-bg",
    )
    val labelColor by animateColorAsState(
        targetValue = if (focused) AuroraColors.TextPrimary else AuroraColors.TextSecondary,
        label = "key-label",
    )

    val height: Dp = 52.dp
    val width: Dp = when (key) {
        is Key.Char -> 52.dp
        Key.Space, Key.Backspace, Key.Clear -> 88.dp
    }

    Box(
        modifier = Modifier
            .size(width = width, height = height)
            .clip(RoundedCornerShape(8.dp))
            .background(
                color = if (focused) AuroraColors.Accent.copy(alpha = bgAlpha) else Color.Transparent,
            )
            .border(
                // Border width is constant — only color flips on focus.
                width = 1.dp,
                color = if (focused) AuroraColors.Accent else AuroraColors.Divider,
                shape = RoundedCornerShape(8.dp),
            )
            .then(if (focusRequester != null) Modifier.focusRequester(focusRequester) else Modifier)
            .clickable(
                interactionSource = interaction,
                indication        = null,
                onClick           = onClick,
            ),
        contentAlignment = Alignment.Center,
    ) {
        when (key) {
            is Key.Char -> Text(
                text  = key.c.toString(),
                style = TextStyle(fontSize = 18.sp, fontWeight = FontWeight.SemiBold),
                color = labelColor,
            )
            Key.Space -> Text(
                text  = "Space",
                style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold),
                color = labelColor,
            )
            Key.Backspace -> Icon(
                imageVector        = Icons.AutoMirrored.Filled.Backspace,
                contentDescription = "Backspace",
                tint               = labelColor,
                modifier           = Modifier.size(20.dp),
            )
            Key.Clear -> Text(
                text  = "Clear",
                style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold),
                color = labelColor,
            )
        }
    }
}

/**
 * Focusable affordance that clears the current search query. Rendered in
 * the right pane's empty-results state so D-pad RIGHT from the keyboard
 * always has a destination — without this, the right pane is a focus
 * dead-end whenever the query produces no matches.
 */
@Composable
private fun ClearSearchButton(onClick: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()

    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(8.dp))
            .background(
                if (focused) AuroraColors.Accent.copy(alpha = 0.18f) else Color.Transparent,
            )
            .border(
                width = 1.dp,
                color = if (focused) AuroraColors.Accent else AuroraColors.Divider,
                shape = RoundedCornerShape(8.dp),
            )
            .clickable(
                interactionSource = interaction,
                indication        = null,
                onClick           = onClick,
            )
            .padding(horizontal = 16.dp, vertical = 10.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text  = "Clear search",
            style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
            color = if (focused) AuroraColors.TextPrimary else AuroraColors.TextSecondary,
        )
    }
}

@Composable
private fun CloseButton(onClick: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()

    Box(
        modifier = Modifier
            .size(40.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(
                if (focused) AuroraColors.Accent.copy(alpha = 0.18f) else Color.Transparent,
            )
            .border(
                width = 1.dp,
                color = if (focused) AuroraColors.Accent else AuroraColors.Divider,
                shape = RoundedCornerShape(8.dp),
            )
            .clickable(
                interactionSource = interaction,
                indication        = null,
                onClick           = onClick,
            ),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            imageVector        = Icons.Filled.Close,
            contentDescription = "Close search",
            tint               = if (focused) AuroraColors.TextPrimary else AuroraColors.TextSecondary,
            modifier           = Modifier.size(20.dp),
        )
    }
}
