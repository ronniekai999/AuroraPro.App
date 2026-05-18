package io.aurora.tv.core.network.dto

import kotlinx.serialization.Serializable

/**
 * Wire DTOs for the media endpoints. Mirror `models.MediaItem` and the
 * `paginatedResponse(...)` wrapper in the Go server. Snake-case ↔ camelCase
 * is handled by the Json naming strategy (NetworkModule.provideJson).
 *
 * We deliberately model only the fields the Phase-0 UI consumes. Fields
 * Aurora returns but we ignore (file_path, files[], match_status,
 * library_id, sort_title, etc.) are dropped silently thanks to
 * `ignoreUnknownKeys = true` — adding them later is non-breaking.
 */

@Serializable
data class MediaItemDto(
    val id: Long,
    /** "movie" | "show" — Aurora's MediaType. */
    val type: String,
    val title: String,
    val year: Int? = null,
    val overview: String? = null,
    /** TMDB rating, 0–10 with one decimal. */
    val rating: Double? = null,
    val runtimeMinutes: Int? = null,
    /** "PG-13", "TV-MA", etc. */
    val contentRating: String? = null,
    /** TMDB poster path; resolve through Aurora's image proxy to render. */
    val posterPath: String? = null,
    val backdropPath: String? = null,
    /** Genre names, denormalized by the API layer. */
    val genres: List<String> = emptyList(),
    val has4k: Boolean = false,

    // ── Detail-only fields (sparsely populated on list endpoints) ───────────
    //
    // Aurora's `GET /api/media/{id}` returns a richly-enriched response with
    // cast, files, season/episode counts, and user progress all embedded.
    // The list endpoint `GET /api/media` omits these (they're empty / absent
    // on the wire). `ignoreUnknownKeys = true` + the defaults below mean we
    // can use ONE DTO for both shapes — list responses leave these as
    // empty lists / null, detail responses populate them. No separate
    // EnrichedMediaItemDto needed.
    //
    // Why not split into two DTOs: the field overlap is ~80% identical;
    // splitting would mean duplicating the bulk of MediaItemDto plus
    // mappers that translate between them. Single sparse DTO is simpler
    // for the same correctness.

    /** Cast & crew. Populated by the detail endpoint; empty for list responses. */
    val cast: List<CastMemberDto> = emptyList(),
    /** Available files (different quality versions). Populated by detail only. */
    val files: List<MediaFileDto> = emptyList(),
    /** TV-only: season count. Null for movies and absent on list responses. */
    val seasonCount: Int? = null,
    /** TV-only: total episode count across all seasons. */
    val episodeCount: Int? = null,
)

/**
 * Generic paginated wrapper. Aurora's `paginatedResponse(...)` always wraps
 * list endpoints in this shape; the `data` field's element type is the
 * type parameter. Retrofit + kotlinx.serialization needs `@Serializable`
 * on the concrete instantiation, so we declare the parameterized form here
 * and let callers reify with their concrete element DTO.
 */
@Serializable
data class PaginatedResponseDto<T>(
    val data: List<T>,
    val page: Int,
    val perPage: Int,
    val totalItems: Long,
    val totalPages: Int,
)

/**
 * Convenience type alias for the most common paginated shape — a list of
 * MediaItemDto. Keeps Retrofit signatures readable.
 */
typealias MediaListResponseDto = PaginatedResponseDto<MediaItemDto>
