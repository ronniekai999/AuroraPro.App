package app.aurorapro.tv.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.*
import androidx.compose.ui.graphics.drawscope.*
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.*
import androidx.tv.material3.*
import app.aurorapro.tv.R
import app.aurorapro.tv.data.Profile
import app.aurorapro.tv.data.Progress
import coil3.compose.AsyncImage

object AuroraColors {
    val Background = Color(0xFF050507)
    val Surface = Color(0xFF121019)
    val Raised = Color(0xFF21182F)
    val Purple = Color(0xFFA855F7)
    val Primary = Color(0xFF7C3AED)
    val Focus = Color(0xFFD8B4FE)
    val Cyan = Color(0xFF22D3EE)
    val Muted = Color(0xFFC0BACA)
}
val AuroraHeading = FontFamily(Font(R.font.bricolage))

fun Modifier.auroraBackground() = drawBehind {
    drawRect(AuroraColors.Background)
    drawRect(Brush.radialGradient(listOf(AuroraColors.Purple.copy(alpha = .12f), Color.Transparent),
        center = Offset(size.width * .18f, size.height * .25f), radius = size.width * .7f))
}

@Composable
fun AuroraTitle(text: String, modifier: Modifier = Modifier, size: Int = 32) {
    Text(text, modifier, fontFamily = AuroraHeading, fontSize = size.sp, color = Color.White,
        maxLines = 2, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis)
}

@Composable
fun AuroraAction(label: String, onClick: () -> Unit, modifier: Modifier = Modifier,
                 enabled: Boolean = true, primary: Boolean = false, selected: Boolean = false) {
    Button(onClick, modifier.heightIn(min = 42.dp).then(if (selected) Modifier.semantics { this.selected = true } else Modifier), enabled = enabled,
        shape = ButtonDefaults.shape(RoundedCornerShape(12.dp)),
        colors = ButtonDefaults.colors(
            containerColor = if (primary) AuroraColors.Primary else if (selected) AuroraColors.Raised else Color.White.copy(alpha = .06f),
            contentColor = Color.White, focusedContainerColor = AuroraColors.Focus, focusedContentColor = AuroraColors.Background)) {
        Text(label, fontSize = 14.sp, maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis)
    }
}

// Canonical Borealis paths from the web AuroraWordmark. Brand art stays vector art.
private val wordmarkPaths = listOf(
    "M 40 220 L 115 30 L 190 220", "M 69 151 C 99 139 131 163 161 151",
    "M 234 110 V 172 A 48 48 0 0 0 330 172", "M 330 110 V 220", "M 388 110 V 220",
    "M 388 168 A 58 58 0 0 1 446 110 Q 452 110 458 104",
    "M 480 165 A 55 55 0 1 1 590 165 A 55 55 0 1 1 480 165", "M 648 110 V 220",
    "M 648 168 A 58 58 0 0 1 706 110 Q 712 110 718 104",
    "M 740 165 A 55 55 0 1 1 850 165 A 55 55 0 1 1 740 165", "M 850 110 V 220",
    "M 912 30 V 220", "M 912 30 H 964 A 47 47 0 0 1 964 124 H 912", "M 1048 110 V 220",
    "M 1048 168 A 58 58 0 0 1 1106 110 Q 1112 110 1118 104",
    "M 1140 165 A 55 55 0 1 1 1250 165 A 55 55 0 1 1 1140 165",
)

@Composable
fun AuroraWordmark(height: Dp = 20.dp, gradient: Boolean = false) {
    val paths = remember { wordmarkPaths.map { PathParser().parsePathString(it).toPath() } }
    Canvas(Modifier.height(height).width(height * (1236f / 216f))) {
        withTransform({ scale(size.width / 1236f, size.height / 216f, Offset.Zero); translate(-27f, -17f) }) {
            val ink = if (gradient) Brush.horizontalGradient(listOf(AuroraColors.Purple, AuroraColors.Cyan), 27f, 1263f)
                else Brush.horizontalGradient(listOf(Color.White, Color.White))
            paths.forEach { drawPath(it, ink, style = Stroke(26f, cap = StrokeCap.Round, join = StrokeJoin.Round)) }
        }
    }
}

@Composable
fun AuroraBrand(large: Boolean = false) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(if (large) 16.dp else 10.dp)) {
        Canvas(Modifier.size(if (large) 56.dp else 30.dp)) {
            drawCircle(Brush.linearGradient(listOf(AuroraColors.Purple, Color(0xFF7C3AED), AuroraColors.Cyan)))
            val p = Path().apply { moveTo(size.width * .38f, size.height * .28f); lineTo(size.width * .73f, size.height * .5f)
                lineTo(size.width * .38f, size.height * .72f); close() }
            drawPath(p, Color.White)
        }
        AuroraWordmark(if (large) 40.dp else 20.dp, gradient = large)
    }
}

private val nebulaPalettes = mapOf(
    "amethyst" to listOf(0xFFA855F7, 0xFFD8B4FE, 0xFF7E22CE), "tidal" to listOf(0xFF2DD4BF, 0xFF22D3EE, 0xFF0EA5E9),
    "blossom" to listOf(0xFFEC4899, 0xFFF9A8D4, 0xFFDB2777), "ember" to listOf(0xFFF59E0B, 0xFFFCD34D, 0xFFFB7185),
    "verdant" to listOf(0xFF10B981, 0xFF6EE7B7, 0xFF34D399), "cobalt" to listOf(0xFF6366F1, 0xFFA5B4FC, 0xFF818CF8),
    "rose" to listOf(0xFFF43F5E, 0xFFFDA4AF, 0xFFFB7185), "mirage" to listOf(0xFF06B6D4, 0xFFC084FC, 0xFF8B5CF6),
    "solstice" to listOf(0xFFEAB308, 0xFFFDE047, 0xFFF59E0B), "aurora" to listOf(0xFFA855F7, 0xFF2DD4BF, 0xFFEC4899),
)

@Composable
fun ProfileOrb(profile: Profile, diameter: Dp = 88.dp, highlighted: Boolean = false) {
    val palette = nebulaPalettes[profile.avatarUrl.removePrefix("nebula:")]
    var imageFailed by remember(profile.avatarUrl) { mutableStateOf(false) }
    val remote = profile.avatarUrl.startsWith("https://") || profile.avatarUrl.startsWith("http://")
    Box(Modifier.size(diameter).border(if (highlighted) 3.dp else 1.dp,
        if (highlighted) AuroraColors.Focus else Color.White.copy(alpha = .18f), CircleShape).padding(5.dp).clip(CircleShape),
        contentAlignment = Alignment.Center) {
        if (palette != null) Canvas(Modifier.fillMaxSize()) {
            drawCircle(Color(0xFF130E20))
            val positions = listOf(Offset(size.width * .28f, size.height * .28f), Offset(size.width * .78f, size.height * .56f),
                Offset(size.width * .36f, size.height * .83f))
            palette.forEachIndexed { i, c -> drawCircle(Brush.radialGradient(listOf(Color(c), Color(c).copy(alpha = 0f)),
                center = positions[i], radius = size.width * .75f)) }
            drawCircle(Brush.radialGradient(listOf(Color.White.copy(alpha = .22f), Color.Transparent),
                center = Offset(size.width * .4f, size.height * .25f), radius = size.width * .55f))
        } else if (remote && !imageFailed) AsyncImage(profile.avatarUrl, null, contentScale = ContentScale.Crop,
            modifier = Modifier.fillMaxSize(), onError = { imageFailed = true })
        else Box(Modifier.fillMaxSize().background(AuroraColors.Raised), contentAlignment = Alignment.Center) {
            Text(profile.name.take(1).uppercase(), fontFamily = AuroraHeading, color = AuroraColors.Focus, fontSize = (diameter.value * .38f).sp)
        }
    }
}

@Composable
fun AuroraArtwork(url: String?, modifier: Modifier = Modifier) {
    var failed by remember(url) { mutableStateOf(false) }
    Box(modifier.background(Brush.linearGradient(listOf(AuroraColors.Raised, Color(0xFF101A21))))) {
        if (!url.isNullOrBlank() && !failed) AsyncImage(url, null, contentScale = ContentScale.Crop,
            modifier = Modifier.fillMaxSize(), onError = { failed = true })
    }
}

@Composable
fun WatchProgress(progress: Progress?, modifier: Modifier = Modifier) {
    if (progress == null || progress.durationMs <= 0 || progress.positionMs <= 0) return
    val fraction = if (progress.completed) 1f else (progress.positionMs.toDouble() / progress.durationMs).toFloat().coerceIn(0f, 1f)
    Box(modifier.fillMaxWidth().height(3.dp).background(Color.White.copy(alpha = .18f), RoundedCornerShape(2.dp))) {
        Box(Modifier.fillMaxWidth(fraction).fillMaxHeight().background(AuroraColors.Purple, RoundedCornerShape(2.dp)))
    }
}
