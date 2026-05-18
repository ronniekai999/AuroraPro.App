package io.aurora.tv.core.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Text
import io.aurora.tv.core.design.AuroraColors
import io.aurora.tv.core.design.AuroraTypography

/**
 * Shared TV-friendly filter dropdown. A focusable button rendered as
 * `Label: Value ▾` that opens a `FilterMenu` overlay anchored beneath
 * the trigger.
 *
 * Promoted from MoviesScreen so MoviesScreen and ShowsScreen consume one
 * canonical primitive. The button + popup are wrapped in a single Box so
 * the popup anchors to the trigger's position.
 *
 * Focus contract:
 *  - `externalFocusRequester` is bound to the trigger so the parent can
 *    route DOWN-from-nav-bar to the first filter button.
 *  - `upFocusRequester` is wired via `focusProperties { up = … }` so
 *    pressing UP from the trigger lands on the active nav tab.
 *  - On menu dismiss, focus is restored to the trigger so D-pad nav
 *    resumes from a sensible anchor instead of falling into the grid.
 */
@Composable
fun <T> FilterDropdown(
    label: String,
    value: String,
    options: List<T>,
    selected: T,
    labelOf: (T) -> String,
    onSelected: (T) -> Unit,
    externalFocusRequester: FocusRequester? = null,
    upFocusRequester: FocusRequester? = null,
) {
    var expanded by remember { mutableStateOf(false) }
    val triggerFocusRequester = remember { FocusRequester() }
    val requester = externalFocusRequester ?: triggerFocusRequester

    // Measure the trigger's actual rendered height so the popup positions
    // itself just below it, regardless of font scale or padding tweaks.
    // Earlier impl hard-coded `offset(y = 46.dp)` assuming a ~38dp trigger;
    // at Android TV's 1.5x accessibility font scale the trigger grows to
    // ~54dp and the menu would overlap the trigger by ~8dp. Measuring
    // makes it robust.
    var triggerHeightPx by remember { mutableIntStateOf(0) }
    val density = LocalDensity.current
    val anchorYOffset = with(density) { triggerHeightPx.toDp() } + 6.dp

    Box {
        FilterButton(
            label            = label,
            value            = value,
            onClick          = { expanded = true },
            focusRequester   = requester,
            upFocusRequester = upFocusRequester,
            modifier         = Modifier.onGloballyPositioned { coords ->
                triggerHeightPx = coords.size.height
            },
        )
        FilterMenu(
            expanded         = expanded,
            options          = options,
            selected         = selected,
            labelOf          = labelOf,
            onSelected       = onSelected,
            anchorYOffset    = anchorYOffset,
            onDismissRequest = {
                expanded = false
                // Return focus to the trigger so D-pad nav resumes from a
                // sensible anchor instead of the bar / first item in the
                // grid. requestFocus is safe even if focus is elsewhere.
                try { requester.requestFocus() } catch (_: Throwable) { /* ignore */ }
            },
        )
    }
}

/**
 * Bare filter trigger button — `Label: Value ▾` with focus-driven border
 * and background animation. Exposed alongside `FilterDropdown` for callers
 * that want the visual without the menu wiring (e.g. read-only displays
 * or screens with bespoke popup logic).
 */
@Composable
fun FilterButton(
    label: String,
    value: String,
    onClick: () -> Unit,
    focusRequester: FocusRequester,
    upFocusRequester: FocusRequester? = null,
    modifier: Modifier = Modifier,
) {
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()

    val borderAlpha by animateFloatAsState(
        targetValue = if (focused) 0.85f else 0.30f,
        label = "filter-border",
    )
    val bgAlpha by animateFloatAsState(
        targetValue = if (focused) 0.10f else 0.04f,
        label = "filter-bg",
    )
    val labelColor by animateColorAsState(
        targetValue = if (focused) AuroraColors.TextPrimary else AuroraColors.TextSecondary,
        label = "filter-label",
    )

    Row(
        // Caller modifier is applied first so Modifier.onGloballyPositioned
        // measures the entire button (including padding). Internal modifiers
        // for visual styling apply on top.
        modifier = modifier
            .clip(RoundedCornerShape(8.dp))
            .background(Color.White.copy(alpha = bgAlpha))
            .border(
                width = 1.dp,
                color = Color.White.copy(alpha = borderAlpha),
                shape = RoundedCornerShape(8.dp),
            )
            .focusRequester(focusRequester)
            .then(
                if (upFocusRequester != null) {
                    Modifier.focusProperties { up = upFocusRequester }
                } else Modifier
            )
            .clickable(
                interactionSource = interaction,
                indication        = null,
                onClick           = onClick,
            )
            .padding(horizontal = 14.dp, vertical = 9.dp),
        verticalAlignment     = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            text  = "$label:",
            style = AuroraTypography.Body,
            color = labelColor,
        )
        Text(
            text  = value,
            style = TextStyle(
                fontSize   = 14.sp,
                fontWeight = FontWeight.SemiBold,
            ),
            color = AuroraColors.TextPrimary,
        )
        Image(
            imageVector        = Icons.Filled.ArrowDropDown,
            contentDescription = null,
            colorFilter        = ColorFilter.tint(AuroraColors.TextSecondary),
            modifier           = Modifier.size(18.dp),
        )
    }
}
