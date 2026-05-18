package io.aurora.tv.feature.detail.data

import io.aurora.tv.core.ui.media.MediaItem

/**
 * Full detail-screen content state.
 *
 * Composes the focal item with everything the detail surface renders:
 * cast, related items, star rating, available media variants, audio
 * tracks, and subtitle tracks. P1's fetch path pulls these from
 * /api/v1/items/{id}, /api/v1/items/{id}/cast, /api/v1/items/{id}/streams,
 * etc., then folds them into this single ViewModel-facing shape.
 *
 * Not @Serializable — this is a UI state object, not a wire format. The
 * individual leaves (CastMember, AudioTrack, etc.) ARE @Serializable
 * because they show up on the wire when the backend lands.
 */
data class DetailContent(
    val item: MediaItem,
    val starRating: Float,
    val cast: List<CastMember>,
    val mediaVariants: List<MediaVariant>,
    val audioTracks: List<AudioTrack>,
    val subtitles: List<SubtitleTrack>,
    val related: List<MediaItem>,
)
