package io.aurora.tv.core.design

import androidx.compose.ui.unit.dp

/**
 * Spatial tokens for TV UI.
 *
 * Safe-area values follow Google's Android TV design guidance (48dp horizontal,
 * 27dp vertical) rather than the 5% overscan convention from the HTML mockup.
 * Reason: on real Android TV devices (Shield, Chromecast with Google TV, most
 * smart-TV firmwares), the Compose viewport is ~960×540 dp at xhdpi density —
 * so 5% overscan would be 48×27 dp, not the 96×54 the 1920px mockup implied.
 * Using the mockup's pixel values as dp led to content overflowing on real
 * hardware.
 *
 * CardWidth/CardPosterHeight match the current HTML mockup's 130x195 size
 * (aspect 2:3). If we retune the mockup, retune here.
 */
object AuroraDimensions {
    // Safe-area insets — Google TV-recommended, not the pixel-literal overscan
    val SafeAreaHorizontal = 48.dp
    val SafeAreaVertical   = 27.dp

    // Card sizing (poster cards in rows)
    val CardWidth        = 130.dp
    val CardPosterHeight = 195.dp      // 130 × (3/2)
    val CardGap          = 14.dp
    val RowGap           = 18.dp

    // Focus ring — thickness around focused card
    val FocusRingWidth   = 3.dp
    val FocusScaleFactor = 1.08f       // focused card scale multiplier

    // Hero
    val HeroHeight       = 400.dp
    val HeroContentWidth = 680.dp
}
