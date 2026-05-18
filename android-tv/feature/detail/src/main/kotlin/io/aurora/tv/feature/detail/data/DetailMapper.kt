package io.aurora.tv.feature.detail.data

import io.aurora.tv.core.network.dto.AudioTrackDto
import io.aurora.tv.core.network.dto.CastMemberDto
import io.aurora.tv.core.network.dto.MediaFileDto
import io.aurora.tv.core.network.dto.MediaItemDto
import io.aurora.tv.core.network.dto.SubtitleTrackDto
import io.aurora.tv.core.ui.media.MediaItem

/**
 * Translates the wire-level enriched detail response into the UI's
 * `DetailContent` shape. Aurora's `GET /api/media/{id}` returns one
 * dense response with cast, files, and audio/subtitle tracks all
 * embedded — we fan it out to the typed UI domain here in one pass.
 *
 * A few intentional simplifications worth knowing:
 *  - **Audio/subtitle tracks** come from the FIRST file. Aurora can have
 *    multiple files per item (4K + 1080p + etc.) each with potentially
 *    different track bundles. The detail UI doesn't yet have a per-file
 *    track picker; using the first file's tracks gives a useful preview
 *    without misrepresenting capability for the most common case (where
 *    the same audio bundle is across all qualities). Player will need
 *    to revisit this.
 *  - **Variants** map directly from the files list: each file becomes
 *    one MediaVariant. Resolution + container/codec become the badge
 *    label/codec line; the file with `versionTag` starting "4K" is
 *    `isPreferred = true` so it bolds.
 *  - **Star rating** is the TMDB rating (0-10 float) — used directly.
 */

private const val POSTER_SIZE   = "w342"
private const val BACKDROP_SIZE = "original"
/** Headshot size — square crops, smaller than posters, 185px is plenty. */
private const val HEADSHOT_SIZE = "w185"

/**
 * Build the full `DetailContent` from the enriched DTO. `serverUrl` is
 * needed to resolve poster/backdrop/headshot paths through the image
 * proxy (`/api/images/{size}/{path}`).
 *
 * `related` is fed in from a separate listMedia call (the detail
 * endpoint doesn't return recommendations) — see DetailRepository.
 */
fun MediaItemDto.toDetailContent(
    serverUrl: String,
    related: List<MediaItem>,
): DetailContent {
    val item = MediaItem(
        id              = "aurora-$id",
        title           = title,
        year            = year ?: 0,
        runtimeMinutes  = runtimeMinutes ?: 0,
        rating          = contentRating.orEmpty(),
        genres          = genres,
        description     = overview.orEmpty(),
        accentHue       = ((title.hashCode() % 360) + 360) % 360,
        posterUrl       = posterPath?.let { resolveImageUrl(serverUrl, POSTER_SIZE, it) },
        backdropUrl     = backdropPath?.let { resolveImageUrl(serverUrl, BACKDROP_SIZE, it) },
        network         = null,
    )

    val firstFile = files.firstOrNull()

    return DetailContent(
        item          = item,
        starRating    = (rating ?: 0.0).toFloat(),
        cast          = cast.map { it.toCastMember(serverUrl) },
        // Two-layer filter against variant badges that render as visually-
        // empty pills:
        //  1. PRE-MAP: drop files whose `resolution` is null/blank/whitespace.
        //     Resolution is the most user-meaningful signal in the badge;
        //     without it, the badge collapses to a tiny "Unknown" label
        //     and reads as broken UI.
        //  2. POST-MAP: belt-and-suspenders. Drop mapped variants whose
        //     LABEL still doesn't contain at least one alphanumeric
        //     character (catches edge cases like resolution = "0", "—",
        //     unicode whitespace, etc. that pass `isNullOrBlank` but
        //     produce visually-empty badges).
        // A file with confirmed resolution + populated codecs/size renders
        // normally; files in any other state are hidden until the library
        // re-scan populates them.
        mediaVariants = files
            .filter { f -> !f.resolution.isNullOrBlank() }
            .map { it.toMediaVariant() }
            .filter { v -> v.label.any { ch -> ch.isLetterOrDigit() } && v.label != "Unknown" },
        audioTracks   = firstFile?.audioTracks?.map { it.toAudioTrack() } ?: emptyList(),
        subtitles     = firstFile?.subtitleTracks?.map { it.toSubtitleTrack() } ?: emptyList(),
        related       = related,
    )
}

/** Cast DTO → UI `CastMember`. `role` merges `roleType` + `character`. */
private fun CastMemberDto.toCastMember(serverUrl: String): CastMember = CastMember(
    id          = id,
    name        = name,
    // Display "Cruella De Vil" for actors with a character, else the role
    // type ("Director", "Writer", etc.) capitalized.
    role        = character ?: roleType.replaceFirstChar { it.uppercase() },
    headshotUrl = profilePath?.let { resolveImageUrl(serverUrl, HEADSHOT_SIZE, it) },
)

/**
 * MediaFile DTO → UI `MediaVariant`. The label is the file's resolution
 * (e.g. "4K", "1080p"); the tag is the library name (e.g. "4K Movies").
 * `isPreferred` highlights the highest-quality variant.
 */
private fun MediaFileDto.toMediaVariant(): MediaVariant = MediaVariant(
    label       = resolution.orEmpty().ifEmpty { "Unknown" },
    tag         = libraryName?.let { "[$it]" } ?: "",
    sizeBytes   = sizeBytes,
    codecLabel  = listOfNotNull(videoCodec, audioCodec)
        .filter { it.isNotBlank() }
        .joinToString("/"),
    isPreferred = (versionTag?.startsWith("4K") == true),
)

/** AudioTrack DTO → UI `AudioTrack`. Title becomes the qualifier. */
private fun AudioTrackDto.toAudioTrack(): AudioTrack = AudioTrack(
    language     = language?.uppercase().orEmpty().ifEmpty { "Unknown" },
    codec        = codec,
    channelCount = channels,
    isDefault    = isDefault,
    qualifier    = title,
)

/**
 * SubtitleTrack DTO → UI `SubtitleTrack`. The display name is "<lang> -
 * <title>" if a title exists (e.g. "English - SDH"), else the language
 * uppercased. Bitmap subtitles get a "(image)" suffix so users know they
 * may not be able to disable them at the player level.
 */
private fun SubtitleTrackDto.toSubtitleTrack(): SubtitleTrack {
    val lang = language.uppercase().ifEmpty { "Unknown" }
    val name = if (!title.isNullOrBlank()) "$lang — $title" else lang
    val display = if (bitmap) "$name (image)" else name
    return SubtitleTrack(
        language    = language,
        format      = codec,
        displayName = display,
    )
}

private fun resolveImageUrl(serverUrl: String, size: String, path: String): String {
    val cleanBase = serverUrl.trimEnd('/')
    val cleanPath = path.trimStart('/')
    return "$cleanBase/api/images/$size/$cleanPath"
}

/**
 * Standalone mapper used by the "More like this" fetch (a regular
 * listMedia call, not the enriched detail endpoint). Same shape as
 * Movies' MediaItemMapper — duplicated rather than shared for now;
 * promotion to core/ui is a follow-up once the third call site shows up.
 */
fun MediaItemDto.toListMediaItem(serverUrl: String): MediaItem = MediaItem(
    id              = "aurora-$id",
    title           = title,
    year            = year ?: 0,
    runtimeMinutes  = runtimeMinutes ?: 0,
    rating          = contentRating.orEmpty(),
    genres          = genres,
    description     = overview.orEmpty(),
    accentHue       = ((title.hashCode() % 360) + 360) % 360,
    posterUrl       = posterPath?.let { resolveImageUrl(serverUrl, POSTER_SIZE, it) },
    backdropUrl     = backdropPath?.let { resolveImageUrl(serverUrl, BACKDROP_SIZE, it) },
    network         = null,
)
