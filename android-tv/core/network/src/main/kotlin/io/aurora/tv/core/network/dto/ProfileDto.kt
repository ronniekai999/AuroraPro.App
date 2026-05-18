package io.aurora.tv.core.network.dto

import kotlinx.serialization.Serializable

/**
 * Wire DTO for the `api/profiles` endpoints. Mirrors `models.UserProfile`
 * in the Go server.
 *
 * `avatarUrl` is a free-form URL the user picks at profile-create time.
 * If empty/null, the UI generates a deterministic colored letter avatar
 * — same approach the Phase-0 profile picker already uses, just keyed
 * on the real profile name now.
 *
 * `maxAgeRating` is the parental-control cap ("PG-13", "TV-MA", etc.).
 * Phase 1 doesn't enforce this client-side; the server filters
 * appropriately when responding to requests scoped by `?profile_id=`.
 *
 * `language` and `subtitleMode` drive playback defaults; not surfaced
 * in the picker UI.
 */
@Serializable
data class UserProfileDto(
    val id: Long,
    val userId: Long,
    val name: String,
    val avatarUrl: String? = null,
    val isDefault: Boolean = false,
    val maxAgeRating: String? = null,
    val language: String = "en",
    val subtitleLang: String? = null,
    val subtitleMode: String = "off",
    val createdAt: String? = null,
    val updatedAt: String? = null,
)
