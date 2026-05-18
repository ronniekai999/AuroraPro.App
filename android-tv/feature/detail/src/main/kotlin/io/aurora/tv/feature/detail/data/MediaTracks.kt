package io.aurora.tv.feature.detail.data

import kotlinx.serialization.Serializable

/**
 * One available encoding of a media item — the detail screen renders
 * these as a row of badges below the CTA bar so users can see at a
 * glance which qualities are available before they hit Play. Plex calls
 * these "Versions"; Jellyfin calls them "MediaSources"; Aurora's wire
 * format names them "Variants" — same idea, different spelling.
 *
 * `label` and `tag` are separate so the badge can render the resolution
 * prominently with the source label as a smaller secondary line —
 * matches the web app's `4K [4K Movies]` two-line display.
 */
@Serializable
data class MediaVariant(
    val label: String,        // "4K", "1080p", "720p"
    val tag: String,          // "[4K Movies]", "[Movies]", "[Phone Recordings]"
    val sizeBytes: Long,
    val codecLabel: String,   // "hevc/truehd", "h264/ac3"
    val isPreferred: Boolean = false,  // bolds the badge if true
)

/**
 * One audio stream available on the focal media. Detail's Media Info
 * section renders these as a list under "Audio Tracks."
 *
 * `language` is the ISO 639-1 / 639-2 code as the backend returns it
 * (ENG, FRE, SPA). `codec` and `channelCount` carry the technical
 * details the user expects to see (truehd 8ch, ac3 6ch).
 *
 * `qualifier` is free-form for "Default", "Commentary", "Director's Cut"
 * etc. Multiple tags can be space-joined into a single string by the
 * stub generator; production data sources tag each separately.
 */
@Serializable
data class AudioTrack(
    val language: String,
    val codec: String,
    val channelCount: Int,
    val isDefault: Boolean = false,
    val qualifier: String? = null,
)

/**
 * One subtitle stream. Same shape as AudioTrack but typically just
 * language + a format/source identifier. Production data adds forced/SDH
 * flags; Phase-0 omits those fields until they actually surface on the
 * detail UI.
 */
@Serializable
data class SubtitleTrack(
    val language: String,
    val format: String,       // "hdmv_pgs_subtitle", "srt", etc.
    val displayName: String,  // "English SDH", "Spanish", "English Sing Along"
)
