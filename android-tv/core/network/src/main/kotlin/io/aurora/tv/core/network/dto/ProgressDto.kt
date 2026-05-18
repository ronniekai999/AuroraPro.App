package io.aurora.tv.core.network.dto

import kotlinx.serialization.Serializable

/**
 * Wire DTOs for the `api/progress` endpoints. Mirror Aurora's Go structs
 * `models.WatchProgress` and `models.ContinueWatchingItem` exactly. Same
 * snake_case ↔ camelCase naming-strategy convention as the rest of
 * core/network/dto.
 */

/**
 * Per-user / per-profile watch progress on a single media item or
 * episode. Used both as a standalone response (for `GET /api/progress/{id}`)
 * and as the embedded base of `ContinueWatchingItemDto`.
 */
@Serializable
data class WatchProgressDto(
    val id: Long = 0,
    val userId: Long = 0,
    val profileId: Long = 0,
    val mediaItemId: Long = 0,
    val episodeId: Long? = null,
    val positionMs: Long = 0,
    val durationMs: Long = 0,
    val completed: Boolean = false,
    val updatedAt: String? = null,
)

/**
 * Enriched progress entry for the Home tab's "Continue Watching" row.
 * Server endpoint: `GET /api/progress/continue?limit=N&profile_id=…`
 *
 * The Go struct embeds `WatchProgress` and adds title/artwork/episode
 * metadata, so the client doesn't have to make a second request to
 * resolve display data per row. We model the embedded fields as a flat
 * structure here because kotlinx.serialization doesn't natively unfold
 * nested Go-style embedded structs into a containing type — we just
 * declare every field at the top level. This works because Aurora's
 * JSON encoder writes them flat too (Go embeds serialize their fields
 * directly into the parent object).
 */
@Serializable
data class ContinueWatchingItemDto(
    // Embedded WatchProgress fields (flattened — Go's `embedded struct`
    // marshals as flat JSON, so we mirror that here)
    val id: Long = 0,
    val userId: Long = 0,
    val profileId: Long = 0,
    val mediaItemId: Long = 0,
    val episodeId: Long? = null,
    val positionMs: Long = 0,
    val durationMs: Long = 0,
    val completed: Boolean = false,
    val updatedAt: String? = null,

    // ContinueWatchingItem-specific fields
    val title: String,
    val posterPath: String? = null,
    val backdropPath: String? = null,
    /** "movie" | "show" — same MediaType enum as MediaItem. */
    val type: String,
    /**
     * Release year. Added server-side after the initial Phase-1 wiring
     * (the original feed didn't include it). Defaults to 0 for tolerance
     * with older server builds; the UI suppresses the year line when 0.
     */
    val year: Int = 0,
    val episodeTitle: String? = null,
    val seasonNumber: Int? = null,
    val episodeNumber: Int? = null,
    /** 0.0–1.0; how much of the runtime has been watched. */
    val percentComplete: Double = 0.0,
)
