package io.aurora.tv.navigation

import kotlinx.serialization.Serializable

/**
 * Type-safe route definitions for Compose Navigation 2.8+.
 *
 * Using @Serializable data objects/classes instead of string routes gives us
 * compile-time safety on destination transitions — a bug class that plagued
 * earlier Compose nav versions (wrong string → silent no-op). Each screen
 * that accepts args declares them as properties on its Route.
 */
sealed interface Route {
    @Serializable data object SignIn : Route
    @Serializable data object Profiles : Route
    @Serializable data object Home : Route
    @Serializable data object Movies : Route
    @Serializable data object Shows : Route
    @Serializable data object Search : Route

    /**
     * Three right-cluster overlay destinations triggered by TopNavBar icons.
     * Like Search, none of these are tab destinations — they're reached
     * from the magnifying-glass / Groups / Settings / Profile icons in the
     * bar's right cluster. Each screen has its own `onBack` rather than a
     * tab-based exit.
     *
     * `Account` rather than `Profile` to avoid name collision with the
     * existing `feature/profiles` (multi-profile picker / "Who's watching?").
     * The user-facing page header still reads "Profile" — only the code
     * route is named differently for readability.
     */
    @Serializable data object WatchParty : Route
    @Serializable data object Settings : Route
    @Serializable data object Account : Route

    /**
     * Detail screen — receives the server-side media id only.
     *
     * Earlier this was `data class Detail(val itemJson: String)` carrying
     * a full JSON-encoded MediaItem. That worked for stub data but had
     * two real problems against the live server:
     *  1. Schema drift risk: if MediaItem fields change between when the
     *     nav arg was written and when it's read (process death + app
     *     update), `Json.decodeFromString` would throw and crash the
     *     screen. (Audit finding M1.)
     *  2. Stale data: the nav arg captured a snapshot of the item at
     *     poster-click time; if the user navigated to detail while the
     *     server's record changed, the screen would render the old data
     *     forever instead of the latest.
     *
     * Now Detail just carries the server's primary key. The screen calls
     * `AuroraApi.getMedia(id)` on entry and renders fresh data from a
     * single source of truth. Both problems disappear.
     */
    @Serializable data class Detail(val id: Long) : Route
}
