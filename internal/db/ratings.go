package db

// Content-rating ladder — the single source of truth for parental-control
// gating across Aurora. Browse (internal/api/media_handlers.go), taste
// onboarding (queries_onboarding.go), and the recommender all expand a
// profile's max_age_rating through AllowedRatingsForMax so they gate
// identically; a second copy of this ladder would be a drift hazard (a kid
// profile seeing adult content because one copy lagged the other).

// ageRatingOrder maps content rating strings to a numeric severity level.
// Both MPAA (movie) and TV Parental Guidelines ratings are supported.
var ageRatingOrder = map[string]int{
	"G": 1, "PG": 2, "PG-13": 3, "R": 4, "NC-17": 5,
	"TV-Y": 1, "TV-Y7": 2, "TV-G": 2, "TV-PG": 3, "TV-14": 4, "TV-MA": 5,
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
