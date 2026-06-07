package db

// Content-rating ladder — the single source of truth for parental-control
// gating across Aurora. Browse (internal/api/media_handlers.go), taste
// onboarding (queries_onboarding.go), and the recommender all expand a
// profile's max_age_rating through AllowedRatingsForMax so they gate
// identically; a second copy of this ladder would be a drift hazard (a kid
// profile seeing adult content because one copy lagged the other).

// ageRatingOrder keys each rating by an approximate minimum-recommended age so
// the MPAA (movie) and TV-Parental-Guidelines ladders compose correctly when a
// profile's cap is in one system and a title is rated in the other. Only the
// ORDER matters — AllowedRatingsForMax compares with `<=`.
//
// Load-bearing boundaries: R / NC-17 / TV-MA sit ABOVE TV-14, so a TV-14 cap
// does NOT unlock R-rated movies; and PG / TV-PG sit above TV-Y7, so a TV-Y7 cap
// does NOT unlock PG. (The previous coarse 1–5 scale collided R==TV-14,
// NC-17==TV-MA, and PG==TV-Y7, leaking above-rating titles to kid profiles.)
var ageRatingOrder = map[string]int{
	// general / all ages
	"G": 0, "TV-Y": 0, "TV-G": 0,
	// directed to older children
	"TV-Y7": 7,
	// parental guidance
	"PG": 8, "TV-PG": 10,
	// teen
	"PG-13": 13, "TV-14": 14,
	// restricted / mature (17+)
	"R": 17, "TV-MA": 17,
	// adults only
	"NC-17": 18,
}

// AllowedRatingsForMax returns all rating strings whose severity is at or below
// the given max rating. Returns nil when maxRating is empty or unrecognized —
// callers treat nil as "no restriction". The query filters that consume this
// (NearestUnwatched / NearestUnwatchedRich / PopularUnwatched / OnboardingGrid)
// pass through when the allowed slice IS NULL, and otherwise match with
// `content_rating = ANY(allowed)`, which naturally EXCLUDES NULL/empty ratings
// under a restriction — we can't prove an unrated title is safe for a kid.
func AllowedRatingsForMax(maxRating string) []string {
	maxLevel, ok := ageRatingOrder[maxRating]
	if !ok {
		return nil
	}
	var allowed []string
	for rating, level := range ageRatingOrder {
		if level <= maxLevel {
			allowed = append(allowed, rating)
		}
	}
	return allowed
}
