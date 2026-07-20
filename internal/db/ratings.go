package db

import "strings"

// Content-rating ladder — the single source of truth for parental-control
// gating across Aurora. Browse (internal/api/media_handlers.go), taste
// onboarding (queries_onboarding.go), the recommender, and the LLM-blurb
// tone gates (internal/reasonguard) all derive from this ladder — gating
// via AllowedRatingsForMax, tone buckets via IsMatureRating/IsKidRating —
// so they can never disagree; a second copy of this ladder would be a drift
// hazard (a kid profile seeing adult content because one copy lagged the
// other).

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

// Tone buckets for LLM-blurb vetting (internal/reasonguard), derived from
// the SAME ladder as parental gating so the two definitions of "mature" and
// "kid" can never drift apart. Ratings the ladder doesn't know (foreign
// systems, empty) land in NEITHER bucket — vetting must not assume maturity
// it can't prove, and adding a system means extending ageRatingOrder, not
// growing a parallel list.
const (
	// matureRatingMinLevel: R / TV-MA (17) and above.
	matureRatingMinLevel = 17
	// kidRatingMaxLevel: G / TV-Y / TV-G (0) through TV-Y7 (7). PG and up
	// are deliberately excluded — PG covers Gremlins-grade content.
	kidRatingMaxLevel = 7
)

// ratingLevel resolves a rating to its ladder level, tolerating case and
// surrounding whitespace (ladder keys are canonical uppercase).
func ratingLevel(rating string) (int, bool) {
	lvl, ok := ageRatingOrder[strings.ToUpper(strings.TrimSpace(rating))]
	return lvl, ok
}

// IsMatureRating reports whether the rating sits at the restricted/adult end
// of the ladder (R, TV-MA, NC-17). Unknown or empty ratings return false.
func IsMatureRating(rating string) bool {
	lvl, ok := ratingLevel(rating)
	return ok && lvl >= matureRatingMinLevel
}

// IsKidRating reports whether the rating is an all-ages / older-children
// rating (G, TV-Y, TV-G, TV-Y7). Unknown or empty ratings return false.
func IsKidRating(rating string) bool {
	lvl, ok := ratingLevel(rating)
	return ok && lvl <= kidRatingMaxLevel
}
