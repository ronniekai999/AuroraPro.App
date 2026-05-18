package io.aurora.tv.feature.detail.data

import kotlinx.serialization.Serializable

/**
 * One cast or crew entry on the detail screen's "Cast" strip.
 *
 * `role` is free-form ("Director", "Lead", "Supporting", etc.) rather than
 * an enum so the wire format stays flexible — Plex returns role strings
 * directly, Jellyfin uses a `Type` field that maps to similar strings,
 * and TMDB has a separate cast/crew distinction. A free string lets us
 * surface whatever the source provides.
 *
 * `headshotUrl` is the small circular portrait shown next to the name.
 * Phase 0 derives this from the name slug via Picsum so cast portraits
 * are deterministic. Production data fills this with real headshot URLs.
 */
@Serializable
data class CastMember(
    /**
     * Server-side primary key (Aurora's `cast_member.id`). Carried into the
     * UI domain so the LazyRow has a guaranteed-unique stable key. Names
     * collide in practice — the same person can appear as both director
     * AND writer on a single show, which crashed an earlier build of this
     * screen with `IllegalArgumentException: Key "<name>" was already used`.
     */
    val id: Long,
    val name: String,
    val role: String,
    val headshotUrl: String? = null,
)
