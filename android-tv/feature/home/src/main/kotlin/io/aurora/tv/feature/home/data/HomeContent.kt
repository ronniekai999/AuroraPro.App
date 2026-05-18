package io.aurora.tv.feature.home.data

import io.aurora.tv.core.ui.media.MediaItem

/**
 * Full home-screen content state.
 *
 * Not @Serializable because this is a UI state object, not a wire format —
 * the wire format is List<HomeRow> + a separate "featured" endpoint, and
 * the ViewModel composes them into this shape.
 *
 * `featured` is nullable: when there's no Continue Watching entry AND no
 * Recently Added items (e.g. an empty fresh server), the hero is omitted
 * entirely rather than showing a placeholder. The screen branches on
 * `featured == null` to decide whether to render the hero band.
 */
data class HomeContent(
    val featured: MediaItem?,
    val rows: List<HomeRow>,
)
