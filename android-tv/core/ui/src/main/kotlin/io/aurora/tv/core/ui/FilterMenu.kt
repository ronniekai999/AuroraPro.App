package io.aurora.tv.core.ui

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
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.foundation.layout.offset
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupProperties
import androidx.tv.material3.Text
import io.aurora.tv.core.design.AuroraColors

/**
 * TV-friendly dropdown menu rendered as a Popup overlay anchored to its
 * trigger. Used by Movies/Shows filter buttons.
 *
 * D-pad grammar:
 *  - UP/DOWN walks the option list (Compose's default focus search handles
 *    this since each item is `clickable`).
 *  - SELECT (Enter / D-pad center) chooses the highlighted option, calls
 *    `onSelected`, and dismisses.
 *  - BACK closes the menu without selecting (handled via `Popup`'s
 *    `onDismissRequest` + an explicit Back-key listener for D-pad remotes
 *    that don't always route Back through onDismissRequest).
 *
 * The first-rendered item auto-focuses on open so the user can immediately
 * D-pad through options without fishing for focus.
 *
 * Visual styling mirrors FilterButton / FocusableCard: rounded card with
 * AuroraColors.Accent border on the focused item, AccentSoft tint on the
 * currently-selected option, bold label on focus.
 */
/**
 * @param anchorYOffset Distance below the parent composable's top-left at
 *   which the popup is rendered. Callers should pass the measured trigger
 *   height plus a small visual gap (~6dp). Default of 46dp is kept only as
 *   a safety net for callers that don't measure — at default font scale on
 *   FilterButton this clears the trigger, but at accessibility font scales
 *   the trigger grows past the default and the menu would overlap. Always
 *   prefer measuring.
 */
@Composable
fun <T> FilterMenu(
    expanded: Boolean,
    options: List<T>,
    selected: T,
    labelOf: (T) -> String,
    onSelected: (T) -> Unit,
    onDismissRequest: () -> Unit,
    modifier: Modifier = Modifier,
    anchorYOffset: Dp = 46.dp,
) {
    if (!expanded) return

    val firstItemFocusRequester = remember { FocusRequester() }

    Popup(
        // Popup anchors to the position of the *parent composable*. Callers
        // wrap this in a Box that also contains the trigger, so the popup
        // origin is the trigger's top-left. We shift down by the trigger's
        // measured height (passed in via anchorYOffset) so the menu visually
        // drops beneath the button regardless of font scale or padding
        // tweaks. See the docstring above for why measuring matters.
        onDismissRequest = onDismissRequest,
        properties = PopupProperties(
            focusable             = true,
            dismissOnBackPress    = true,
            dismissOnClickOutside = true,
        ),
    ) {
        // LazyColumn (not plain Column) so we can scroll long option lists
        // — Year has ~130 entries (1900–2030), Genre has 18, and a fixed-
        // shape Column would render past the screen bottom and clip. With
        // LazyColumn + heightIn(max), the popup caps at 480dp (~12 visible
        // rows) and scrolls the rest. LazyColumn also only materializes
        // visible items, which keeps the year-range case cheap.
        LazyColumn(
            modifier = modifier
                .offset(y = anchorYOffset)
                .width(220.dp)
                // 480dp ≈ 12 rows of 40dp each. Big enough to feel like a
                // full menu on default font; small enough to never exceed
                // a 540p TV viewport's lower half. The Popup itself is
                // free to size to its content; this constrains the
                // LazyColumn's intrinsic height so it stops at this cap.
                .heightIn(max = 480.dp)
                .shadow(elevation = 16.dp, shape = RoundedCornerShape(10.dp))
                .clip(RoundedCornerShape(10.dp))
                .background(AuroraColors.BgCard)
                .border(
                    width = 1.dp,
                    color = Color.White.copy(alpha = 0.15f),
                    shape = RoundedCornerShape(10.dp),
                )
                .onPreviewKeyEvent { ev ->
                    // Some TV remotes emit Back as Esc; route both to dismiss.
                    if (ev.type == KeyEventType.KeyUp &&
                        (ev.key == Key.Back || ev.key == Key.Escape)
                    ) {
                        onDismissRequest()
                        true
                    } else false
                },
            verticalArrangement = Arrangement.spacedBy(2.dp),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(vertical = 6.dp),
        ) {
            // Defensive null skip on `option`. The generic type T is non-
            // null at the API surface, but JVM erasure means the runtime
            // List<T> could in theory contain a null (e.g. if a caller's
            // sealed-class companion `options` list captures null at init
            // time — a known Kotlin gotcha; see MoviesContent.kt's
            // Genre.Companion docstring). Skipping nulls keeps the popup
            // alive instead of crashing the screen on the labelOf NPE.
            itemsIndexed(items = options) { index, option ->
                if (option != null) {
                    FilterMenuItem(
                        label    = labelOf(option),
                        selected = option == selected,
                        onClick  = {
                            onSelected(option)
                            onDismissRequest()
                        },
                        focusRequester = if (index == 0) firstItemFocusRequester else null,
                    )
                }
            }
        }
    }

    // Focus the first item once the popup composes.
    //
    // Earlier impl assumed Compose would re-attempt focus once the
    // requester was bound — that's NOT how FocusRequester.requestFocus()
    // behaves. If the requester isn't attached to a node yet, the call
    // throws IllegalStateException and is silently lost; there's no retry.
    //
    // The popup's content composes asynchronously relative to FilterMenu's
    // composition, so on slow devices / first launch the LaunchedEffect
    // can fire before the first item's `Modifier.focusRequester(...)` has
    // bound its node. The result is a popup that opens unfocused, and
    // the user has to D-pad-down to engage.
    //
    // Waiting one frame via `withFrameNanos` reliably lets the popup's
    // composition + layout pass complete before we request focus. The
    // try/catch stays as a defense against the rare case where the user
    // dismisses the popup mid-frame, which would unbind the requester.
    LaunchedEffect(expanded) {
        if (expanded) {
            withFrameNanos { /* one frame elapsed; popup contents are bound */ }
            try { firstItemFocusRequester.requestFocus() } catch (_: Throwable) { /* dismissed mid-frame */ }
        }
    }
}

@Composable
private fun FilterMenuItem(
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    focusRequester: FocusRequester?,
) {
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()

    val bgAlpha by animateFloatAsState(
        targetValue = when {
            focused  -> 0.18f
            selected -> 0.10f
            else     -> 0.0f
        },
        label = "menu-item-bg",
    )
    val labelColor by animateColorAsState(
        targetValue = if (focused || selected) AuroraColors.TextPrimary else AuroraColors.TextSecondary,
        label = "menu-item-label",
    )

    Box(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 6.dp)
            .clip(RoundedCornerShape(6.dp))
            .background(AuroraColors.Accent.copy(alpha = bgAlpha))
            .border(
                width = if (focused) 1.dp else 0.dp,
                color = if (focused) AuroraColors.Accent else Color.Transparent,
                shape = RoundedCornerShape(6.dp),
            )
            .then(if (focusRequester != null) Modifier.focusRequester(focusRequester) else Modifier)
            .clickable(
                interactionSource = interaction,
                indication        = null,
                onClick           = onClick,
            )
            .padding(horizontal = 12.dp, vertical = 10.dp),
    ) {
        Row(
            verticalAlignment     = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            modifier              = Modifier.fillMaxWidth(),
        ) {
            // Selected dot — tiny accent pip on the left so users see the
            // current value at a glance even before D-padding.
            Box(
                modifier = Modifier
                    .size(6.dp)
                    .clip(RoundedCornerShape(3.dp))
                    .background(
                        if (selected) AuroraColors.Accent else Color.Transparent
                    ),
            )
            Text(
                text  = label,
                style = TextStyle(
                    fontSize   = 14.sp,
                    fontWeight = if (focused || selected) FontWeight.SemiBold else FontWeight.Normal,
                ),
                color = labelColor,
            )
        }
    }
}

