package io.aurora.tv.feature.account

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
import androidx.compose.material.icons.filled.Close
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Icon
import androidx.tv.material3.Text
import io.aurora.tv.core.design.AuroraColors
import io.aurora.tv.core.design.AuroraDimensions
import io.aurora.tv.core.design.AuroraTypography

/**
 * Account / Profile overlay — Phase 0.
 *
 * The signature is locked: `AuroraNavHost` calls this exact shape, and
 * `onSignOut` is wired to a real navigation back to SignIn.
 *
 * Module is named `feature:account` to avoid collision with the existing
 * `feature:profiles` (multi-profile picker). User-facing header reads
 * "Profile".
 *
 * Layout:
 *   ┌─ "Profile" header                        [✕]
 *   │
 *   │     ┌───┐
 *   │     │ R │   Ronnie
 *   │     └───┘   Aurora member since 2025
 *   │
 *   │   [Watch time]  [Movies watched]  [Series followed]
 *   │
 *   │   [ Switch profile ]   [ Sign out ]
 *   └────────────────────────────────────────────
 *
 * Phase 0 details:
 *  - Stats are cosmetic; no data plumbing yet.
 *  - "Switch profile" is a deliberate no-op — re-entry to the picker isn't
 *    wired up this phase.
 *  - "Sign out" is the only real action; it just calls onSignOut().
 */
@Composable
fun AccountScreen(
    onBack: () -> Unit = {},
    onSignOut: () -> Unit = {},
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
            // ── Header: "Profile" + close ─────────────────────────────────
            Row(
                modifier              = Modifier.fillMaxWidth(),
                verticalAlignment     = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    text  = "Profile",
                    style = AuroraTypography.RowTitle,
                    color = AuroraColors.TextPrimary,
                )
                CloseButton(onClick = onBack)
            }

            Spacer(Modifier.height(40.dp))

            // ── Profile card ─────────────────────────────────────────────
            ProfileCard(
                initial = "R",
                name    = "Ronnie",
                tagline = "Aurora member since 2025",
            )

            Spacer(Modifier.height(36.dp))

            // ── Stats row ────────────────────────────────────────────────
            Row(
                modifier              = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                StatTile(label = "Watch time",      value = "142h")
                StatTile(label = "Movies watched",  value = "38")
                StatTile(label = "Series followed", value = "12")
            }

            Spacer(Modifier.height(36.dp))

            // ── Action buttons ───────────────────────────────────────────
            Row(
                horizontalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                ActionButton(
                    label   = "Switch profile",
                    onClick = { /* Phase 0: no-op */ },
                )
                ActionButton(
                    label   = "Sign out",
                    onClick = onSignOut,
                )
            }
        }
    }
}

/* ─────────────────────────── Profile card ─────────────────────────── */

@Composable
private fun ProfileCard(
    initial: String,
    name: String,
    tagline: String,
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // Avatar — colored circle with a single letter; no real image needed.
        Box(
            modifier = Modifier
                .size(96.dp)
                .clip(CircleShape)
                .background(AuroraColors.Accent),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text  = initial,
                style = TextStyle(fontSize = 44.sp, fontWeight = FontWeight.Bold),
                color = AuroraColors.BgPrimary,
            )
        }

        Spacer(Modifier.width(20.dp))

        Column {
            Text(
                text  = name,
                style = AuroraTypography.SectionTitle,
                color = AuroraColors.TextPrimary,
            )
            Spacer(Modifier.height(4.dp))
            Text(
                text  = tagline,
                style = AuroraTypography.Body,
                color = AuroraColors.TextSecondary,
            )
        }
    }
}

/* ─────────────────────────── Stat tile ─────────────────────────── */

@Composable
private fun StatTile(label: String, value: String) {
    Box(
        modifier = Modifier
            .width(220.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(AuroraColors.BgCard)
            .border(
                width = 1.dp,
                color = AuroraColors.Divider,
                shape = RoundedCornerShape(12.dp),
            )
            .padding(horizontal = 20.dp, vertical = 18.dp),
    ) {
        Column {
            Text(
                text  = value,
                style = TextStyle(fontSize = 26.sp, fontWeight = FontWeight.Bold),
                color = AuroraColors.TextPrimary,
            )
            Spacer(Modifier.height(4.dp))
            Text(
                text  = label,
                style = AuroraTypography.Caption,
                color = AuroraColors.TextSecondary,
            )
        }
    }
}

/* ─────────────────────────── Action button ─────────────────────────── */

/**
 * Focusable / clickable action button. We attach the focus tracking via
 * `clickable`'s interactionSource — stacking `.focusable()` above
 * `.clickable()` is a known bug in this codebase that breaks D-pad
 * activation, so we let `clickable` provide focusability on its own.
 */
@Composable
private fun ActionButton(
    label: String,
    onClick: () -> Unit,
) {
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()

    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(10.dp))
            .background(
                if (focused) AuroraColors.Accent.copy(alpha = 0.18f) else Color.Transparent,
            )
            .border(
                width = 1.dp,
                color = if (focused) AuroraColors.Accent else AuroraColors.Divider,
                shape = RoundedCornerShape(10.dp),
            )
            .clickable(
                interactionSource = interaction,
                indication        = null,
                onClick           = onClick,
            )
            .padding(horizontal = 24.dp, vertical = 14.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text  = label,
            style = AuroraTypography.Button,
            color = if (focused) AuroraColors.TextPrimary else AuroraColors.TextSecondary,
        )
    }
}

/* ─────────────────────────── Close button ─────────────────────────── */

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
            contentDescription = "Close profile",
            tint               = if (focused) AuroraColors.TextPrimary else AuroraColors.TextSecondary,
            modifier           = Modifier.size(20.dp),
        )
    }
}
