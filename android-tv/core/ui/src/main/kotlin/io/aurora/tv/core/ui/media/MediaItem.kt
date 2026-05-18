package io.aurora.tv.core.ui.media

import kotlinx.serialization.Serializable

/**
 * One library entry — a movie or show. Mirrors the structure the backend
 * returns; P1 wires this to /api/v1/library/items.
 *
 * === WHY THIS LIVES IN core:ui ===
 * Originally introduced under feature:home for browse-row content. Detail,
 * Movies, Shows, My Library, Requests, and Search all need the same shape,
 * so the type was lifted to core:ui:media. Features import this directly;
 * none of them define their own MediaItem variant, which avoids
 * boundary-conversion noise across feature seams.
 *
 * === FIELD NOTES ===
 * `accentHue` is a Phase-0 affordance for the gradient placeholder shown
 * during image loading and on error. Drops out once real artwork ships in
 * Phase 1 (we keep the field through Slice C because the placeholder still
 * fires when posterUrl is null or the network is offline).
 *
 * `runtimeMinutes` is an Int because that's what every self-hosted server
 * sends on the wire (Plex `duration`, Jellyfin `RunTimeTicks` converted).
 * Avoids Float→Int conversions when the only thing we use it for is the
 * "Xh Ym" string format.
 *
 * `progressPercent` is non-null only in Continue Watching contexts.
 * PosterCard renders a progress bar overlay when non-null.
 *
 * `network` is the originating streamer/network for TV series ("HBO",
 * "Netflix", or in our fictional Phase 0 stub: "Halcyon", "Tessera"…).
 * Null on movies and on shows whose network is unknown. The Shows tab's
 * Network filter consumes this. Earlier Phase 0 embedded the network
 * inside the description as a parenthetical "(NetworkName)" — that worked
 * for the stub but broke as soon as anything else wanted to read the
 * value. Optional to keep the field harmless for non-TV items.
 */
@Serializable
data class MediaItem(
    val id: String,
    val title: String,
    val year: Int,
    val runtimeMinutes: Int,
    val rating: String,            // "TV-MA", "PG-13", "R", etc.
    val genres: List<String>,      // First entry shown on the poster badge
    val description: String,
    val accentHue: Int,            // 0-359, drives Phase-0 gradient placeholder
    val progressPercent: Int? = null,
    val posterUrl: String? = null,
    val backdropUrl: String? = null,
    val network: String? = null,   // TV-series originating network; null for movies
)
