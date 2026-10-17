package db

import (
	"sort"
	"strings"
)

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
// the given max rating. Returns nil only when maxRating is empty — callers treat
// nil as "no restriction". The query filters that consume this
// (NearestUnwatched / NearestUnwatchedRich / PopularUnwatched / OnboardingGrid)
// pass through when the allowed slice IS NULL, and otherwise match with
// `content_rating = ANY(allowed)`, which naturally EXCLUDES NULL/empty ratings
// under a restriction — we can't prove an unrated title is safe for a kid.
//
// maxRating is matched ignoring case and surrounding whitespace, so a stored
// "pg" means PG. A non-empty ceiling the ladder doesn't know fails CLOSED to the
// all-ages tier: someone set it to restrict, and lifting every restriction
// because of a typo is the wrong way to fail. (It must not return an empty
// slice either — callers read an empty slice as "no restriction".) New values
// are validated on write by CanonicalMaxRating, so this covers legacy rows.
func AllowedRatingsForMax(maxRating string) []string {
	if strings.TrimSpace(maxRating) == "" {
		return nil
	}
	maxLevel, ok := ratingLevel(maxRating)
	if !ok {
		maxLevel = 0
	}
	var allowed []string
	for rating, level := range ageRatingOrder {
		if level <= maxLevel {
			allowed = append(allowed, rating)
		}
	}
	return allowed
}

// CanonicalMaxRating validates a profile ceiling on write. It returns the
// ladder's spelling of the rating ("pg " → "PG"), "" for no restriction, and
// ok=false for anything the ladder doesn't know, so a value that would
// silently restrict nothing (or, read back, everything) is rejected up front.
func CanonicalMaxRating(maxRating string) (string, bool) {
	r := strings.ToUpper(strings.TrimSpace(maxRating))
	if r == "" {
		return "", true
	}
	if _, ok := ageRatingOrder[r]; !ok {
		return "", false
	}
	return r, true
}

// MaxRatingChoices lists the ratings a profile ceiling may be set to, from
// most to least restrictive, for validation messages.
func MaxRatingChoices() []string {
	choices := make([]string, 0, len(ageRatingOrder))
	for rating := range ageRatingOrder {
		choices = append(choices, rating)
	}
	sort.Slice(choices, func(i, j int) bool {
		li, lj := ageRatingOrder[choices[i]], ageRatingOrder[choices[j]]
		if li != lj {
			return li < lj
		}
		return choices[i] < choices[j]
	})
	return choices
}

// RatingAllowed reports whether contentRating is permitted under maxRating's
// ceiling — the single check every read/playback and discovery gate should
// call (issue #462) so "unrestricted", "restricted", and "unrated under a
// restriction" can never be decided two different ways. Fail-closed by
// construction: AllowedRatingsForMax's returned slice never contains "", so
// an empty/unrated contentRating is excluded whenever maxRating imposes any
// restriction, matching its documented NULL-exclusion behavior. An unknown
// non-empty maxRating restricts to the all-ages tier, as AllowedRatingsForMax.
func RatingAllowed(maxRating, contentRating string) bool {
	allowed := AllowedRatingsForMax(maxRating)
	if allowed == nil {
		return true
	}
	for _, r := range allowed {
		if r == contentRating {
			return true
		}
	}
	return false
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
