package io.aurora.tv.feature.settings

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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
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
 * Settings — Phase 0 implementation.
 *
 * Two-column layout: a vertical category list on the left, a detail pane
 * on the right that swaps contents based on the selected category. All
 * controls are non-functional placeholders — they are focusable so D-pad
 * navigation feels real, but selection is a no-op.
 *
 * Focus grammar: first category button auto-focuses on entry. D-pad RIGHT
 * from the left rail enters the right pane via Compose's spatial focus
 * search. D-pad LEFT goes back. The right pane always has at least one
 * focusable control so the rail never D-pads into a dead-end.
 */
@Composable
fun SettingsScreen(
    onBack: () -> Unit = {},
) {
    var selected by remember { mutableStateOf(SettingsCategory.Playback) }

    val firstCategoryFocusRequester = remember { FocusRequester() }

    // Wait one frame so the requester is bound before we call requestFocus().
    // Same race-fix pattern used in SearchScreen.
    LaunchedEffect(Unit) {
        withFrameNanos { /* one frame elapsed; requester bound */ }
        firstCategoryFocusRequester.requestFocus()
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
            // ── Top row: "Settings" header + close button ──────────────────
            Row(
                modifier              = Modifier.fillMaxWidth(),
                verticalAlignment     = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    text  = "Settings",
                    style = AuroraTypography.RowTitle,
                    color = AuroraColors.TextPrimary,
                )
                CloseButton(onClick = onBack)
            }

            Spacer(Modifier.height(28.dp))

            // ── Two-column body ────────────────────────────────────────────
            Row(
                modifier              = Modifier
                    .fillMaxWidth()
                    .fillMaxHeight(),
                horizontalArrangement = Arrangement.spacedBy(32.dp),
            ) {
                // LEFT: category rail (~30%)
                Column(
                    modifier            = Modifier
                        .weight(0.30f)
                        .fillMaxHeight(),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    SettingsCategory.entries.forEachIndexed { idx, category ->
                        CategoryButton(
                            label          = category.label,
                            selected       = category == selected,
                            onClick        = { selected = category },
                            focusRequester = if (idx == 0) firstCategoryFocusRequester else null,
                        )
                    }
                }

                // RIGHT: detail pane (~70%)
                Box(
                    modifier = Modifier
                        .weight(0.70f)
                        .fillMaxHeight(),
                ) {
                    DetailPane(category = selected)
                }
            }
        }
    }
}

/* ─────────────────────────── Category model ─────────────────────────── */

private enum class SettingsCategory(val label: String) {
    Playback("Playback"),
    Audio("Audio"),
    Subtitles("Subtitles"),
    Account("Account"),
    About("About"),
}

/* ─────────────────────────── Left rail ─────────────────────────── */

@Composable
private fun CategoryButton(
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    focusRequester: FocusRequester?,
) {
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()

    // Visual emphasis priority: focus ring > selected fill > resting.
    val bg = when {
        focused  -> AuroraColors.Accent.copy(alpha = 0.22f)
        selected -> AuroraColors.AccentSoft
        else     -> Color.Transparent
    }
    val borderColor = when {
        focused  -> AuroraColors.Accent
        selected -> AuroraColors.Accent.copy(alpha = 0.40f)
        else     -> AuroraColors.Divider
    }
    val labelColor = if (focused || selected) AuroraColors.TextPrimary else AuroraColors.TextSecondary

    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(52.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(bg)
            .border(
                width = 1.dp,
                color = borderColor,
                shape = RoundedCornerShape(10.dp),
            )
            .then(if (focusRequester != null) Modifier.focusRequester(focusRequester) else Modifier)
            .clickable(
                interactionSource = interaction,
                indication        = null,
                onClick           = onClick,
            )
            .padding(horizontal = 18.dp),
        contentAlignment = Alignment.CenterStart,
    ) {
        Text(
            text  = label,
            style = AuroraTypography.Button,
            color = labelColor,
        )
    }
}

/* ─────────────────────────── Right pane ─────────────────────────── */

@Composable
private fun DetailPane(category: SettingsCategory) {
    Column(
        modifier            = Modifier
            .fillMaxSize()
            .padding(start = 8.dp, top = 4.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Text(
            text  = category.label,
            style = AuroraTypography.SectionTitle,
            color = AuroraColors.TextPrimary,
        )

        Spacer(Modifier.height(4.dp))

        when (category) {
            SettingsCategory.Playback  -> PlaybackContent()
            SettingsCategory.Audio     -> AudioContent()
            SettingsCategory.Subtitles -> SubtitlesContent()
            SettingsCategory.Account   -> AccountContent()
            SettingsCategory.About     -> AboutContent()
        }
    }
}

@Composable
private fun PlaybackContent() {
    ToggleRow(label = "Auto-play next episode", options = listOf("On", "Off"), selectedIndex = 0)
    SelectRow(label = "Default quality",        options = listOf("Auto", "1080p", "4K"), selectedIndex = 0)
    ToggleRow(label = "Skip intros automatically", options = listOf("On", "Off"), selectedIndex = 1)
}

@Composable
private fun AudioContent() {
    SelectRow(label = "Default audio language", options = listOf("English", "Spanish", "Japanese"), selectedIndex = 0)
    SelectRow(label = "Default audio track",    options = listOf("Stereo", "5.1 Surround", "Dolby Atmos"), selectedIndex = 1)
    ToggleRow(label = "Boost dialogue",         options = listOf("On", "Off"), selectedIndex = 1)
}

@Composable
private fun SubtitlesContent() {
    ToggleRow(label = "Subtitles",          options = listOf("On", "Off"), selectedIndex = 1)
    SelectRow(label = "Subtitle language",  options = listOf("English", "Spanish", "French"), selectedIndex = 0)
    SelectRow(label = "Subtitle size",      options = listOf("Small", "Medium", "Large"), selectedIndex = 1)
    SelectRow(label = "Subtitle style",     options = listOf("Default", "High contrast", "Outlined"), selectedIndex = 0)
}

@Composable
private fun AccountContent() {
    InfoRow(label = "Signed in as", value = "ronnie@naptown.org")
    SelectRow(label = "Profile", options = listOf("Ronnie", "Guest"), selectedIndex = 0)
    ToggleRow(label = "Parental controls", options = listOf("On", "Off"), selectedIndex = 1)
}

@Composable
private fun AboutContent() {
    InfoRow(label = "App version", value = "0.1.0-alpha")
    Text(
        text  = "Built with care.",
        style = AuroraTypography.Body,
        color = AuroraColors.TextSecondary,
    )
    Spacer(Modifier.height(8.dp))
    SignOutButton(onClick = { /* no-op for Phase 0 */ })
}

/* ─────────────────────────── Row primitives ─────────────────────────── */

/**
 * Two-state toggle row. Visually a label on the left and a focusable
 * pill showing the current option on the right. Tapping cycles between
 * the two options (purely cosmetic — state is local to the pill).
 */
@Composable
private fun ToggleRow(
    label: String,
    options: List<String>,
    selectedIndex: Int,
) {
    var index by remember { mutableStateOf(selectedIndex) }
    SettingsRowFrame(label = label) {
        ValuePill(
            text    = options[index],
            onClick = { index = (index + 1) % options.size },
        )
    }
}

/**
 * Multi-option select row. Same shape as ToggleRow but cycles through
 * however many options are supplied.
 */
@Composable
private fun SelectRow(
    label: String,
    options: List<String>,
    selectedIndex: Int,
) {
    var index by remember { mutableStateOf(selectedIndex) }
    SettingsRowFrame(label = label) {
        ValuePill(
            text    = options[index],
            onClick = { index = (index + 1) % options.size },
        )
    }
}

@Composable
private fun InfoRow(label: String, value: String) {
    SettingsRowFrame(label = label) {
        Text(
            text  = value,
            style = AuroraTypography.Body,
            color = AuroraColors.TextSecondary,
        )
    }
}

@Composable
private fun SettingsRowFrame(
    label: String,
    trailing: @Composable () -> Unit,
) {
    Row(
        modifier              = Modifier
            .fillMaxWidth()
            .height(44.dp),
        verticalAlignment     = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(
            text  = label,
            style = AuroraTypography.Body,
            color = AuroraColors.TextPrimary,
        )
        trailing()
    }
}

@Composable
private fun ValuePill(
    text: String,
    onClick: () -> Unit,
) {
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()

    Box(
        modifier = Modifier
            .height(36.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(if (focused) AuroraColors.Accent.copy(alpha = 0.18f) else AuroraColors.BgCard)
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
            .padding(horizontal = 14.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text  = text,
            style = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
            color = if (focused) AuroraColors.TextPrimary else AuroraColors.TextSecondary,
        )
    }
}

@Composable
private fun SignOutButton(onClick: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()

    Box(
        modifier = Modifier
            .width(160.dp)
            .height(44.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(if (focused) AuroraColors.Accent.copy(alpha = 0.22f) else Color.Transparent)
            .border(
                width = 1.dp,
                color = if (focused) AuroraColors.Accent else AuroraColors.Divider,
                shape = RoundedCornerShape(10.dp),
            )
            .clickable(
                interactionSource = interaction,
                indication        = null,
                onClick           = onClick,
            ),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text  = "Sign out",
            style = AuroraTypography.Button,
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
            contentDescription = "Close settings",
            tint               = if (focused) AuroraColors.TextPrimary else AuroraColors.TextSecondary,
            modifier           = Modifier.size(20.dp),
        )
    }
}
