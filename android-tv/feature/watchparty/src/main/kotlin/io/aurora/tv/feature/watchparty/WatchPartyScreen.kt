package io.aurora.tv.feature.watchparty

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
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.People
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Icon
import androidx.tv.material3.Text
import io.aurora.tv.core.design.AuroraColors
import io.aurora.tv.core.design.AuroraDimensions
import io.aurora.tv.core.design.AuroraTypography

/**
 * SCAFFOLD — Phase 0 placeholder for the Watch Party feature.
 *
 * Signature is locked: AuroraNavHost calls this exact Composable shape, and
 * the eventual real feature (Slice G) will keep the same shape — only the
 * body swaps over to wire up real rooms / a create flow / a backend.
 *
 * The body intentionally hints at the eventual UI (overlay-style screen with
 * a list of rooms + a create CTA) so clicking the Groups icon in the bar
 * already feels like a destination instead of a "coming soon" wall. All the
 * data here is fake; clicking a room is a no-op for now.
 *
 * Layout follows the SearchScreen overlay pattern: header with title +
 * close button, no TopNavBar.
 */
@Composable
fun WatchPartyScreen(
    onBack: () -> Unit = {},
) {
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
            // ── Top row: "Watch Party" header + close button ───────────────
            Row(
                modifier              = Modifier.fillMaxWidth(),
                verticalAlignment     = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    text  = "Watch Party",
                    style = AuroraTypography.RowTitle,
                    color = AuroraColors.TextPrimary,
                )
                CloseButton(onClick = onBack)
            }

            Spacer(Modifier.height(28.dp))

            // ── Active rooms section ───────────────────────────────────────
            Text(
                text  = "Active rooms",
                style = AuroraTypography.SectionTitle,
                color = AuroraColors.TextPrimary,
            )
            Spacer(Modifier.height(4.dp))
            Text(
                text  = "Drop into a room your friends are already watching, or start a new one below.",
                style = AuroraTypography.Body,
                color = AuroraColors.TextSecondary,
            )

            Spacer(Modifier.height(20.dp))

            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                FAKE_ROOMS.forEach { room ->
                    RoomCard(room = room, onClick = { /* Phase 0: no-op */ })
                }
            }

            Spacer(Modifier.height(32.dp))

            // ── Create room CTA ────────────────────────────────────────────
            CreateRoomCard(onClick = { /* Phase 0: no-op */ })
        }
    }
}

/* ─────────────────────────── Fake data ─────────────────────────── */

private data class FakeRoom(
    val name: String,
    val nowPlaying: String,
    val participants: Int,
    val friendsHere: Boolean,
)

// Hand-tuned placeholders — enough variety that the screen reads as alive.
// Replace with the real RoomRepository feed when Slice G lands.
private val FAKE_ROOMS = listOf(
    FakeRoom("Friday Movie Night",  "Dune: Part Two",          4, friendsHere = true),
    FakeRoom("Sci-Fi Sundays",      "Blade Runner 2049",       2, friendsHere = true),
    FakeRoom("The Couch Critics",   "Everything Everywhere",   3, friendsHere = false),
    FakeRoom("Late Show Crew",      "Severance — S2 E3",       6, friendsHere = false),
)

/* ─────────────────────────── Cards ─────────────────────────── */

/**
 * Wide horizontal card representing a single watch-party room.
 *
 * Focus grammar mirrors PosterCard / FocusableCard: one focusable surface
 * via `.clickable`, with focus ring + soft tint driven by the same
 * interaction source. We do NOT stack `.focusable()` on top of `.clickable`
 * — that's the bug where SELECT silently no-ops because two focus targets
 * compete for D-pad input.
 */
@Composable
private fun RoomCard(
    room: FakeRoom,
    onClick: () -> Unit,
) {
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()

    val shape = RoundedCornerShape(12.dp)

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(AuroraColors.BgCard, shape)
            .border(
                width = if (focused) AuroraDimensions.FocusRingWidth else 1.dp,
                color = if (focused) AuroraColors.Accent else AuroraColors.Divider,
                shape = shape,
            )
            .clickable(
                interactionSource = interaction,
                indication        = null,
                onClick           = onClick,
            )
            .padding(horizontal = 20.dp, vertical = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // Left: people glyph in a tinted disc — visual anchor so the row
        // doesn't read as a flat strip of text.
        Box(
            modifier = Modifier
                .size(44.dp)
                .background(AuroraColors.AccentSoft, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector        = Icons.Filled.People,
                contentDescription = null,
                tint               = AuroraColors.Accent,
                modifier           = Modifier.size(22.dp),
            )
        }

        Spacer(Modifier.width(16.dp))

        // Middle: room name + what's playing (takes remaining width).
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text  = room.name,
                style = AuroraTypography.CardTitle,
                color = AuroraColors.TextPrimary,
            )
            Spacer(Modifier.height(2.dp))
            Text(
                text  = "Watching: ${room.nowPlaying}",
                style = AuroraTypography.CardSub,
                color = AuroraColors.TextSecondary,
            )
        }

        Spacer(Modifier.width(16.dp))

        // Right: participant count + optional "Friends here" pill.
        Column(horizontalAlignment = Alignment.End) {
            Text(
                text  = "${room.participants} watching",
                style = AuroraTypography.CardSub,
                color = AuroraColors.TextPrimary,
            )
            if (room.friendsHere) {
                Spacer(Modifier.height(6.dp))
                FriendsHerePill()
            }
        }
    }
}

@Composable
private fun FriendsHerePill() {
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(999.dp))
            .background(AuroraColors.AccentSoft)
            .padding(horizontal = 10.dp, vertical = 4.dp),
    ) {
        Text(
            text  = "Friends here",
            style = AuroraTypography.Caption,
            color = AuroraColors.Accent,
        )
    }
}

/**
 * Full-width focusable CTA for starting a new room. Same focus grammar as
 * RoomCard — single `.clickable` surface, focus ring + accent tint on focus.
 */
@Composable
private fun CreateRoomCard(onClick: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()

    val shape = RoundedCornerShape(12.dp)

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(
                color = if (focused) AuroraColors.AccentSoft else Color.Transparent,
                shape = shape,
            )
            .border(
                width = if (focused) AuroraDimensions.FocusRingWidth else 1.dp,
                color = if (focused) AuroraColors.Accent else AuroraColors.Divider,
                shape = shape,
            )
            .clickable(
                interactionSource = interaction,
                indication        = null,
                onClick           = onClick,
            )
            .padding(horizontal = 20.dp, vertical = 18.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector        = Icons.Filled.Add,
            contentDescription = null,
            tint               = if (focused) AuroraColors.TextPrimary else AuroraColors.Accent,
            modifier           = Modifier.size(24.dp),
        )
        Spacer(Modifier.width(14.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text  = "Create a new room",
                style = AuroraTypography.CardTitle,
                color = if (focused) AuroraColors.TextPrimary else AuroraColors.TextPrimary,
            )
            Spacer(Modifier.height(2.dp))
            Text(
                text  = "Pick something to watch and invite your friends.",
                style = AuroraTypography.CardSub,
                color = AuroraColors.TextSecondary,
            )
        }
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
            contentDescription = "Close watch party",
            tint               = if (focused) AuroraColors.TextPrimary else AuroraColors.TextSecondary,
            modifier           = Modifier.size(20.dp),
        )
    }
}
