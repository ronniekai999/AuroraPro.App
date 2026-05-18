package metadata

import (
	"regexp"
	"strings"
	"unicode/utf8"
)

// eqFold is case-insensitive string equality.
func eqFold(a, b string) bool {
	return strings.EqualFold(strings.TrimSpace(a), strings.TrimSpace(b))
}

// containsFold is case-insensitive substring check.
func containsFold(haystack, needle string) bool {
	return strings.Contains(
		strings.ToLower(strings.TrimSpace(haystack)),
		strings.ToLower(strings.TrimSpace(needle)),
	)
}

// levenshteinDistance computes the edit distance between two strings.
// Pure Go implementation with no external dependencies.
func levenshteinDistance(a, b string) int {
	la := utf8.RuneCountInString(a)
	lb := utf8.RuneCountInString(b)

	if la == 0 {
		return lb
	}
	if lb == 0 {
		return la
	}

	ra := []rune(a)
	rb := []rune(b)

	// Use single-row optimization to reduce memory from O(la*lb) to O(lb).
	prev := make([]int, lb+1)
	curr := make([]int, lb+1)

	for j := 0; j <= lb; j++ {
		prev[j] = j
	}

	for i := 1; i <= la; i++ {
		curr[0] = i
		for j := 1; j <= lb; j++ {
			cost := 1
			if ra[i-1] == rb[j-1] {
				cost = 0
			}
			del := prev[j] + 1
			ins := curr[j-1] + 1
			sub := prev[j-1] + cost

			m := del
			if ins < m {
				m = ins
			}
			if sub < m {
				m = sub
			}
			curr[j] = m
		}
		prev, curr = curr, prev
	}
	return prev[lb]
}

// levenshteinSimilarity returns a normalized similarity score (0.0 to 1.0)
// between two strings, where 1.0 means identical.
func levenshteinSimilarity(a, b string) float64 {
	la := utf8.RuneCountInString(a)
	lb := utf8.RuneCountInString(b)
	maxLen := la
	if lb > maxLen {
		maxLen = lb
	}
	if maxLen == 0 {
		return 1.0
	}
	dist := levenshteinDistance(a, b)
	return 1.0 - float64(dist)/float64(maxLen)
}

var (
	articleRe = regexp.MustCompile(`(?i)^(the|a|an)\s+`)
	punctRe   = regexp.MustCompile(`[:''\x60\-]`)
)

// normalizeForMatching produces a canonical form used only for score comparisons.
// Applied symmetrically to both scanned titles and TMDB result titles so that
// "The Office" == "Office" and "Spider-Man" == "Spider Man".
func normalizeForMatching(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	s = articleRe.ReplaceAllString(s, "")
	s = punctRe.ReplaceAllString(s, " ")
	for strings.Contains(s, "  ") {
		s = strings.ReplaceAll(s, "  ", " ")
	}
	return strings.TrimSpace(s)
}

// CleanTitle strips common noise from scanned filenames for better TMDB matching.
func CleanTitle(title string) string {
	// Remove year in parens/brackets that parser already extracted
	title = strings.TrimSpace(title)

	// Replace dots and underscores with spaces (common in filenames)
	title = strings.ReplaceAll(title, ".", " ")
	title = strings.ReplaceAll(title, "_", " ")

	// Collapse multiple spaces
	for strings.Contains(title, "  ") {
		title = strings.ReplaceAll(title, "  ", " ")
	}

	return strings.TrimSpace(title)
}
