package io.aurora.tv.core.design

import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp

/**
 * Typography scale tuned for 10-foot viewing distances.
 *
 * Why the large minimums?
 *  - Smallest readable text on a TV is roughly double what web/mobile uses,
 *    because ~3m viewing distance halves apparent angular size.
 *  - Google's own Android TV design guidance: 12sp ≈ 24sp-equivalent on TV;
 *    body text should be 16sp+.
 *
 * Font families: Inter (body) + Space Grotesk (headings) — matches web app.
 * Phase 1 will bundle the actual .ttf files as resources; Phase 0 uses the
 * platform default to keep APK size minimal during scaffolding.
 */
object AuroraTypography {
    val HeroTitle    = TextStyle(fontWeight = FontWeight.Bold,     fontSize = 72.sp, letterSpacing = (-0.02).em)
    val SectionTitle = TextStyle(fontWeight = FontWeight.Bold,     fontSize = 28.sp)
    val RowTitle     = TextStyle(fontWeight = FontWeight.Bold,     fontSize = 22.sp)
    val CardTitle    = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 16.sp)
    val CardSub      = TextStyle(fontWeight = FontWeight.Medium,   fontSize = 13.sp)
    val BodyLarge    = TextStyle(fontWeight = FontWeight.Normal,   fontSize = 18.sp, lineHeight = 26.sp)
    val Body         = TextStyle(fontWeight = FontWeight.Normal,   fontSize = 15.sp, lineHeight = 22.sp)
    val Button       = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 17.sp)
    val Caption      = TextStyle(fontWeight = FontWeight.Medium,   fontSize = 12.sp, letterSpacing = 0.15.em)
}
