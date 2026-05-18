package io.aurora.tv.feature.shows.data

import io.aurora.tv.core.network.dto.MediaItemDto
import io.aurora.tv.core.ui.media.MediaItem

/**
 * Translates Aurora's wire-level `MediaItemDto` into the UI's `MediaItem`
 * for the Shows tab. Same logic as feature:movies' MediaItemMapper —
 * duplicated here rather than extracted to `core/ui/media` so feature
 * modules don't need a cross-feature dep on movies. Promoting both into
 * a shared mapper is a clean follow-up once Search and Detail wire up
 * and the third call site appears.
 *
 * Differences from Movies' MediaItemMapper: none in the mapping itself.
 * The id prefix `aurora-` distinguishes server-sourced items from any
 * legacy stub data; same convention Movies uses so detail navigation
 * (which receives MediaItem.id as part of the JSON nav arg) treats
 * movie and show ids consistently.
 */

/**
 * Poster size requested from Aurora's image proxy. `w342` matches the
 * actual rendered card size on 1080p TVs (PosterCard is 130dp wide ≈ 260
 * actual pixels at TV density). The previous `w500` was nearly 2x oversized
 * — wasted bandwidth + image-decode CPU per card. See Movies'
 * MediaItemMapper for the full reasoning.
 */
private const val POSTER_SIZE  = "w342"
/** Default backdrop size — wider, used by detail hero backdrop. */
private const val BACKDROP_SIZE = "original"

fun MediaItemDto.toMediaItem(serverUrl: String): MediaItem = MediaItem(
    id              = "aurora-$id",
    title           = title,
    year            = year ?: 0,
    runtimeMinutes  = runtimeMinutes ?: 0,
    rating          = contentRating.orEmpty(),
    genres          = genres,
    description     = overview.orEmpty(),
    accentHue       = hueFromTitle(title),
    posterUrl       = posterPath?.let { resolveImageUrl(serverUrl, POSTER_SIZE, it) },
    backdropUrl     = backdropPath?.let { resolveImageUrl(serverUrl, BACKDROP_SIZE, it) },
    network         = null, // Aurora doesn't expose network on media items.
)

private fun resolveImageUrl(serverUrl: String, size: String, path: String): String {
    val cleanBase = serverUrl.trimEnd('/')
    val cleanPath = path.trimStart('/')
    return "$cleanBase/api/images/$size/$cleanPath"
}

/** Deterministic 0–359 hue derived from the title; same approach as Movies. */
private fun hueFromTitle(title: String): Int =
    ((title.hashCode() % 360) + 360) % 360
