package io.aurora.tv.feature.home.data

import io.aurora.tv.core.network.dto.ContinueWatchingItemDto
import io.aurora.tv.core.network.dto.MediaItemDto
import io.aurora.tv.core.ui.media.MediaItem

/**
 * Wire-DTO → UI-domain mappers for the Home tab.
 *
 * Mirrors the conventions from `:feature:movies/data/MediaItemMapper.kt`:
 *  - IDs are prefixed `aurora-` and stringified so the LazyRow `key`
 *    pipeline doesn't have to box Longs.
 *  - Image paths are routed through Aurora's `<server>/api/images/<size>/…`
 *    proxy. `w342` for posters (matches PosterCard's render size at TV
 *    density), `original` for backdrops (consumed by the hero band).
 *  - `accentHue` is derived deterministically from the title hash so the
 *    placeholder gradient stays stable across refetches and matches the
 *    same item rendered elsewhere (Movies/Shows).
 *
 * The Continue Watching mapper is the only twist: the wire row's `id`
 * field is the progress-row primary key, not the media id, so we use
 * `mediaItemId` for the UI's `MediaItem.id`. Otherwise tapping a CW
 * card would route the detail screen to a nonexistent media id.
 */

private const val POSTER_SIZE = "w342"
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
    network         = null,
)

/**
 * Map a Continue Watching wire entry to the UI's `MediaItem`. We bake the
 * progress percentage into `progressPercent` so PosterCard can render the
 * progress bar overlay without an additional parallel data structure.
 *
 * `mediaItemId` (NOT `id`) is what we key the UI item on — `id` is the
 * progress-row pk, useless to the detail screen. `percentComplete` is a
 * 0.0–1.0 fraction on the wire; the UI bar takes a 0–100 int.
 */
fun ContinueWatchingItemDto.toMediaItem(serverUrl: String): MediaItem = MediaItem(
    id              = "aurora-$mediaItemId",
    title           = title,
    // Server now ships year on the continue-watching feed (added after
    // initial Phase-1 wiring). DTO defaults to 0 if a pre-update server
    // is still running, in which case the UI's year-suppression rule
    // hides the line gracefully.
    year            = year,
    // Runtime IS recoverable from durationMs (the file duration tracked
    // alongside watch progress). Convert ms → minutes; 0 ms reads as
    // "unknown" downstream.
    runtimeMinutes  = (durationMs / 60_000L).toInt(),
    rating          = "",
    genres          = emptyList(),
    description     = "",
    accentHue       = hueFromTitle(title),
    posterUrl       = posterPath?.let { resolveImageUrl(serverUrl, POSTER_SIZE, it) },
    backdropUrl     = backdropPath?.let { resolveImageUrl(serverUrl, BACKDROP_SIZE, it) },
    network         = null,
    progressPercent = (percentComplete * 100).toInt().coerceIn(0, 100),
)

private fun resolveImageUrl(serverUrl: String, size: String, path: String): String {
    val cleanBase = serverUrl.trimEnd('/')
    val cleanPath = path.trimStart('/')
    return "$cleanBase/api/images/$size/$cleanPath"
}

private fun hueFromTitle(title: String): Int =
    ((title.hashCode() % 360) + 360) % 360
