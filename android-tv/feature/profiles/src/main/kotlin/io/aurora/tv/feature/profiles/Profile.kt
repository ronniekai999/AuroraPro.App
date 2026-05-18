package io.aurora.tv.feature.profiles

import kotlinx.serialization.Serializable

/**
 * Represents one Aurora user profile on the server. Mirrors the structure
 * the backend returns; P1 wires this to the real /api/v1/profiles endpoint.
 *
 * `parentalLevel` is an int (age-style rating cutoff) rather than an enum
 * so backend can add new granularity (PG-13, R, NC-17) without requiring
 * a client rebuild. UI maps it to a label.
 */
@Serializable
data class Profile(
    val id: String,
    val displayName: String,
    val avatarUrl: String? = null,
    val accentHue: Int,         // 0-359; per-profile avatar tint for identity
    val parentalLevel: Int = 0, // 0 = no restriction
    val isKidProfile: Boolean = false,
)
