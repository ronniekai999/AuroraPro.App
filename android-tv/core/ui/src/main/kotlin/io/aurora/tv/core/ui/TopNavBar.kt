package io.aurora.tv.core.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AccountCircle
import androidx.compose.material.icons.outlined.Groups
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Text
import io.aurora.tv.core.design.AuroraColors
import io.aurora.tv.core.design.AuroraDimensions

/**
 * The five navigation destinations. Each screen passes its own value as
 * `activeTab` so the bar knows which tab to mark as the current page.
 *
 * Order matters — D-pad LEFT/RIGHT traverses tabs in declaration order,
 * so shuffling reorders the visual nav. Keep "Home" first; it's the
 * leftmost tab in every TV streaming app's nav (Netflix / Plex / Apple TV).
 */
enum class NavTab(val label: String) {
    Home("Home"),
    Movies("Movies"),
    Shows("Shows"),
    MyLibrary("My Library"),
    Requests("Requests"),
}

/**
 * Top navigation bar — the chrome that sits above every signed-in surface.
 *
 *  [ Logo + AURORA ]   [ Home  Movies  Shows  My Library  Requests ]   [ ⌒ ⚙ 👤 ]
 *
 * === SHOW-ON-FOCUS, HIDE-ON-BLUR ===
 * The bar is fully visible (solid BgPrimary, full alpha) only while focus
 * lives inside it. The instant focus moves down to the hero or a poster
 * card, the bar fades out and slides up by 12dp — same chrome behavior
 * Plex Pro and Apple TV+ use on TV. The hidden bar STAYS in the focus
 * tree (alpha:0 doesn't strip focusability), so D-pad UP from any
 * content-area focusable still lands on the nearest tab, which then
 * triggers the fade-in animation. To the user it reads as "press up,
 * nav appears" — the convention every premium TV app uses.
 *
 * Implementation: `focusGroup()` + `onFocusChanged` lifts the focused-
 * state of any descendant up to the bar's container. The Box's
 * `hasFocus = it.hasFocus` lambda captures whether any tab/icon/etc.
 * is the current focused element.
 *
 * === AUTO-FOCUS THE ACTIVE TAB ===
 * Pass `autoFocusActiveTab = true` to make the bar grab initial focus
 * on screen entry, landing on the active tab. The previous-screen-was-
 * sign-in case wants this; deeper nav destinations may not.
 *
 * === FOCUS DISAMBIGUATION (active vs focused) ===
 * Two independent signals stack:
 *  - active   → 4dp violet dot beneath the label (the current page)
 *  - focused  → 1.05x scale + 8%-white pill bg (the D-pad target)
 * Active+focused = both visible at once. Critical for the cold-launch
 * case where Home is BOTH "this page" AND "where your remote is."
 */
@Composable
fun TopNavBar(
    activeTab: NavTab,
    onTabSelected: (NavTab) -> Unit,
    onWatchParty: () -> Unit,
    onSettings: () -> Unit,
    onProfile: () -> Unit,
    /**
     * Fires when the user activates the search affordance in the bar's right
     * cluster. Defaults to no-op so existing call sites compile without
     * change; AuroraNavHost wires this to `navigateToSearch` for every
     * screen that uses the bar. The actual magnifying-glass icon button
     * is added in a follow-up edit; this hook exists first so screen-level
     * pass-through wiring can land separately from the icon work.
     */
    onSearch: () -> Unit = {},
    modifier: Modifier = Modifier,
    autoFocusActiveTab: Boolean = false,
    /**
     * Optional FocusRequester that DOWN-arrow on any nav item should redirect
     * to. Without this, Compose's default spatial focus search has to find the
     * nearest focusable below the bar geometrically — which fails when the
     * bar overlays a hero where the next focusable (Watch button) is far off
     * the straight-down cone from the centered tab row. Passing an explicit
     * target makes "press DOWN on the bar → focus the hero CTA" reliable
     * regardless of layout. The screen owns the FocusRequester and attaches
     * it to whichever element should receive bar-exit focus.
     */
    downFocusRequester: FocusRequester? = null,
    /**
     * Optional externally-supplied FocusRequester that's attached to the
     * active tab. Letting the screen own this lets it ALSO use the same
     * requester as the `up` target on hero CTAs — pressing UP from Watch
     * or More info routes directly back to the active tab, regardless of
     * what spatial focus search would otherwise pick.
     */
    activeTabFocusRequester: FocusRequester? = null,
    /**
     * Fires when the bar's visibility changes. Screens use this to coordinate
     * surrounding layout — e.g., HomeScreen animates its LazyColumn's
     * top contentPadding so the hero is pushed below the bar (rather than
     * occluded by it) whenever the bar is visible.
     */
    onVisibilityChange: (Boolean) -> Unit = {},
) {
    // True iff any descendant (any tab, any icon) currently has focus.
    // Initialized to autoFocusActiveTab so that on cold launch with
    // autoFocus=true, the bar starts visible — the LaunchedEffect in
    // NavTabItem will request focus on the next frame, and onFocusChanged
    // will confirm the state.
    var hasFocus by remember { mutableStateOf(autoFocusActiveTab) }

    // Forward visibility changes to the hosting screen so it can coordinate
    // surrounding layout (e.g., LazyColumn contentPadding for the hero shift).
    // LaunchedEffect keys on hasFocus, so this fires once per real change —
    // not once per recomposition.
    LaunchedEffect(hasFocus) { onVisibilityChange(hasFocus) }

    val alpha by animateFloatAsState(
        targetValue   = if (hasFocus) 1f else 0f,
        animationSpec = tween(durationMillis = 200),
        label = "nav-alpha",
    )
    val offsetY by animateDpAsState(
        targetValue   = if (hasFocus) 0.dp else (-12).dp,
        animationSpec = tween(durationMillis = 200),
        label = "nav-offset",
    )

    Box(
        modifier = modifier
            .fillMaxWidth()
            .height(64.dp)
            .offset(y = offsetY)
            .alpha(alpha)
            // Solid bar — explicit BgPrimary so the bar reads as its own
            // surface, distinct from the hero gradient beneath it.
            .background(AuroraColors.BgPrimary)
            // focusGroup() is required for onFocusChanged to fire reliably
            // for DESCENDANT focus changes — without it, the bar's outer Box
            // has no node in the focus tree, and the lambda below latches to
            // its initial value. The down-trap that this previously caused
            // is now solved by the explicit `focusProperties { down = ... }`
            // on each NavTabItem and NavIconButton; focusGroup's "search
            // within group first" preference is overridden by the explicit
            // requester so DOWN exits cleanly to Watch.
            .focusGroup()
            .onFocusChanged { hasFocus = it.hasFocus },
    ) {
        // LEFT — logo block
        AuroraLogoBlock(
            modifier = Modifier
                .align(Alignment.CenterStart)
                .padding(start = AuroraDimensions.SafeAreaHorizontal),
        )

        // CENTER — tab row
        Row(
            modifier              = Modifier.align(Alignment.Center),
            horizontalArrangement = Arrangement.spacedBy(20.dp),
            verticalAlignment     = Alignment.CenterVertically,
        ) {
            NavTab.entries.forEach { tab ->
                val isActive = tab == activeTab
                NavTabItem(
                    label                  = tab.label,
                    active                 = isActive,
                    autoFocus              = autoFocusActiveTab && isActive,
                    onClick                = { onTabSelected(tab) },
                    downFocusRequester     = downFocusRequester,
                    // Only the ACTIVE tab takes the external requester —
                    // that's the one screens want UP to land on.
                    externalFocusRequester = if (isActive) activeTabFocusRequester else null,
                )
            }
        }

        // RIGHT — icon buttons
        Row(
            modifier = Modifier
                .align(Alignment.CenterEnd)
                .padding(end = AuroraDimensions.SafeAreaHorizontal),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
            verticalAlignment     = Alignment.CenterVertically,
        ) {
            NavIconButton(
                icon               = Icons.Outlined.Search,
                contentDescription = "Search",
                onClick            = onSearch,
                downFocusRequester = downFocusRequester,
            )
            NavIconButton(
                icon               = Icons.Outlined.Groups,
                contentDescription = "Watch Party",
                onClick            = onWatchParty,
                downFocusRequester = downFocusRequester,
            )
            NavIconButton(
                icon               = Icons.Outlined.Settings,
                contentDescription = "Settings",
                onClick            = onSettings,
                downFocusRequester = downFocusRequester,
            )
            NavIconButton(
                icon               = Icons.Outlined.AccountCircle,
                contentDescription = "Profile",
                onClick            = onProfile,
                downFocusRequester = downFocusRequester,
            )
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Left block — Aurora mark + AURORA wordmark
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun AuroraLogoBlock(modifier: Modifier = Modifier) {
    Row(
        modifier          = modifier,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        AuroraMark(size = 28.dp)
        Spacer(Modifier.width(10.dp))
        Text(
            text  = "AURORA",
            style = TextStyle(
                fontSize      = 16.sp,
                fontWeight    = FontWeight.Bold,
                letterSpacing = 0.20.em,
            ),
            color = AuroraColors.TextPrimary,
        )
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tab item — text + active dot indicator below + autoFocus support
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun NavTabItem(
    label: String,
    active: Boolean,
    onClick: () -> Unit,
    autoFocus: Boolean = false,
    downFocusRequester: FocusRequester? = null,
    externalFocusRequester: FocusRequester? = null,
) {
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    val localRequester = remember { FocusRequester() }
    // Prefer the external requester when provided so the hosting screen can
    // route UP-arrows from elsewhere directly to this tab's node.
    val requester = externalFocusRequester ?: localRequester
    if (autoFocus) {
        LaunchedEffect(Unit) { requester.requestFocus() }
    }

    val scale by animateFloatAsState(
        targetValue = if (focused) 1.05f else 1f,
        label = "tab-scale",
    )
    val textColor by animateColorAsState(
        targetValue = when {
            focused || active -> AuroraColors.TextPrimary
            else              -> AuroraColors.TextSecondary
        },
        label = "tab-text",
    )
    val bgAlpha by animateFloatAsState(
        targetValue = if (focused) 0.08f else 0f,
        label = "tab-bg",
    )
    // Dot follows FOCUS, not active state. Reasoning: while we technically
    // know which page is "active" (the screen the user is on), users don't
    // need a separate visual marker for that — they know what page they're
    // on from what's rendered below the bar. The dot's job is "your D-pad
    // is right here." This matches Apple TV+ / Disney+ / Netflix-on-TV;
    // they don't decorate inactive-but-current-page tabs differently from
    // inactive-non-current-page tabs. With multiple destinations we may
    // revisit and add a separate active-page mark, but for Phase 0 this
    // is the cleaner contract.
    val dotAlpha by animateFloatAsState(
        targetValue = if (focused) 1f else 0f,
        label = "tab-dot",
    )

    Column(
        modifier = Modifier
            .focusRequester(requester)
            // Explicit DOWN routing — the central reason this tab is reachable
            // FROM below is spatial nav; the central reason DOWN works AT ALL
            // is this line. Without it, Compose's spatial search can't find
            // the hero CTA across the overlay layer.
            .then(
                if (downFocusRequester != null) {
                    Modifier.focusProperties { down = downFocusRequester }
                } else Modifier
            )
            .scale(scale)
            .clip(RoundedCornerShape(999.dp))
            .background(Color.White.copy(alpha = bgAlpha))
            .clickable(
                interactionSource = interaction,
                indication        = null,
                onClick           = onClick,
            )
            .padding(horizontal = 14.dp, vertical = 6.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text  = label,
            style = TextStyle(
                fontSize   = 16.sp,
                fontWeight = FontWeight.SemiBold,
            ),
            color = textColor,
        )
        Spacer(Modifier.height(4.dp))
        Box(
            modifier = Modifier
                .size(4.dp)
                .clip(CircleShape)
                .background(AuroraColors.Accent.copy(alpha = dotAlpha)),
        )
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Icon button — circular focusable Box wrapping the icon glyph
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun NavIconButton(
    icon: ImageVector,
    contentDescription: String,
    onClick: () -> Unit,
    downFocusRequester: FocusRequester? = null,
) {
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()

    val scale by animateFloatAsState(
        targetValue = if (focused) 1.10f else 1f,
        label = "icon-scale",
    )
    val tint by animateColorAsState(
        targetValue = if (focused) AuroraColors.TextPrimary else AuroraColors.TextSecondary,
        label = "icon-tint",
    )
    val bgAlpha by animateFloatAsState(
        targetValue = if (focused) 0.18f else 0f,
        label = "icon-bg",
    )

    Box(
        modifier = Modifier
            .size(40.dp)
            // Same explicit DOWN routing as NavTabItem — every focusable in
            // the bar needs it, otherwise pressing DOWN on Settings (etc.)
            // would still be trapped even if Home worked.
            .then(
                if (downFocusRequester != null) {
                    Modifier.focusProperties { down = downFocusRequester }
                } else Modifier
            )
            .scale(scale)
            .clip(CircleShape)
            .background(AuroraColors.Accent.copy(alpha = bgAlpha))
            .clickable(
                interactionSource = interaction,
                indication        = null,
                onClick           = onClick,
            ),
        contentAlignment = Alignment.Center,
    ) {
        Image(
            imageVector        = icon,
            contentDescription = contentDescription,
            colorFilter        = ColorFilter.tint(tint),
            modifier           = Modifier.size(22.dp),
        )
    }
}
