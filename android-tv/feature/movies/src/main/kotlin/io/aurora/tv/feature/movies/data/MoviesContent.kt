package io.aurora.tv.feature.movies.data

import io.aurora.tv.core.ui.media.MediaItem

/**
 * Movies-tab content state.
 *
 * Different shape from HomeContent — the Movies tab is a *catalog view*,
 * not a categorized browse view. The web app's Movies page renders as a
 * filtered grid of all films in the library, with Genre/Year/Sort filters
 * at the top and a count of total movies. There's no hero or genre rows
 * — just title, filters, and a uniform grid.
 *
 * `totalCount` is the underlying library size (in production, the server
 * tells us how many movies exist). `items` is the *currently-displayed*
 * subset after filters. When filters are active, `items.size` is the
 * filtered count; otherwise it equals the unfiltered library snapshot.
 */
data class MoviesContent(
    val totalCount: Int,
    val items: List<MediaItem>,
    val filters: MoviesFilters,
    val filtersActive: Boolean = false,
)

/**
 * Active filter state. Each axis (genre/year/sort) is a typed sealed value
 * with a label baked in — the UI can render `filter.label` directly without
 * a separate display-string lookup, and the ViewModel can pattern-match on
 * the sealed type when applying filter logic.
 */
data class MoviesFilters(
    val genre: Genre = Genre.All,
    val year:  Year  = Year.All,
    val sort:  SortBy = SortBy.TitleAsc,
)

/**
 * Genre filter axis.
 *
 * `matchKey` is the EXACT string Aurora's server compares against the
 * media item's `genres` list. The server populates that list from TMDB,
 * which uses canonical names like "Science Fiction" (NOT "Sci-Fi"). The
 * comparison is case-sensitive, so a label/matchKey mismatch silently
 * returns zero results — that's the bug we hit when the original list
 * had `Sci-Fi` and the server had `Science Fiction`.
 *
 * The list mirrors what the web app shows (TMDB's standard genre set
 * minus Documentary and Music, which Aurora's library doesn't contain).
 * If you add a new genre, the matchKey MUST match TMDB's canonical
 * genre name verbatim.
 */
sealed class Genre(val label: String, val matchKey: String?) {
    data object All           : Genre("All Genres",      null)
    data object Action        : Genre("Action",          "Action")
    data object Adventure     : Genre("Adventure",       "Adventure")
    data object Animation     : Genre("Animation",       "Animation")
    data object Comedy        : Genre("Comedy",          "Comedy")
    data object Crime         : Genre("Crime",           "Crime")
    data object Drama         : Genre("Drama",           "Drama")
    data object Family        : Genre("Family",          "Family")
    data object Fantasy       : Genre("Fantasy",         "Fantasy")
    data object History       : Genre("History",         "History")
    data object Horror        : Genre("Horror",          "Horror")
    data object Mystery       : Genre("Mystery",         "Mystery")
    data object Romance       : Genre("Romance",         "Romance")
    data object ScienceFiction: Genre("Science Fiction", "Science Fiction")
    data object TVMovie       : Genre("TV Movie",        "TV Movie")
    data object Thriller      : Genre("Thriller",        "Thriller")
    data object War           : Genre("War",             "War")
    data object Western       : Genre("Western",         "Western")

    companion object {
        // `get()` accessor, NOT `val options = listOf(...)`, on purpose.
        //
        // Eagerly-initialized companion lists referencing nested
        // `data object`s of the enclosing sealed class hit a Kotlin
        // class-loading order issue: under Compose's deferred lambda
        // composition (the popup body composes in a separate composition
        // tree), some data-object references can be observed as null
        // inside `listOf(All, ...)` if the companion `<clinit>` runs in
        // a moment where the nested data-object classes haven't fully
        // resolved their `INSTANCE` fields. The result is `option == null`
        // inside `options.forEachIndexed { ... labelOf(option) }`,
        // crashing with NPE on the labelOf lambda's non-null `it`.
        //
        // A `get()` accessor builds the list each time it's called — by
        // then every data object is guaranteed initialized. The cost is
        // a fresh List allocation per access (~18 elements; trivial).
        val options: List<Genre> get() = listOf(
            All, Action, Adventure, Animation, Comedy, Crime,
            Drama, Family, Fantasy, History, Horror, Mystery,
            Romance, ScienceFiction, TVMovie, Thriller, War, Western,
        )
    }
}

/**
 * Year filter axis. "All Years" disables year filtering; specific years
 * carry an Int value passed to Aurora's `?year=N` query param.
 *
 * Why a `data class` rather than `sealed class` with a `data object` per
 * year (the original design): the year range is large (~130 years) and
 * grows annually. Hardcoding 130 data objects would be tedious and
 * brittle — the `data class` approach lets us generate the list with a
 * one-liner range while keeping the same equality, label, and value
 * semantics that the rest of the code depends on.
 *
 * `MoviesFilters.year == Year.All` still works (data class equality);
 * `filters.year.label` still renders the dropdown text; `filters.year.value`
 * still feeds the API. Nothing in the codebase pattern-matches on Year
 * variants — it just reads `value` and compares against `Year.All` —
 * so the sealed class wasn't earning its keep.
 *
 * Range: 1900–2030 covers silent-era classics through near-future
 * releases. The FilterMenu is scrollable so menu length isn't a UX
 * concern. Future improvement: fetch the actual years present in the
 * user's library from the server (would need a new endpoint) so the
 * dropdown shows only years with content.
 */
data class Year(val label: String, val value: Int?) {
    companion object {
        /** Sentinel meaning "no year filter active." */
        val All: Year = Year(label = "All Years", value = null)

        /**
         * `get()` accessor (not eager `val`) so the list is rebuilt each
         * time it's accessed. Cheap (~130 entries, single Range mapping)
         * and avoids any Compose composition timing surprises with
         * captured-at-init lists.
         */
        val options: List<Year> get() =
            listOf(All) + (2030 downTo 1900).map { y -> Year(label = y.toString(), value = y) }
    }
}

/**
 * Sort-order axis. Default is TitleAsc — same as the web Movies page.
 * "Runtime longest first" / "shortest first" round out the affordances
 * a user browsing a 2,000-film library actually wants.
 *
 * `serverKey` is the value Aurora's `/api/media?sort_by=` accepts. The
 * server only natively supports `"title"`, `"year"` (DESC), and `"rating"`
 * (DESC) — see internal/db/queries.go. For the unsupported sort modes
 * (`YearAsc`, `RuntimeDesc`, `RuntimeAsc`) the field is `null`; the
 * ViewModel post-sorts client-side after fetching with server defaults.
 * That keeps the user's selection honest while we expand server support.
 */
sealed class SortBy(val label: String, val serverKey: String?) {
    data object TitleAsc       : SortBy("Title (A–Z)",       serverKey = "title")
    data object YearDesc       : SortBy("Year (newest)",     serverKey = "year")
    data object YearAsc        : SortBy("Year (oldest)",     serverKey = null)
    data object RuntimeDesc    : SortBy("Runtime (longest)", serverKey = null)
    data object RuntimeAsc     : SortBy("Runtime (shortest)", serverKey = null)

    companion object {
        // See Genre.Companion.options for why this is a `get()` accessor
        // rather than an eager `val`. Same init-order issue applies.
        val options: List<SortBy> get() = listOf(
            TitleAsc, YearDesc, YearAsc, RuntimeDesc, RuntimeAsc,
        )
    }
}
