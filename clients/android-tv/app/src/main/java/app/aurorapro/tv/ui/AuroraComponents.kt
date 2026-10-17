package app.aurorapro.tv.ui

import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
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
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.*
import androidx.compose.ui.graphics.drawscope.*
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
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
    val Glass = Color.White.copy(alpha = .07f)
    val GlassBorder = Color(0x38DCC8FF) // The web --glow-border, rgba(220, 200, 255, .22).
    val Error = Color(0xFFFFBAAE)
    val Star = Color(0xFFFACC15)
}

/** Ten-foot layout: overscan-safe side gutter and the chrome every signed-in screen shares. */
object AuroraLayout {
    val Gutter = 48.dp
    val TopBar = 72.dp
}

// Bricolage is variable (wght 200–800, default 800). Name the weights the TV uses.
@OptIn(androidx.compose.ui.text.ExperimentalTextApi::class)
private fun bricolage(weight: Int) = Font(R.font.bricolage, FontWeight(weight),
    variationSettings = FontVariation.Settings(FontVariation.weight(weight)))
val AuroraHeading = FontFamily(bricolage(500), bricolage(600), bricolage(700), bricolage(800))

@Composable
fun AuroraTitle(text: String, modifier: Modifier = Modifier, size: Int = 32) {
    Text(text, modifier, fontFamily = AuroraHeading, fontWeight = FontWeight.Bold, fontSize = size.sp,
        lineHeight = (size * 1.08f).sp, letterSpacing = (-size * .012f).sp, color = Color.White,
        maxLines = 2, overflow = TextOverflow.Ellipsis)
}

/** Small uppercase label above a title, as on the web Stage hero. */
@Composable
fun AuroraEyebrow(text: String, modifier: Modifier = Modifier, color: Color = AuroraColors.Focus) {
    Text(text, modifier, color = color, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 1.6.sp,
        maxLines = 1, overflow = TextOverflow.Ellipsis)
}

@Composable
fun AuroraSectionTitle(text: String, modifier: Modifier = Modifier) {
    Text(text, modifier, fontFamily = AuroraHeading, fontWeight = FontWeight.SemiBold, fontSize = 21.sp,
        color = Color.White, maxLines = 1, overflow = TextOverflow.Ellipsis)
}

fun Modifier.auroraBackground() = drawBehind {
    drawRect(AuroraColors.Background)
    drawRect(Brush.radialGradient(listOf(AuroraColors.Purple.copy(alpha = .16f), Color.Transparent),
        center = Offset(size.width * .1f, 0f), radius = size.width * .62f))
    drawRect(Brush.radialGradient(listOf(AuroraColors.Cyan.copy(alpha = .07f), Color.Transparent),
        center = Offset(size.width * .96f, size.height), radius = size.width * .5f))
}

/** Lilac ring and purple halo for focused artwork; the TV focus state must read from across a room. */
fun Modifier.focusRing(focused: Boolean, shape: Shape) = if (!focused) this else this
    .shadow(22.dp, shape, clip = false, ambientColor = AuroraColors.Purple, spotColor = AuroraColors.Purple)
    .border(2.5.dp, AuroraColors.Focus, shape)

@Composable
fun AuroraAction(label: String, onClick: () -> Unit, modifier: Modifier = Modifier,
                 enabled: Boolean = true, primary: Boolean = false, selected: Boolean = false, icon: ImageVector? = null) {
    val shape = RoundedCornerShape(percent = 50)
    Button(onClick, modifier.heightIn(min = 40.dp).then(if (selected) Modifier.semantics { this.selected = true } else Modifier),
        enabled = enabled,
        scale = ButtonDefaults.scale(focusedScale = 1.06f),
        glow = ButtonDefaults.glow(focusedGlow = Glow(AuroraColors.Purple.copy(alpha = .6f), 12.dp)),
        shape = ButtonDefaults.shape(shape),
        colors = ButtonDefaults.colors(
            containerColor = if (primary) AuroraColors.Primary else if (selected) AuroraColors.Primary.copy(alpha = .32f) else AuroraColors.Glass,
            contentColor = if (selected) AuroraColors.Focus else Color.White, focusedContainerColor = AuroraColors.Focus, focusedContentColor = AuroraColors.Background,
            pressedContainerColor = AuroraColors.Focus, pressedContentColor = AuroraColors.Background,
            disabledContainerColor = Color.White.copy(alpha = .04f), disabledContentColor = Color.White.copy(alpha = .38f)),
        border = ButtonDefaults.border(
            border = Border(BorderStroke(1.dp, if (primary) Color.Transparent else if (selected) AuroraColors.Focus.copy(alpha = .45f)
                else AuroraColors.GlassBorder), shape = shape),
            focusedBorder = Border.None, pressedBorder = Border.None),
        contentPadding = PaddingValues(start = if (icon != null) 16.dp else 20.dp, end = 20.dp, top = 9.dp, bottom = 9.dp)) {
        if (icon != null) {
            Icon(icon, null, Modifier.size(18.dp))
            Spacer(Modifier.width(8.dp))
        }
        Text(label, fontSize = 15.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** A quiet outlined label for ratings and source facts. */
@Composable
fun AuroraBadge(text: String, emphasis: Boolean = false) {
    Text(text, Modifier.border(1.dp, if (emphasis) AuroraColors.Focus.copy(alpha = .7f) else Color.White.copy(alpha = .32f),
        RoundedCornerShape(5.dp)).padding(horizontal = 7.dp, vertical = 2.dp),
        color = if (emphasis) AuroraColors.Focus else Color.White.copy(alpha = .86f), fontSize = 11.sp,
        fontWeight = FontWeight.SemiBold, letterSpacing = .6.sp, maxLines = 1)
}

/** Personal match as a ring, like the web hero's Match dial. */
@Composable
fun MatchBadge(match: Int) {
    val fraction = match.coerceIn(0, 100) / 100f
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
        Canvas(Modifier.size(18.dp)) {
            val stroke = Stroke(2.5.dp.toPx(), cap = StrokeCap.Round)
            drawCircle(Color.White.copy(alpha = .18f), style = stroke)
            drawArc(Brush.sweepGradient(listOf(AuroraColors.Purple, AuroraColors.Cyan, AuroraColors.Purple)),
                -90f, 360f * fraction, false, style = stroke)
        }
        Text("$match% match", color = AuroraColors.Cyan, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
    }
}

/** Dot-separated metadata, with ratings set apart as badges. */
@Composable
fun MetaLine(parts: List<String>, modifier: Modifier = Modifier, badges: List<String> = emptyList(),
             leading: (@Composable () -> Unit)? = null) {
    Row(modifier, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        leading?.invoke()
        val text = parts.filter { it.isNotBlank() }.joinToString("  ·  ")
        if (text.isNotEmpty()) Text(text, color = Color.White.copy(alpha = .78f), fontSize = 14.sp, maxLines = 1,
            overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
        badges.forEach { AuroraBadge(it) }
    }
}

fun runtimeLabel(minutes: Int): String = when {
    minutes <= 0 -> ""
    minutes < 60 -> "$minutes min"
    minutes % 60 == 0 -> "${minutes / 60}h"
    else -> "${minutes / 60}h ${minutes % 60}m"
}

/**
 * Full-bleed title art behind a screen. It fades into the canvas on the left and
 * bottom so text stays readable, and dims once the viewer scrolls past the hero.
 */
@Composable
fun AuroraBackdrop(url: String?, modifier: Modifier = Modifier, dimmed: Boolean = false) {
    val dim by animateFloatAsState(if (dimmed) .6f else 0f, tween(450), label = "backdrop dim")
    Box(modifier.fillMaxSize().drawWithContent {
        drawContent()
        drawRect(Brush.horizontalGradient(0f to AuroraColors.Background, .38f to AuroraColors.Background.copy(alpha = .72f),
            .72f to Color.Transparent))
        drawRect(Brush.verticalGradient(.35f to Color.Transparent, .9f to AuroraColors.Background))
        drawRect(Brush.verticalGradient(0f to AuroraColors.Background.copy(alpha = .75f), .2f to Color.Transparent))
        drawRect(AuroraColors.Background.copy(alpha = dim))
    }) {
        Crossfade(url, label = "backdrop") { current ->
            var failed by remember(current) { mutableStateOf(false) }
            if (!current.isNullOrBlank() && !failed) AsyncImage(current, null, contentScale = ContentScale.Crop,
                alignment = Alignment.TopCenter, modifier = Modifier.fillMaxSize(), onError = { failed = true })
        }
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
        Canvas(Modifier.size(if (large) 56.dp else 28.dp)) {
            drawCircle(Brush.linearGradient(listOf(AuroraColors.Purple, Color(0xFF7C3AED), AuroraColors.Cyan)))
            val p = Path().apply { moveTo(size.width * .38f, size.height * .28f); lineTo(size.width * .73f, size.height * .5f)
                lineTo(size.width * .38f, size.height * .72f); close() }
            drawPath(p, Color.White)
        }
        AuroraWordmark(if (large) 40.dp else 18.dp, gradient = large)
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
    val halo = (palette?.firstOrNull()?.let { Color(it) } ?: AuroraColors.Purple)
    Box(Modifier.size(diameter)
        .then(if (highlighted) Modifier.shadow(diameter * .28f, CircleShape, clip = false, ambientColor = halo, spotColor = halo) else Modifier)
        .border(if (highlighted) 3.dp else 1.dp, if (highlighted) AuroraColors.Focus else Color.White.copy(alpha = .18f), CircleShape)
        .padding(if (highlighted) 6.dp else 5.dp).clip(CircleShape),
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

/** Artwork with a branded gradient while loading or when a title has none. */
@Composable
fun AuroraArtwork(url: String?, modifier: Modifier = Modifier, fallback: String? = null) {
    var failed by remember(url) { mutableStateOf(false) }
    Box(modifier.background(Brush.linearGradient(listOf(AuroraColors.Raised, Color(0xFF101A21)))), contentAlignment = Alignment.Center) {
        if (!url.isNullOrBlank() && !failed) AsyncImage(url, null, contentScale = ContentScale.Crop,
            modifier = Modifier.fillMaxSize(), onError = { failed = true })
        else if (!fallback.isNullOrBlank()) Text(fallback, Modifier.padding(14.dp).clearAndSetSemantics {}, fontFamily = AuroraHeading,
            fontWeight = FontWeight.SemiBold, fontSize = 17.sp, lineHeight = 20.sp, color = AuroraColors.Focus.copy(alpha = .7f),
            maxLines = 4, overflow = TextOverflow.Ellipsis, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
    }
}

@Composable
fun WatchProgress(progress: Progress?, modifier: Modifier = Modifier) {
    if (progress == null || progress.durationMs <= 0 || progress.positionMs <= 0) return
    val fraction = if (progress.completed) 1f else (progress.positionMs.toDouble() / progress.durationMs).toFloat().coerceIn(0f, 1f)
    Box(modifier.fillMaxWidth().height(4.dp).clip(RoundedCornerShape(2.dp)).background(Color.White.copy(alpha = .22f))) {
        Box(Modifier.fillMaxWidth(fraction).fillMaxHeight()
            .background(Brush.horizontalGradient(listOf(AuroraColors.Purple, AuroraColors.Cyan)), RoundedCornerShape(2.dp)))
    }
}

/** Line icons drawn for Aurora on a 24-unit grid; tinted by the surrounding content color. */
object AuroraIcons {
    private fun icon(name: String, vararg strokes: String, filled: String? = null): ImageVector =
        ImageVector.Builder(name, 24.dp, 24.dp, 24f, 24f).apply {
            strokes.forEach {
                addPath(PathParser().parsePathString(it).toNodes(), stroke = SolidColor(Color.White), strokeLineWidth = 2f,
                    strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round)
            }
            filled?.let { addPath(PathParser().parsePathString(it).toNodes(), fill = SolidColor(Color.White)) }
        }.build()

    val Home = icon("home", "M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1z")
    val Movies = icon("movies", "M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z",
        "M8 4v16", "M16 4v16", "M4 9h4", "M4 15h4", "M16 9h4", "M16 15h4")
    val Shows = icon("shows", "M4 7h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z", "M8 3l4 4 4-4")
    val Search = icon("search", "M11 4.5a6.5 6.5 0 1 0 0 13a6.5 6.5 0 1 0 0-13z", "M16 16l4 4")
    val Play = icon("play", filled = "M8 5.2v13.6a.8.8 0 0 0 1.2.7l10.7-6.8a.8.8 0 0 0 0-1.4L9.2 4.5A.8.8 0 0 0 8 5.2z")
    val Pause = icon("pause", "M8.5 5.5v13", "M15.5 5.5v13")
    val Restart = icon("restart", "M4.5 12a7.5 7.5 0 1 0 2.2-5.3", "M4.5 4.5v4h4")
    val Back = icon("back", "M15 5l-7 7 7 7")
    val Forward = icon("forward", "M9 5l7 7-7 7")
    val Sort = icon("sort", "M4 7h16", "M7 12h10", "M10 17h4")
    val Filter = icon("filter", "M4 5h16l-6 7.5V19l-4-2v-4.5z")
    val Mic = icon("mic", "M12 3.5a2.5 2.5 0 0 0-2.5 2.5v6a2.5 2.5 0 0 0 5 0V6A2.5 2.5 0 0 0 12 3.5z",
        "M6 11.5a6 6 0 0 0 12 0", "M12 17.5V21")
    val Versions = icon("versions", "M6 4h12", "M5 8h14", "M5 12h14a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z")
    val Check = icon("check", "M5 12.5l4.5 4.5L19 7")
    val Sparkle = icon("sparkle", filled = "M12 3l1.9 5.6L19.5 10.5l-5.6 1.9L12 18l-1.9-5.6L4.5 10.5l5.6-1.9z")
    val Phone = icon("phone", "M8 3h8a1.5 1.5 0 0 1 1.5 1.5v15A1.5 1.5 0 0 1 16 21H8a1.5 1.5 0 0 1-1.5-1.5v-15A1.5 1.5 0 0 1 8 3z", "M11 18h2")
}
