package io.aurora.tv.feature.profiles.data

import io.aurora.tv.core.network.dto.UserProfileDto
import io.aurora.tv.feature.profiles.Profile

/**
 * Translates Aurora's `UserProfileDto` into the UI's `Profile`.
 *
 * The mapping is mostly mechanical, but two pieces deserve calling out:
 *
 *  - **Avatar URL.** The server stores a free-form URL (or null/empty if
 *    the user never picked one). When absent, we leave it null — the
 *    Phase-0 picker UI already renders a deterministic colored letter
 *    avatar from the first character of the display name, so "no avatar"
 *    is a fully-handled case downstream. When present, an absolute URL
 *    (http/https) is passed through as-is; a relative path goes through
 *    Aurora's image route on the configured server. Empty strings are
 *    treated the same as null.
 *
 *  - **`accentHue`.** Server doesn't carry one. We derive it from the
 *    profile name's hashCode so the per-profile color stays stable across
 *    requests but varies across profiles. Same approach `MediaItemMapper`
 *    uses for media tiles' gradient placeholder.
 *
 *  - **`isKidProfile` / `parentalLevel`.** Server doesn't have a boolean
 *    "kid" flag yet — `maxAgeRating` is the closest analogue, but Phase 1
 *    treats the server's filtering as authoritative and doesn't enforce
 *    it client-side. So both fields default to their "no restriction"
 *    values for now; surfacing the KIDS badge is a follow-up once the
 *    server schema settles on a canonical kid-profile signal.
 */

fun UserProfileDto.toProfile(serverUrl: String): Profile = Profile(
    id           = id.toString(),
    displayName  = name,
    avatarUrl    = resolveAvatarUrl(serverUrl, avatarUrl),
    accentHue    = hueFromName(name),
    parentalLevel = 0,
    isKidProfile  = false,
)

/**
 * Returns null when the server gave us no avatar (null OR empty string),
 * an absolute URL untouched, or — for relative paths — a URL resolved
 * against the configured server's base.
 */
private fun resolveAvatarUrl(serverUrl: String, raw: String?): String? {
    if (raw.isNullOrBlank()) return null
    val trimmed = raw.trim()
    return if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
        trimmed
    } else {
        val cleanBase = serverUrl.trimEnd('/')
        val cleanPath = trimmed.trimStart('/')
        "$cleanBase/$cleanPath"
    }
}

/** Deterministic 0-359 hue derived from the profile name. */
private fun hueFromName(name: String): Int {
    return ((name.hashCode() % 360) + 360) % 360
}
