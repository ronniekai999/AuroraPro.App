package io.aurora.tv.core.network.dto

import kotlinx.serialization.Serializable

/**
 * Wire DTOs for the auth endpoints. These mirror Aurora's Go structs in
 * `internal/models/models.go` exactly. Field names are camelCase Kotlin;
 * the snake_case naming strategy on the shared `Json` (NetworkModule)
 * handles the wire-format conversion.
 */

@Serializable
data class LoginRequest(
    val username: String,
    val password: String,
)

@Serializable
data class RefreshRequest(
    val refreshToken: String,
)

@Serializable
data class TokenResponse(
    val accessToken: String,
    val refreshToken: String,
    /** Seconds until the access token expires. */
    val expiresIn: Long,
    val user: UserDto,
)

/**
 * Server-side User. The Go struct hides the password hash via `json:"-"`,
 * so it's not present on the wire and not modeled here. `avatarUrl` and
 * timestamps are nullable on the wire (Go's `omitempty` + `time.Time` zero
 * values), so we keep them nullable here for safety even though Aurora
 * always populates `created_at`/`updated_at`.
 */
@Serializable
data class UserDto(
    val id: Long,
    val username: String,
    val email: String,
    /** "admin" | "user" — Aurora's UserRole enum. */
    val role: String,
    val avatarUrl: String? = null,
    val createdAt: String? = null,
    val updatedAt: String? = null,
)
