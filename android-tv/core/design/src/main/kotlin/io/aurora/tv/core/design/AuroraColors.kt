package io.aurora.tv.core.design

import androidx.compose.ui.graphics.Color

/**
 * Aurora Violet palette — single source of truth for colors across the TV app.
 * Values mirror `static/aurora_pro.html`'s CSS custom properties so the web,
 * TV, and future mobile clients look identical.
 *
 * TV-specific considerations baked in:
 *  - backgrounds lean darker than the web app (#0A0E17 vs potential lighter
 *    variants) because living-room viewing environments reward deep blacks
 *    and HDR-adjacent contrast
 *  - accent glow alphas are pre-computed since Compose Color doesn't have
 *    per-call alpha helpers as ergonomic as CSS rgba()
 */
object AuroraColors {
    val BgPrimary   = Color(0xFF0A0E17)
    val BgSecondary = Color(0xFF111827)
    val BgCard      = Color(0xFF1A1F2E)

    val Accent      = Color(0xFFA78BFA)   // primary violet
    val AccentBold  = Color(0xFF8B5CF6)   // hover / secondary state
    val AccentDeep  = Color(0xFF6D28D9)   // pressed / depth

    val TextPrimary   = Color(0xFFFFFFFF)
    val TextSecondary = Color(0xFF94A3B8)
    val TextMuted     = Color(0xFF64748B)

    // Derived alpha variants — named so usage sites read clearly
    val AccentGlow = Color(0xFFA78BFA).copy(alpha = 0.55f)
    val AccentSoft = Color(0xFFA78BFA).copy(alpha = 0.12f)

    val Divider = Color(0xFFFFFFFF).copy(alpha = 0.08f)
    val Scrim   = Color(0xFF000000).copy(alpha = 0.60f)
}
