package io.aurora.tv.core.design

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.unit.dp

/**
 * Corner radii centralized here so we can retune the whole app's "softness"
 * from one place. Cards use 10dp to match the web mockup; focus containers
 * scale the same radius.
 */
object AuroraShapes {
    val Card     = RoundedCornerShape(10.dp)
    val Pill     = RoundedCornerShape(999.dp)
    val Button   = RoundedCornerShape(12.dp)
    val Surface  = RoundedCornerShape(18.dp)
}
