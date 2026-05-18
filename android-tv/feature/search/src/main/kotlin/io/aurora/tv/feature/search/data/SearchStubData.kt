package io.aurora.tv.feature.search.data

import io.aurora.tv.core.ui.media.MediaItem

/**
 * Phase-0 search corpus.
 *
 * Distinct from MoviesStubData / ShowsStubData on purpose — Search ought
 * to surface results the other tabs don't already show, so we exercise
 * the filter UI against titles the user hasn't seen on Home/Movies/Shows.
 * 22 fictional items: a roughly even split of films and shows, varied
 * genres, varied years (2022–2026) so year-substring matches have
 * something to hit.
 *
 * P1 replaces this with /api/v1/search?q=... results.
 */
internal object SearchStubData {

    private fun MediaItem.withArtwork() = copy(
        posterUrl   = "https://picsum.photos/seed/$id/520/780",
        backdropUrl = "https://picsum.photos/seed/$id-bg/1920/1080",
    )

    val ITEMS: List<MediaItem> = listOf(
        MediaItem(
            id = "search-aether-bloom", title = "Aether Bloom", year = 2025,
            runtimeMinutes = 118, rating = "PG-13", genres = listOf("Sci-Fi"),
            description = "A xenobotanist races to catalog a sentient bloom before a corporate harvest fleet arrives.",
            accentHue = 285,
        ),
        MediaItem(
            id = "search-amber-frequency", title = "Amber Frequency", year = 2024,
            runtimeMinutes = 102, rating = "TV-14", genres = listOf("Drama", "Mystery"),
            description = "A radio archivist discovers a 1970s pirate broadcast still being transmitted from an empty island.",
            accentHue = 38,
        ),
        MediaItem(
            id = "search-baker-street-irregulars", title = "Baker Street Irregulars", year = 2023,
            runtimeMinutes = 47, rating = "TV-PG", genres = listOf("Mystery", "Comedy"),
            description = "A modern-day reboot follows the kid informants who actually solve London's strangest cases.",
            accentHue = 12,
        ),
        MediaItem(
            id = "search-bright-static", title = "Bright Static", year = 2026,
            runtimeMinutes = 95, rating = "PG-13", genres = listOf("Sci-Fi", "Thriller"),
            description = "An EMF analyst chasing rogue radiation in the desert finds a crash site that her agency insists doesn't exist.",
            accentHue = 200,
        ),
        MediaItem(
            id = "search-cobalt-tide", title = "Cobalt Tide", year = 2025,
            runtimeMinutes = 110, rating = "R", genres = listOf("Action", "Thriller"),
            description = "A retired diver is pulled into a cobalt-smuggling operation when her brother goes missing off the Congolese coast.",
            accentHue = 220,
        ),
        MediaItem(
            id = "search-conduit", title = "Conduit", year = 2024,
            runtimeMinutes = 52, rating = "TV-MA", genres = listOf("Sci-Fi", "Drama"),
            description = "A municipal engineer realizes the new subway tunnels are routing more than trains.",
            accentHue = 260,
        ),
        MediaItem(
            id = "search-dover-girls", title = "The Dover Girls", year = 2022,
            runtimeMinutes = 113, rating = "PG-13", genres = listOf("Drama"),
            description = "Three sisters reopen their grandmother's cliffside hotel through a ruinous off-season.",
            accentHue = 350,
        ),
        MediaItem(
            id = "search-falconer", title = "Falconer", year = 2026,
            runtimeMinutes = 124, rating = "R", genres = listOf("Thriller"),
            description = "A disgraced falconer trains a peregrine to find evidence the police already buried.",
            accentHue = 28,
        ),
        MediaItem(
            id = "search-glasshouse-summer", title = "Glasshouse Summer", year = 2023,
            runtimeMinutes = 99, rating = "PG", genres = listOf("Comedy", "Drama"),
            description = "A teenage gardener takes over her aunt's failing nursery with a single August to turn it around.",
            accentHue = 105,
        ),
        MediaItem(
            id = "search-half-light-county", title = "Half-Light County", year = 2025,
            runtimeMinutes = 55, rating = "TV-MA", genres = listOf("Mystery", "Drama"),
            description = "A rural sheriff's first month on the job is the same week three bodies surface from a drained reservoir.",
            accentHue = 18,
        ),
        MediaItem(
            id = "search-howl-and-hearth", title = "Howl and Hearth", year = 2024,
            runtimeMinutes = 88, rating = "TV-G", genres = listOf("Animation", "Family"),
            description = "A wolf cub raised in a village bakery has to choose between the family who fed her and the pack calling her home.",
            accentHue = 60,
        ),
        MediaItem(
            id = "search-iron-sundays", title = "Iron Sundays", year = 2026,
            runtimeMinutes = 118, rating = "TV-14", genres = listOf("Drama"),
            description = "A church handbell choir's last season before being disbanded becomes the most ambitious of its 80-year history.",
            accentHue = 320,
        ),
        MediaItem(
            id = "search-kingfisher-protocol", title = "The Kingfisher Protocol", year = 2025,
            runtimeMinutes = 132, rating = "R", genres = listOf("Action", "Thriller"),
            description = "An ex-MI6 ornithologist uses migration patterns to trace a defector across four continents.",
            accentHue = 195,
        ),
        MediaItem(
            id = "search-low-tide-academy", title = "Low Tide Academy", year = 2023,
            runtimeMinutes = 44, rating = "TV-PG", genres = listOf("Comedy"),
            description = "A boarding school perched on a sandbar runs on impossible logistics and terrible cafeteria food.",
            accentHue = 175,
        ),
        MediaItem(
            id = "search-magnolia-protocol", title = "Magnolia Protocol", year = 2024,
            runtimeMinutes = 101, rating = "PG-13", genres = listOf("Thriller"),
            description = "A southern senator's chief of staff finds a dead-drop in her own filing cabinet.",
            accentHue = 332,
        ),
        MediaItem(
            id = "search-northern-lantern", title = "Northern Lantern", year = 2022,
            runtimeMinutes = 96, rating = "PG", genres = listOf("Drama"),
            description = "A lighthouse keeper's daughter inherits the post and discovers her father's logbooks were a coded confession.",
            accentHue = 220,
        ),
        MediaItem(
            id = "search-quietest-mile", title = "The Quietest Mile", year = 2026,
            runtimeMinutes = 109, rating = "PG-13", genres = listOf("Drama", "Sport"),
            description = "A high-school cross-country coach takes one last shot at the state title with a runner who refuses to speak.",
            accentHue = 145,
        ),
        MediaItem(
            id = "search-rain-glass", title = "Rain Glass", year = 2025,
            runtimeMinutes = 48, rating = "TV-14", genres = listOf("Drama"),
            description = "A glassblower navigates the year her studio became a viral sensation against her wishes.",
            accentHue = 290,
        ),
        MediaItem(
            id = "search-saltgrass", title = "Saltgrass", year = 2024,
            runtimeMinutes = 117, rating = "R", genres = listOf("Drama", "Mystery"),
            description = "A marsh ecologist returns to the bayou where her sister vanished a decade ago.",
            accentHue = 88,
        ),
        MediaItem(
            id = "search-thirteenth-bell", title = "The Thirteenth Bell", year = 2026,
            runtimeMinutes = 122, rating = "TV-MA", genres = listOf("Mystery", "Thriller"),
            description = "A campanologist hired to restore a cathedral's bells discovers the tower was never built to hold thirteen.",
            accentHue = 308,
        ),
        MediaItem(
            id = "search-velvet-circuit", title = "Velvet Circuit", year = 2023,
            runtimeMinutes = 50, rating = "TV-MA", genres = listOf("Drama"),
            description = "Behind the curtain of a 1970s drag club, the regulars run a quiet network for runaways.",
            accentHue = 295,
        ),
        MediaItem(
            id = "search-wolfsbane", title = "Wolfsbane", year = 2025,
            runtimeMinutes = 107, rating = "R", genres = listOf("Thriller", "Mystery"),
            description = "A small-town pharmacist starts cataloging the deaths whose tox panels her boss told her to skip.",
            accentHue = 270,
        ),
    ).map { it.withArtwork() }
}
