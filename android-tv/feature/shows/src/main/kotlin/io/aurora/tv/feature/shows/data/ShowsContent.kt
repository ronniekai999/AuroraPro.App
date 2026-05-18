package io.aurora.tv.feature.shows.data

import io.aurora.tv.core.ui.media.MediaItem

/**
 * Shows-tab content state. Same shape as MoviesContent — the Shows tab is
 * the TV-series equivalent of the Movies catalog.
 *
 * Filter axes match Movies exactly now (Genre / Year / Sort) instead of
 * the original Genre / Network / Sort. Why the change:
 *   - Aurora's server doesn't expose a network field on media items
 *     (the `MediaItem` Go struct has no `network` column; TMDB enrichment
 *     doesn't populate one). Earlier Phase 0 substring-matched against
 *     `(NetworkName)` parentheticals embedded in stub descriptions —
 *     that was a workaround that doesn't survive contact with real data.
 *   - Year is genuinely useful for shows (filter by debut year) and is
 *     server-supported via the same `?year=` query param Movies uses.
 *
 * Network filtering CAN be re-added once the server gains a network
 * field in its TMDB enrichment + a `?network=` query param. For now,
 * Year is the right second axis.
 */
data class ShowsContent(
    val totalCount: Int,
    val items: List<MediaItem>,
    val filters: ShowsFilters,
    val filtersActive: Boolean = false,
)

/**
 * Active filter state. Same axes and types as MoviesFilters now —
 * different package so they don't collide, but structurally identical.
 * If we ever extract a generic `CatalogFilters<G, Y, S>` to share between
 * Movies and Shows, this is the most obvious candidate.
 */
data class ShowsFilters(
    val genre: Genre  = Genre.All,
    val year:  Year   = Year.All,
    val sort:  SortBy = SortBy.TitleAsc,
)

/**
 * Genre filter axis for TV shows.
 *
 * `matchKey` is the EXACT TMDB canonical genre name (server uses
 * case-sensitive comparison). The original Phase-0 implementation used
 * "Sci-Fi" — that returned zero matches against real TMDB data which
 * uses "Science Fiction". The list mirrors what the web Shows page
 * exposes, which is TMDB's standard TV-show genre set.
 *
 * Note that TV genres differ slightly from Movie genres on TMDB
 * (no "Horror" / "Romance" / "TV Movie" — these are movie-only on
 * TMDB; TV has "Action & Adventure", "Sci-Fi & Fantasy", etc. as
 * combined categories). The list below picks the genres that overlap
 * with what Aurora's TV library actually shows on the web client. If
 * users report missing genres, we add them.
 */
sealed class Genre(val label: String, val matchKey: String?) {
    data object All           : Genre("All Genres",      null)
    data object ActionAdv     : Genre("Action & Adventure", "Action & Adventure")
    data object Animation     : Genre("Animation",       "Animation")
    data object Comedy        : Genre("Comedy",          "Comedy")
    data object Crime         : Genre("Crime",           "Crime")
    data object Documentary   : Genre("Documentary",     "Documentary")
    data object Drama         : Genre("Drama",           "Drama")
    data object Family        : Genre("Family",          "Family")
    data object Kids          : Genre("Kids",            "Kids")
    data object Mystery       : Genre("Mystery",         "Mystery")
    data object News          : Genre("News",            "News")
    data object Reality       : Genre("Reality",         "Reality")
    data object SciFiFantasy  : Genre("Sci-Fi & Fantasy", "Sci-Fi & Fantasy")
    data object Soap          : Genre("Soap",            "Soap")
    data object Talk          : Genre("Talk",            "Talk")
    data object WarPolitics   : Genre("War & Politics",  "War & Politics")
    data object Western       : Genre("Western",         "Western")

    companion object {
        // `get()` accessor (not eager `val`) to dodge a Kotlin
        // class-loading / Compose composition timing issue where eagerly-
        // initialized companion lists referencing nested data objects can
        // capture nulls. See Movies' Genre.Companion docstring for the
        // full rationale.
        val options: List<Genre> get() = listOf(
            All, ActionAdv, Animation, Comedy, Crime, Documentary,
            Drama, Family, Kids, Mystery, News, Reality, SciFiFantasy,
            Soap, Talk, WarPolitics, Western,
        )
    }
}

/**
 * Year filter axis. Same shape and approach as Movies' Year — a
 * `data class` with a programmatic factory generating 1900–2030. See
 * Movies' Year docstring for why this isn't a sealed class.
 */
data class Year(val label: String, val value: Int?) {
    companion object {
        val All: Year = Year(label = "All Years", value = null)

        val options: List<Year> get() =
            listOf(All) + (2030 downTo 1900).map { y -> Year(label = y.toString(), value = y) }
    }
}

/**
 * Sort-order axis. Identical to Movies' SortBy — same labels, same
 * server-key mapping. Keeping a separate type per feature module
 * avoids cross-module coupling, at the cost of duplication. If the
 * pattern stays stable through Slice E (My Library, Requests) we can
 * promote a single CatalogSortBy to core/ui.
 */
sealed class SortBy(val label: String, val serverKey: String?) {
    data object TitleAsc       : SortBy("Title (A–Z)",       serverKey = "title")
    data object YearDesc       : SortBy("Year (newest)",     serverKey = "year")
    data object YearAsc        : SortBy("Year (oldest)",     serverKey = null)
    data object RuntimeDesc    : SortBy("Runtime (longest)", serverKey = null)
    data object RuntimeAsc     : SortBy("Runtime (shortest)", serverKey = null)

    companion object {
        // See Genre.Companion.options for why this is a `get()` accessor.
        val options: List<SortBy> get() = listOf(
            TitleAsc, YearDesc, YearAsc, RuntimeDesc, RuntimeAsc,
        )
    }
}
