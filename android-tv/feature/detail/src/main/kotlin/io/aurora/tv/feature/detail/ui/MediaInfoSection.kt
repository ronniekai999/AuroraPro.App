package io.aurora.tv.feature.detail.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Text
import io.aurora.tv.core.design.AuroraColors
import io.aurora.tv.core.design.AuroraDimensions
import io.aurora.tv.core.design.AuroraTypography
import io.aurora.tv.feature.detail.data.AudioTrack
import io.aurora.tv.feature.detail.data.SubtitleTrack

/**
 * Two-column "Media Info" section under the detail hero — Audio Tracks
 * on the left, Subtitles on the right. Mirrors the web app's detail
 * page layout. Non-focusable: this is informational chrome, not an
 * interactive surface.
 *
 * === LAYOUT ===
 *  - Section header "Media Info" at top
 *  - Two equal-weight columns separated by a 60dp gutter
 *  - Each column has its own subheader ("Audio Tracks" / "Subtitles")
 *    in TextSecondary, then a vertical list of entries
 *
 * Spacing matches the web app — 8dp between entries within a column,
 * generous side padding so the columns don't crowd each other.
 */
@Composable
fun MediaInfoSection(
    audioTracks: List<AudioTrack>,
    subtitles: List<SubtitleTrack>,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = AuroraDimensions.SafeAreaHorizontal),
    ) {
        Text(
            text  = "Media Info",
            style = AuroraTypography.SectionTitle,
            color = AuroraColors.TextPrimary,
        )
        Spacer(Modifier.height(20.dp))

        Row(modifier = Modifier.fillMaxWidth()) {
            // Audio tracks column
            Column(
                modifier              = Modifier.weight(1f),
                verticalArrangement   = Arrangement.spacedBy(8.dp),
            ) {
                ColumnHeader("Audio Tracks")
                audioTracks.forEach { track ->
                    AudioTrackEntry(track)
                }
            }

            Spacer(Modifier.width(60.dp))

            // Subtitles column
            Column(
                modifier            = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                ColumnHeader("Subtitles")
                subtitles.forEach { sub ->
                    SubtitleEntry(sub)
                }
            }
        }
    }
}

@Composable
private fun ColumnHeader(text: String) {
    Text(
        text  = text,
        style = TextStyle(
            fontSize   = 14.sp,
            fontWeight = FontWeight.SemiBold,
        ),
        color = AuroraColors.TextSecondary,
        modifier = Modifier.padding(bottom = 6.dp),
    )
}

/**
 * One audio-track row. Format: `<LANG> · <codec> · <Nch> [Default | Commentary]`
 * Default tag rendered as a small pill so it's distinguishable from
 * free-form qualifier text like "Commentary".
 */
@Composable
private fun AudioTrackEntry(track: AudioTrack) {
    Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
        Text(
            text  = "${track.language} · ${track.codec} · ${track.channelCount}ch",
            style = AuroraTypography.Body,
            color = AuroraColors.TextPrimary,
        )
        if (track.isDefault) {
            Spacer(Modifier.width(8.dp))
            DefaultBadge()
        }
        if (track.qualifier != null) {
            Spacer(Modifier.width(8.dp))
            Text(
                text  = "· ${track.qualifier}",
                style = AuroraTypography.Body,
                color = AuroraColors.TextSecondary,
            )
        }
    }
}

@Composable
private fun SubtitleEntry(sub: SubtitleTrack) {
    Text(
        text  = "${sub.language} · ${sub.format} · ${sub.displayName}",
        style = AuroraTypography.Body,
        color = AuroraColors.TextPrimary,
    )
}

/**
 * Small "Default" pill — same style language as PosterCard's genre pill
 * so the visual vocabulary is consistent across the app.
 */
@Composable
private fun DefaultBadge() {
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(6.dp))
            .background(AuroraColors.BgCard)
            .padding(horizontal = 8.dp, vertical = 2.dp),
    ) {
        Text(
            text  = "Default",
            style = TextStyle(
                fontSize   = 11.sp,
                fontWeight = FontWeight.Medium,
            ),
            color = AuroraColors.TextSecondary,
        )
    }
}
