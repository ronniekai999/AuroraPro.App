package io.aurora.tv.core.network.dto

import kotlinx.serialization.Serializable

/**
 * Cast & crew entry. Shape matches Go's `models.CastMember` exactly.
 *
 * `roleType` is the canonical "actor" / "director" / "writer" / etc.
 * string Aurora's TMDB integration writes. `character` is the role name
 * for actors (e.g. "Cruella De Vil") — null for crew members. The UI's
 * existing CastMember model (in feature:detail) merges these into a
 * single `role` string for display.
 *
 * `profilePath` is a TMDB headshot path; resolved through Aurora's
 * image proxy at `/api/images/{size}/{path}` like other artwork.
 */
@Serializable
data class CastMemberDto(
    val id: Long,
    val name: String,
    val profilePath: String? = null,
    val roleType: String,
    val character: String? = null,
    val displayOrder: Int = 0,
)

/**
 * One available media file for a movie or episode. Aurora returns these
 * embedded in the enriched detail response (one item can have multiple
 * files representing different qualities — 4K, 1080p, etc.).
 *
 * `audioTracks` and `subtitleTracks` are populated by ffprobe during
 * library scan; they're per-file because different encodings of the same
 * movie can ship with different audio/subtitle bundles.
 */
@Serializable
data class MediaFileDto(
    val id: Long,
    val mediaItemId: Long? = null,
    val sizeBytes: Long = 0,
    val container: String = "",
    val videoCodec: String? = null,
    val audioCodec: String? = null,
    val resolution: String? = null,
    val versionTag: String? = null,
    val bitrate: Long = 0,
    val durationMs: Long = 0,
    val audioTracks: List<AudioTrackDto> = emptyList(),
    val subtitleTracks: List<SubtitleTrackDto> = emptyList(),
    /** Cross-library annotation: which library this version came from. */
    val libraryName: String? = null,
)

/**
 * One audio stream inside a media file. Mirrors Go's `models.AudioTrack`
 * exactly. The UI's `AudioTrack` (feature:detail) carries the same
 * information with friendlier field names.
 */
@Serializable
data class AudioTrackDto(
    val index: Int = 0,
    val codec: String = "",
    val channels: Int = 0,
    val language: String? = null,
    val title: String? = null,
    val isDefault: Boolean = false,
)

/**
 * One subtitle stream inside a media file. Mirrors Go's
 * `models.SubtitleTrack` exactly.
 */
@Serializable
data class SubtitleTrackDto(
    val index: Int = 0,
    val language: String = "",
    val title: String? = null,
    val codec: String = "",
    val forced: Boolean = false,
    val default: Boolean = false,
    /** True for image-based subs (PGS / VOBSUB) that can't be rendered as text. */
    val bitmap: Boolean = false,
)
