package io.aurora.tv.feature.home.data

import io.aurora.tv.core.ui.media.MediaItem
import kotlinx.serialization.Serializable

/**
 * One titled horizontal row on the home screen.
 *
 * `id` is stable across content refreshes so the LazyColumn key strategy
 * doesn't tear down rows on rebuild. Important for focus restoration —
 * Compose's focus tracking relies on stable item identities; an unstable
 * key turns "user came back from below" into "row gets replaced," which
 * resets focus to the first card.
 */
@Serializable
data class HomeRow(
    val id: String,
    val title: String,
    val items: List<MediaItem>,
)
