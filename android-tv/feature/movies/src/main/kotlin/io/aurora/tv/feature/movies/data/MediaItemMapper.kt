package io.aurora.tv.feature.movies.data

import io.aurora.tv.core.network.dto.MediaItemDto
import io.aurora.tv.core.ui.media.MediaItem

/**
 * Translates Aurora's wire-level `MediaItemDto` into the UI's `MediaItem`.
 *
 * The mismatch is small but worth being explicit about:
 *  - **IDs.** Server uses `Long`; the UI's MediaItem uses `String` (chosen
 *    earlier so we could use it as a `LazyVerticalGrid` `key` without
 *    boxing). Format with `"aurora-$id"` so the prefix makes server-sourced
 *    items distinguishable from the Phase-0 stubs at debug-time.
 *  - **Images.** `posterPath` / `backdropPath` are TMDB-style relative paths
 *    (e.g. `/abc123.jpg`). Aurora's image proxy serves them at
 *    `<server>/api/images/<size>/<path>` — we build the full URL here so
 *    Coil can fetch them directly. `null` posterPath stays `null`; the UI
 *    falls back to the gradient placeholder via `accentHue`.
 *  - **`accentHue`.** Server doesn't expose this; it's a Phase-0 affordance
 *    for the gradient placeholder shown while artwork loads or on error.
 *    We derive it from the title hash so the gradient is stable across
 *    requests for the same item, but varied across the catalog.
 *  - **`description`.** Server's field is `overview`; we map that to the
 *    UI's `description`. (Yes, the field is named badly on the UI side —
 *    happens when stubs precede the API. Renaming the UI field is a
 *    separate refactor; keeping the mapping here lets us defer it.)
 *  - **`rating`.** Server has both `rating` (TMDB 0-10 float) and
 *    `content_rating` (e.g. "PG-13"). The UI's `MediaItem.rating: String`
 *    is the *content* rating (e.g. "TV-MA") — that's what shows on the
 *    badge. The numeric TMDB rating is dropped for now; surfacing it on
 *    the detail screen is a follow-up.
 */

/**
 * Poster size requested from Aurora's image proxy.
 *
 * `w342` matches PosterCard's actual rendered size at 1080p TV density:
 * the card is 130dp wide → ~260 pixels actual on a 1080p TV (density ~2x).
 * `w500` (the previous default) was nearly 2x oversized for the grid
 * surface — wasted bandwidth + image-decode CPU per card.
 *
 * If detail-screen hero artwork eventually wants larger posters, that
 * can take a separate constant or accept a size parameter at the
 * mapper boundary.
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
    network         = null, // Server has no network field; Shows tab generates this for stubs only.
)

/**
 * Build a full image-proxy URL. Aurora's `/api/images/{size}/{path}` route
 * is intentionally permissive about the leading slash on `path` — we
 * normalize it here so that whether TMDB returns `"/abc.jpg"` or `"abc.jpg"`
 * we produce the same final URL.
 */
private fun resolveImageUrl(serverUrl: String, size: String, path: String): String {
    val cleanBase = serverUrl.trimEnd('/')
    val cleanPath = path.trimStart('/')
    return "$cleanBase/api/images/$size/$cleanPath"
}

/**
 * Deterministic 0-359 hue derived from the title. Same input always
 * produces the same hue, so the gradient placeholder doesn't flash
 * between identical-on-paper requests. Title-based (rather than id-based)
 * because the same media item across servers / stub-vs-real should look
 * visually consistent.
 */
private fun hueFromTitle(title: String): Int {
    // String.hashCode is JVM-stable and our app is JVM-only, so no need
    // to roll a custom hash for cross-platform consistency. Modulo 360
    // to land in the hue range; absoluteValue to handle negative hashes.
    return ((title.hashCode() % 360) + 360) % 360
}
