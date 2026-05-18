package io.aurora.tv.core.auth.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateDpAsState
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
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.tv.material3.Text
import io.aurora.tv.core.auth.AuthState
import io.aurora.tv.core.design.AuroraColors
import io.aurora.tv.core.design.AuroraDimensions
import io.aurora.tv.core.design.AuroraTypography
import io.aurora.tv.core.ui.AuroraMark
import io.aurora.tv.core.ui.PhaseZeroBadge
import io.aurora.tv.core.ui.auroraBackdrop

/**
 * Sign-in screen — first screen users see on cold start when no valid
 * credentials exist.
 *
 * === DESIGN INTENT ===
 * This screen has to feel like Aurora, not like a generic settings dialog.
 * First-run is the single strongest brand moment of the app — if users feel
 * "oh this is just another self-hosted media client" here, we've lost them
 * before the first poster even loads.
 *
 * Layered construction, back to front:
 *   1. AuroraBackdrop     — painted radial glows (violet + teal) on bg-primary,
 *                           evoking the actual aurora phenomenon
 *   2. Two-column Row     — branding panel (left) + form panel (right)
 *   3. BrandPanel         — Aurora mark + large wordmark + tagline
 *   4. FormPanel          — fields with violet focus-ring, filled Aurora CTA
 *   5. PhaseZeroBadge     — corner ribbon so users know this is stubbed auth
 *
 * Focus lands on the Server URL field automatically (autoFocus=true).
 * D-pad flow is vertical within the form, then to the Sign In button.
 *
 * === PHASE 0 AUTH NOTE ===
 * SignInViewModel.submit() currently just delays 600ms and saves stub tokens.
 * Any non-empty values will "succeed" and navigate to the profile picker.
 * Real POST /api/v1/auth/login wiring is the first P1 ticket.
 */
@Composable
fun SignInScreen(
    onSignedIn: () -> Unit,
    viewModel: SignInViewModel = hiltViewModel(),
) {
    val form  by viewModel.form.collectAsStateWithLifecycle()
    val state by viewModel.state.collectAsStateWithLifecycle()

    LaunchedEffect(state) {
        if (state is AuthState.SignedIn) onSignedIn()
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .auroraBackdrop(),
    ) {
        PhaseZeroBadge(
            modifier = Modifier
                .align(Alignment.TopEnd)
                .padding(top = 20.dp, end = 24.dp),
        )

        Row(
            modifier = Modifier
                .fillMaxSize()
                .padding(
                    horizontal = AuroraDimensions.SafeAreaHorizontal,
                    vertical   = AuroraDimensions.SafeAreaVertical,
                ),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            BrandPanel(
                modifier = Modifier
                    .weight(0.42f)
                    .fillMaxHeight(),
            )
            Spacer(Modifier.width(40.dp))
            FormPanel(
                form       = form,
                state      = state,
                onServer   = viewModel::updateServer,
                onUsername = viewModel::updateUsername,
                onPassword = viewModel::updatePassword,
                onSubmit   = viewModel::submit,
                modifier   = Modifier
                    .weight(0.58f)
                    .fillMaxHeight(),
            )
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Backdrop & Phase-0 badge moved to core:ui — see AuroraBackdrop.kt and
// PhaseZeroBadge.kt. Both are reused on every full-screen Phase-0 surface so
// the app reads as a single visual composition.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Brand panel (left)
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun BrandPanel(modifier: Modifier = Modifier) {
    Column(
        modifier = modifier,
        verticalArrangement = Arrangement.Center,
    ) {
        // Glowing mark — radial halo behind the AuroraMark via drawBehind.
        // Sized for the real 540dp-tall Android TV viewport, not the 1080dp
        // HTML mockup.
        Box(contentAlignment = Alignment.Center, modifier = Modifier.size(104.dp)) {
            Box(
                modifier = Modifier
                    .size(104.dp)
                    .drawBehind {
                        drawCircle(
                            brush = Brush.radialGradient(
                                0f to AuroraColors.Accent.copy(alpha = 0.55f),
                                1f to Color.Transparent,
                            ),
                            radius = size.maxDimension * 0.7f,
                        )
                    },
            )
            AuroraMark(size = 72.dp)
        }

        // 12dp (was 20) — pulls the wordmark group up toward the mark so the
        // panel reads as a single composition rather than two stacks with air
        // between them.
        Spacer(Modifier.height(12.dp))

        // Letter-spaced kicker — the "A · U · R · O · R · A" we use on web
        Text(
            text  = "A · U · R · O · R · A",
            style = TextStyle(
                fontSize      = 12.sp,
                fontWeight    = FontWeight.SemiBold,
                letterSpacing = 0.42.em,
            ),
            color = AuroraColors.Accent,
        )

        // 6dp (was 10) — kicker belongs visually to the heading, not as a
        // separate row. Tighter gap groups them.
        Spacer(Modifier.height(6.dp))

        // Brand statement — 2 short lines. At 40sp this reads huge from the
        // couch without needing the full 56sp we were using (which wrapped
        // "Cinematic. Yours." onto its own second line anyway).
        Text(
            text  = "Your media.",
            style = TextStyle(
                fontSize      = 40.sp,
                fontWeight    = FontWeight.Bold,
                letterSpacing = (-0.02).em,
                lineHeight    = 44.sp,
            ),
            color = AuroraColors.TextPrimary,
        )
        Text(
            text  = "Cinematic. Yours.",
            style = TextStyle(
                fontSize      = 40.sp,
                fontWeight    = FontWeight.Bold,
                letterSpacing = (-0.02).em,
                lineHeight    = 44.sp,
            ),
            color = AuroraColors.Accent,
        )

        Spacer(Modifier.height(16.dp))

        // One-line tagline — short enough to never wrap in the 42% column.
        Text(
            text  = "Stream what's yours, the way it should look.",
            style = AuroraTypography.Body,
            color = AuroraColors.TextSecondary,
        )
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Form panel (right)
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun FormPanel(
    form: SignInForm,
    state: AuthState,
    onServer: (String) -> Unit,
    onUsername: (String) -> Unit,
    onPassword: (String) -> Unit,
    onSubmit: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier,
        verticalArrangement = Arrangement.Center,
    ) {
        // Card container — subtle violet-tinted panel. Sized for a 432dp
        // vertical budget (540dp viewport minus 2 × 27dp safe area and a
        // little breathing room).
        Column(
            modifier = Modifier
                .widthIn(max = 460.dp)
                .clip(RoundedCornerShape(18.dp))
                .background(AuroraColors.BgCard.copy(alpha = 0.78f))
                // Top-edge highlight via a vertical-gradient stroke. The
                // first 4% of the Y axis is white-alpha, the rest is the
                // flat Divider color — so the light catch lives exactly on
                // the top edge, not the sides. Cheaper than a separate
                // drawWithContent layer and uses Compose's existing border
                // machinery for rounded-rect corner handling.
                .border(
                    width = 1.dp,
                    brush = Brush.verticalGradient(
                        0f    to Color.White.copy(alpha = 0.14f),
                        0.04f to AuroraColors.Divider,
                        1f    to AuroraColors.Divider,
                    ),
                    shape = RoundedCornerShape(18.dp),
                )
                .padding(horizontal = 28.dp, vertical = 24.dp),
        ) {
            Text(
                text = "Sign in to your server",
                style = AuroraTypography.RowTitle,   // 22sp instead of 28sp
                color = AuroraColors.TextPrimary,
            )
            Spacer(Modifier.height(4.dp))
            Text(
                text = "Point Aurora TV at your server to begin.",
                style = AuroraTypography.Body,
                color = AuroraColors.TextSecondary,
            )

            Spacer(Modifier.height(18.dp))

            AuroraField(
                label        = "Server URL",
                value        = form.serverUrl,
                onValueChange = onServer,
                keyboardType = KeyboardType.Uri,
                autoFocus    = true,
                placeholder  = "https://aurora.local:8443",
            )
            Spacer(Modifier.height(10.dp))
            AuroraField(
                label        = "Username",
                value        = form.username,
                onValueChange = onUsername,
                keyboardType = KeyboardType.Text,
                placeholder  = "admin",
            )
            Spacer(Modifier.height(10.dp))
            AuroraField(
                label        = "Password",
                value        = form.password,
                onValueChange = onPassword,
                keyboardType = KeyboardType.Password,
                isPassword   = true,
                imeAction    = ImeAction.Done,
                placeholder  = "your password",
            )

            Spacer(Modifier.height(18.dp))

            AuroraPrimaryButton(
                label = when (state) {
                    is AuthState.Authenticating -> "Signing in…"
                    else -> "Sign In"
                },
                enabled = state !is AuthState.Authenticating,
                onClick = onSubmit,
            )

            (state as? AuthState.Failed)?.reason?.let { msg ->
                Spacer(Modifier.height(10.dp))
                Text(
                    text  = msg,
                    color = Color(0xFFF87171),
                    style = AuroraTypography.Body,
                )
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Field with animated focus ring
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun AuroraField(
    label: String,
    value: String,
    onValueChange: (String) -> Unit,
    keyboardType: KeyboardType,
    isPassword: Boolean = false,
    autoFocus: Boolean = false,
    imeAction: ImeAction = ImeAction.Next,
    placeholder: String? = null,
) {
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    val requester = remember { FocusRequester() }

    if (autoFocus) {
        LaunchedEffect(Unit) { requester.requestFocus() }
    }

    // Animated border color + thickness — "focus is state" (P2 from the build
    // plan) applied to a form input. We widen the delta from both ends:
    // focused goes to 2.5dp (was 2dp) and unfocused drops to 40% alpha on the
    // divider color. Bigger visual gap between the two states so a user
    // correcting a typo can tell at a glance which field their keyboard is on.
    val borderColor by animateColorAsState(
        targetValue = if (focused) AuroraColors.Accent else AuroraColors.Divider.copy(alpha = 0.4f),
        label = "field-border-color",
    )
    val borderWidth by animateDpAsState(
        targetValue = if (focused) 2.5.dp else 1.dp,
        label = "field-border-width",
    )

    Column(modifier = Modifier.fillMaxWidth()) {
        Text(
            text = label,
            style = AuroraTypography.Caption,
            color = if (focused) AuroraColors.Accent else AuroraColors.TextMuted,
            modifier = Modifier.padding(bottom = 5.dp, start = 2.dp),
        )
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(10.dp))
                .background(AuroraColors.BgPrimary.copy(alpha = 0.55f))
                .border(borderWidth, borderColor, RoundedCornerShape(10.dp))
                .padding(horizontal = 14.dp, vertical = 11.dp),
        ) {
            BasicTextField(
                value = value,
                onValueChange = onValueChange,
                singleLine = true,
                textStyle = TextStyle(
                    color    = AuroraColors.TextPrimary,
                    fontSize = 16.sp,
                ),
                cursorBrush = SolidColor(AuroraColors.Accent),
                keyboardOptions = KeyboardOptions(keyboardType = keyboardType, imeAction = imeAction),
                visualTransformation = if (isPassword) PasswordVisualTransformation() else VisualTransformation.None,
                interactionSource = interaction,
                modifier = Modifier
                    .focusRequester(requester)
                    .fillMaxWidth(),
                // decorationBox is Compose's official hook for overlay content
                // on a BasicTextField — unlike a stacked Box around the field,
                // it preserves cursor/IME routing exactly. The placeholder is
                // rendered as a sibling of innerTextField() inside a Box, so
                // they occupy the same cell; the placeholder disappears the
                // moment value becomes non-empty (recomposes on every edit).
                decorationBox = { innerTextField ->
                    Box {
                        if (value.isEmpty() && placeholder != null) {
                            Text(
                                text  = placeholder,
                                color = AuroraColors.TextMuted.copy(alpha = 0.55f),
                                style = TextStyle(fontSize = 16.sp),
                            )
                        }
                        innerTextField()
                    }
                },
            )
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Primary brand button
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun AuroraPrimaryButton(
    label: String,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    // === WHY THIS IS NOT `androidx.tv.material3.Button` ===
    // Material's Button exposes content as a RowScope with Arrangement.Start
    // (so text glues left), accepts only a Color for containerColor (so no
    // gradient fill), and renders Glow behind its own container (which
    // flattens against our backdrop). All three are deal-breakers for the
    // first-run CTA. Building the surface ourselves gets us: centered label,
    // gradient fill, and a violet-tinted platform shadow that reads from 10ft.
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    val active = focused && enabled

    // Scale lean — 1.045 matches the focus-scale we use on poster cards so
    // every focusable surface leans the same amount (P2 "focus is state").
    val scale by animateFloatAsState(
        targetValue = if (active) 1.045f else 1f,
        label = "cta-scale",
    )
    // Shadow depth — tinted violet via graphicsLayer below. Higher elevation
    // on focus gives the "lifting off the mat" feel real buttons have.
    val elevation by animateDpAsState(
        targetValue = if (active) 22.dp else 6.dp,
        label = "cta-elevation",
    )

    // Two gradients, same hue family. Unfocused is the deeper, denser violet
    // so the button "sits"; focused is brighter and shifts the gradient axis
    // just enough that the surface reads as re-lit, not re-colored.
    val fill = when {
        active   -> Brush.linearGradient(
            0f to AuroraColors.Accent,
            1f to AuroraColors.AccentBold,
        )
        enabled  -> Brush.linearGradient(
            0f to AuroraColors.AccentBold,
            1f to AuroraColors.AccentDeep,
        )
        else     -> Brush.linearGradient(
            0f to AuroraColors.AccentBold.copy(alpha = 0.40f),
            1f to AuroraColors.AccentDeep.copy(alpha = 0.40f),
        )
    }

    val shape = RoundedCornerShape(14.dp)

    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(52.dp)
            .graphicsLayer {
                scaleX             = scale
                scaleY             = scale
                shadowElevation    = elevation.toPx()
                this.shape         = shape
                clip               = false               // let shadow spill past bounds
                ambientShadowColor = AuroraColors.Accent // API 28+, our minSdk
                spotShadowColor    = AuroraColors.Accent
            }
            .background(brush = fill, shape = shape)
            .then(
                // White inner ring on focus — the affordance that says
                // "this one is live" when the remote lands. 0.55 alpha so it
                // reads as a highlight, not a hard stroke.
                if (active) {
                    Modifier.border(
                        width = 1.5.dp,
                        color = Color.White.copy(alpha = 0.55f),
                        shape = shape,
                    )
                } else Modifier
            )
            .clickable(
                interactionSource = interaction,
                indication        = null,              // our scale+gradient IS the indication
                enabled           = enabled,
                onClick           = onClick,
            ),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text  = label,
            style = AuroraTypography.Button.copy(fontSize = 16.sp),
            color = Color.White.copy(alpha = if (enabled) 1f else 0.6f),
        )
    }
}

// PhaseZeroBadge moved to io.aurora.tv.core.ui.PhaseZeroBadge.

