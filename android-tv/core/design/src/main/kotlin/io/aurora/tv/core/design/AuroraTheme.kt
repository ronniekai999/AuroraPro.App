package io.aurora.tv.core.design

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.darkColorScheme

/**
 * Compose-for-TV theme entry point. Wraps androidx.tv.material3.MaterialTheme
 * so children can use TV-specific Material primitives (Button, ListItem, etc.)
 * while also exposing Aurora's custom tokens via CompositionLocals.
 *
 * Using tv-material3 (not regular material3): the TV variant has focus-aware
 * component state handling built in — e.g. Button reacts to D-pad focus
 * without per-site Modifier.onFocusChanged wiring.
 *
 * Note: tv-material3 is still in alpha at the time of scaffolding; API
 * surface may shift. All tv-material3 APIs are quarantined to this module.
 */
@Composable
fun AuroraTheme(content: @Composable () -> Unit) {
    val colors = darkColorScheme(
        primary              = AuroraColors.Accent,
        onPrimary            = AuroraColors.BgPrimary,
        primaryContainer     = AuroraColors.AccentDeep,
        onPrimaryContainer   = AuroraColors.TextPrimary,
        secondary            = AuroraColors.AccentBold,
        onSecondary          = AuroraColors.TextPrimary,
        background           = AuroraColors.BgPrimary,
        onBackground         = AuroraColors.TextPrimary,
        surface              = AuroraColors.BgCard,
        onSurface            = AuroraColors.TextPrimary,
        surfaceVariant       = AuroraColors.BgSecondary,
        onSurfaceVariant     = AuroraColors.TextSecondary,
        border               = AuroraColors.Divider,
        borderVariant        = AuroraColors.Divider,
    )

    MaterialTheme(colorScheme = colors) {
        CompositionLocalProvider(
            LocalAuroraTypography provides AuroraTypography,
            LocalAuroraDimensions provides AuroraDimensions,
            LocalAuroraShapes     provides AuroraShapes,
            content = content,
        )
    }
}

val LocalAuroraTypography = staticCompositionLocalOf<AuroraTypography> { AuroraTypography }
val LocalAuroraDimensions = staticCompositionLocalOf<AuroraDimensions> { AuroraDimensions }
val LocalAuroraShapes     = staticCompositionLocalOf<AuroraShapes>     { AuroraShapes }
