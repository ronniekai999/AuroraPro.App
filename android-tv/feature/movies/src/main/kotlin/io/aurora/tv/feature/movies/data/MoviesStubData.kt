package io.aurora.tv.feature.movies.data

import io.aurora.tv.core.ui.media.MediaItem

/**
 * Phase-0 movies-tab fixtures.
 *
 * Flat list of 24 fictional movies — no genre grouping (the web Movies
 * page is a uniform grid of all films, not a categorized browse). Items
 * span Action, Drama, Sci-Fi, Thriller, Comedy, and Mystery so the grid
 * has visual variety in each visible row.
 *
 * Sort order in this stub follows the default Sort:Title filter — items
 * are alphabetical-ish by title so the grid reads as "ordered library."
 *
 * Hue values spread around the wheel so the gradient placeholders that
 * render before Coil resolves real artwork show genre variety.
 */
internal object MoviesStubData {

    private fun MediaItem.withArtwork() = copy(
        posterUrl   = "https://picsum.photos/seed/$id/520/780",
        backdropUrl = "https://picsum.photos/seed/$id-bg/1920/1080",
    )

    /** Library snapshot — exposed so the ViewModel can apply filters/sort
     *  and recompute the visible grid. Phase 0 is in-memory; P1 fetches
     *  from /api/v1/movies. */
    val ITEMS: List<MediaItem> get() = items

    private val items: List<MediaItem> = listOf(
        MediaItem(
            id = "movies-blue-orchard", title = "The Blue Orchard", year = 2026,
            runtimeMinutes = 111, rating = "PG", genres = listOf("Sci-Fi"),
            description = "A botanist on a generation ship discovers her grandmother's apple varietals are mutating into something that feeds people in their sleep.",
            accentHue = 145,
        ),
        MediaItem(
            id = "movies-borrowed-horses", title = "Borrowed Horses", year = 2024,
            runtimeMinutes = 113, rating = "TV-14", genres = listOf("Drama"),
            description = "Two estranged half-sisters take their father's racing stable through a season they're not equipped to manage.",
            accentHue = 50,
        ),
        MediaItem(
            id = "movies-burn-after-midnight", title = "Burn After Midnight", year = 2025,
            runtimeMinutes = 98, rating = "R", genres = listOf("Action", "Thriller"),
            description = "A small-town arson investigator and a city journalist trace a chain of fires back to a forty-year-old grudge.",
            accentHue = 22,
        ),
        MediaItem(
            id = "movies-cherry-year-twelve", title = "Cherry Year Twelve", year = 2026,
            runtimeMinutes = 104, rating = "TV-14", genres = listOf("Drama"),
            description = "A seventh-grade teacher returns to the school she dropped out of and recognizes one of her students from a photograph she's never seen.",
            accentHue = 320,
        ),
        MediaItem(
            id = "movies-cold-exit", title = "Cold Exit", year = 2025,
            runtimeMinutes = 113, rating = "R", genres = listOf("Action"),
            description = "A retired CIA exfiltration specialist gets pulled back in when the man she once smuggled out of Tehran shows up dead in Anchorage.",
            accentHue = 240,
        ),
        MediaItem(
            id = "movies-daughterhouse-road", title = "Daughterhouse Road", year = 2026,
            runtimeMinutes = 121, rating = "TV-MA", genres = listOf("Mystery"),
            description = "A homicide detective inherits her late mother's diary and realizes every page predicts a crime that's about to happen.",
            accentHue = 280,
        ),
        MediaItem(
            id = "movies-driftwood", title = "Driftwood", year = 2024,
            runtimeMinutes = 96, rating = "PG", genres = listOf("Drama"),
            description = "A woodworker rebuilds her late wife's last commission from photographs after a fire destroys the original.",
            accentHue = 25,
        ),
        MediaItem(
            id = "movies-glassbower", title = "The Glassbower", year = 2025,
            runtimeMinutes = 119, rating = "TV-14", genres = listOf("Drama"),
            description = "Three generations of glassblowers run a single furnace through a winter that decides whether the studio survives or closes for good.",
            accentHue = 350,
        ),
        MediaItem(
            id = "movies-high-meridian", title = "High Meridian", year = 2026,
            runtimeMinutes = 119, rating = "PG-13", genres = listOf("Adventure"),
            description = "A solo sailor caught in a freak Pacific gyre meets a research crew that's been waiting for someone exactly like her for thirty years.",
            accentHue = 175,
        ),
        MediaItem(
            id = "movies-hummingbird-station", title = "Hummingbird Station", year = 2025,
            runtimeMinutes = 92, rating = "G", genres = listOf("Animation", "Family"),
            description = "An orphaned hummingbird raised at a research station has to find its way back to a flock that doesn't know it exists.",
            accentHue = 320,
        ),
        MediaItem(
            id = "movies-ironwill-bay", title = "Ironwill Bay", year = 2025,
            runtimeMinutes = 124, rating = "R", genres = listOf("Action", "Thriller"),
            description = "A Coast Guard captain has six hours to evacuate a deepwater rig before a storm — and someone on board doesn't want anyone to leave.",
            accentHue = 12,
        ),
        MediaItem(
            id = "movies-last-orbit", title = "The Last Orbit", year = 2026,
            runtimeMinutes = 142, rating = "PG-13", genres = listOf("Sci-Fi"),
            description = "Three astronauts watch the world they grew up in end from above, and have to decide what to do with a year of supplies and no one to come home to.",
            accentHue = 195,
        ),
        MediaItem(
            id = "movies-marble-house", title = "Marble House", year = 2025,
            runtimeMinutes = 108, rating = "TV-MA", genres = listOf("Drama", "Mystery"),
            description = "A historian moves into the inherited estate her family has avoided for sixty years and finds a logbook from someone with her own handwriting.",
            accentHue = 295,
        ),
        MediaItem(
            id = "movies-night-line", title = "Night Line", year = 2026,
            runtimeMinutes = 128, rating = "TV-MA", genres = listOf("Action", "Thriller"),
            description = "A late-shift train operator discovers her route is being used to move stolen evidence — and the only person she can trust is the conductor she's been arguing with for ten years.",
            accentHue = 220,
        ),
        MediaItem(
            id = "movies-northwest-quiet", title = "Northwest Quiet", year = 2025,
            runtimeMinutes = 102, rating = "PG", genres = listOf("Drama"),
            description = "A wildfire-evacuation driver makes the same hundred-mile loop until the night the fire catches him.",
            accentHue = 30,
        ),
        MediaItem(
            id = "movies-orbital-drift", title = "Orbital Drift", year = 2025,
            runtimeMinutes = 128, rating = "PG-13", genres = listOf("Sci-Fi", "Adventure"),
            description = "A salvage crew finds a thirty-year-old derelict space station with a logbook entry dated three days ago.",
            accentHue = 260,
        ),
        MediaItem(
            id = "movies-paper-hour", title = "Paper Hour", year = 2024,
            runtimeMinutes = 101, rating = "PG-13", genres = listOf("Comedy", "Drama"),
            description = "A failing newspaper's last reporter agrees to one final story about the town's centenarian — who has plans of her own.",
            accentHue = 70,
        ),
        MediaItem(
            id = "movies-red-corvette", title = "Red Corvette", year = 2026,
            runtimeMinutes = 109, rating = "PG-13", genres = listOf("Comedy", "Drama"),
            description = "An estranged father and son drive a 1972 Stingray across four states for a funeral neither of them was invited to.",
            accentHue = 0,
        ),
        MediaItem(
            id = "movies-salt-and-iron", title = "Salt and Iron", year = 2026,
            runtimeMinutes = 116, rating = "R", genres = listOf("Drama", "Thriller"),
            description = "A blacksmith and a fishmonger feud over a single block of their coastal town — until the storm of the century forces them onto the same boat.",
            accentHue = 35,
        ),
        MediaItem(
            id = "movies-signal-delay", title = "Signal Delay", year = 2026,
            runtimeMinutes = 134, rating = "PG-13", genres = listOf("Sci-Fi"),
            description = "A radio operator in 2089 starts receiving messages from a satellite that was lost in 1972, with timestamps from next Tuesday.",
            accentHue = 200,
        ),
        MediaItem(
            id = "movies-third-anchor", title = "Third Anchor", year = 2024,
            runtimeMinutes = 110, rating = "PG", genres = listOf("Drama"),
            description = "A fishing-boat captain has to choose between her family's last vessel and the niece who needs the money it's worth.",
            accentHue = 200,
        ),
        MediaItem(
            id = "movies-velocity-clause", title = "The Velocity Clause", year = 2024,
            runtimeMinutes = 107, rating = "PG-13", genres = listOf("Thriller"),
            description = "A logistics analyst at a global shipping firm finds a routing pattern that suggests one of their captains is helping someone disappear.",
            accentHue = 168,
        ),
        MediaItem(
            id = "movies-window-seat", title = "Window Seat", year = 2025,
            runtimeMinutes = 94, rating = "PG", genres = listOf("Comedy"),
            description = "Two strangers seated together for a transatlantic flight realize they've been writing the same novel for ten years.",
            accentHue = 60,
        ),
        MediaItem(
            id = "movies-yellow-line", title = "Yellow Line", year = 2026,
            runtimeMinutes = 105, rating = "TV-14", genres = listOf("Drama"),
            description = "A subway dispatcher's last shift before retirement turns into the longest night of her career.",
            accentHue = 45,
        ),
    ).map { it.withArtwork() }

    val CONTENT: MoviesContent = MoviesContent(
        // 2,380 fakes the impressive library size from the web design
        // reference. Real value comes from /api/v1/movies/count in P1.
        // Phase 0 displays this number even though only `items.size`
        // are actually viewable — the count establishes the "this is a
        // big library" feel without us having to ship 2,380 fixtures.
        totalCount = 2380,
        items      = items,
        filters    = MoviesFilters(),
    )
}
