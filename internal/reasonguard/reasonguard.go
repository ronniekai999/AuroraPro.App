// Package reasonguard vets LLM-written recommendation blurbs ("reasons")
// against an item's real metadata before they reach any user surface. It is
// shared by every surface that attaches model-written reason text — the
// recommender's hero pool, discover rails, and rail-reason fill, and the
// semantic search reranker — so the enforcement cannot drift per-surface.
//
// Every reason prompt instructs the model to stay ≤ 80 characters and to keep
// tone consistent with the item's listed genres and content rating.
// Production screenshots (2026-07-20) showed the fast chat model ignoring
// both rules at once on the hero surface:
//
//	"Because you watched The Haunted Mansion (2003) — Comedy, Family,
//	 Fantasy, Mystery, this R-rated horror matches the supernatural mystery
//	 genre with a family-friendly fantasy edge."   (~180 chars, for The
//	 Exorcist [R] — "family-friendly" is a direct contradiction)
//
// Prompt-only rules are advisory to a small local model; this guard makes
// them load-bearing. The degradation contract on a dropped reason is always
// safe: the hero renders its "Featured" badge with no blurb, a rail card
// falls back to its "Because you watched X" anchor caption, a discover pick
// or search hit renders without a caption. A hidden blurb beats a
// contradictory one.
//
// The tone checks are deliberately CONSERVATIVE — they only fire when the
// metadata makes the contradiction unambiguous:
//
//   - dark-tone words are rejected only when EVERY listed genre is a light
//     one (pure Comedy/Family/Romance…). Any hybrid (Comedy+Horror, or an
//     unrecognized genre) disables the check, so "Cult horror with comedic
//     undertones" survives for a horror-comedy.
//   - family-friendly words are rejected only for explicitly mature ratings
//     and explicit-gore words only for explicitly kid ratings, both derived
//     from the canonical content-rating ladder (db.IsMatureRating /
//     db.IsKidRating — internal/db/ratings.go is the single source of truth;
//     a local copy of the buckets would be exactly the drift hazard its
//     header warns about). Unknown or absent ratings skip both gates.
//   - known benign idioms that CONTAIN a banned word ("dark comedy",
//     "graphic novel") are blanked out before the scan, so a legitimate
//     "Dark comedy like Fargo" survives on a pure-comedy item while a bare
//     "dark, atmospheric tone" still trips the gate.
//
// False positives just hide a blurb; false negatives show a wrong one — the
// lists are tuned to prefer the former only where the signal is clear.
package reasonguard

import (
	"log/slog"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/aurora-media/aurora/internal/db"
)

// maxRunes is the hard length ceiling for an LLM reason. The prompts ask for
// ≤ 80 characters; we allow 1.5x slack for models that run slightly long, and
// DROP (not truncate) anything past it — the observed overlong blurbs ramble
// into metadata echoes and contradictions, so a truncated one would still
// read as garbage.
const maxRunes = 120

// lightToneGenres are genres that, when they make up ALL of an item's genre
// tags, mark it as unambiguously light-toned. Lowercase exact-match against
// the item's genre strings. Deliberately excludes ambiguous tags (Animation,
// Fantasy, Adventure…) — their presence disables the dark-tone check rather
// than risking a wrong drop.
var lightToneGenres = map[string]struct{}{
	"comedy":    {},
	"family":    {},
	"kids":      {},
	"children":  {},
	"romance":   {},
	"music":     {},
	"musical":   {},
	"reality":   {},
	"sitcom":    {},
	"stand-up":  {},
	"stand up":  {},
	"talk":      {},
	"talk show": {},
	"variety":   {},
	"game show": {},
}

// benignPhrases are idioms that CONTAIN a banned word in a non-contradictory
// sense. They are blanked out of the (lowercased) text before the word scan.
// "darkly" needs no entry — word-boundary matching already keeps it from
// tripping "dark".
var benignPhrases = []string{
	"dark comedy", "dark humor", "dark humour",
	"graphic novel", "graphic-novel",
}

// darkToneWords contradict an all-light-genre item. Mirrors the examples the
// system prompts already ban ("dark", "supernatural [drama]", "tense",
// "haunting", "action-thriller") plus close synonyms. Genre-phrase forms
// ("supernatural drama") are listed instead of bare genre words
// ("supernatural") so "Supernatural comedy like Ghostbusters" survives.
// Rating words ("r-rated") deliberately do NOT belong here: an R-rated pure
// comedy accurately described as "R-rated comedy" is not a contradiction —
// rating words are policed by the rating-keyed gates only.
var darkToneWords = []string{
	"dark", "haunting", "sinister", "terrifying", "chilling", "grim",
	"macabre", "disturbing", "tense", "eerie", "bleak",
	"supernatural drama", "supernatural thriller", "supernatural horror",
	"psychological thriller", "action-thriller", "action thriller",
	"horror-thriller", "horror thriller",
}

// familyToneWords contradict a mature-rated (R/TV-MA/NC-17) item. From the
// same prompt rule: "never frame an [R]/[TV-MA] pick as wholesome or
// family-friendly". "Gentle" is deliberately absent — an R-rated drama can
// genuinely be a gentle character study (R for language alone); only explicit
// family-audience claims are unambiguous.
var familyToneWords = []string{
	"family-friendly", "family friendly", "kid-friendly", "kid friendly",
	"wholesome", "for the whole family", "family fun", "all ages",
	"family-safe", "family safe",
}

// explicitToneWords contradict a kid-rated (G/TV-Y/TV-G/TV-Y7) item.
var explicitToneWords = []string{
	"gory", "graphic", "explicit", "brutal", "bloody", "gruesome",
	"erotic", "r-rated",
}

// Vet validates one LLM-written reason blurb against the item's real
// metadata and returns the cleaned reason, or "" when the blurb must be
// dropped. genres and contentRating may be empty — each gate simply skips
// when its metadata is absent, so a failed annotate degrades to length-only
// vetting rather than dropping everything.
func Vet(reason string, genres []string, contentRating string) string {
	r := stripWrappingQuotes(strings.TrimSpace(reason))
	if r == "" {
		return ""
	}
	if utf8.RuneCountInString(r) > maxRunes {
		drop("overlong", r, genres, contentRating)
		return ""
	}
	scan := neutralizeBenignPhrases(strings.ToLower(r))
	if db.IsMatureRating(contentRating) && containsAnyWord(scan, familyToneWords) {
		drop("family-tone-on-mature-rating", r, genres, contentRating)
		return ""
	}
	if db.IsKidRating(contentRating) && containsAnyWord(scan, explicitToneWords) {
		drop("explicit-tone-on-kid-rating", r, genres, contentRating)
		return ""
	}
	if allLightGenres(genres) && containsAnyWord(scan, darkToneWords) {
		drop("dark-tone-on-light-genres", r, genres, contentRating)
		return ""
	}
	return r
}

// drop logs a vetting rejection. Debug level: drops are an expected,
// self-healing degradation (the surface falls back to its no-reason render),
// but the cause label keeps them diagnosable when tuning the word lists.
func drop(cause, reason string, genres []string, contentRating string) {
	slog.Debug("reasonguard: dropped LLM reason",
		"cause", cause, "reason", reason,
		"genres", strings.Join(genres, ","), "content_rating", contentRating)
}

// stripWrappingQuotes removes a symmetric quote wrapper (models wrap output
// in quotes despite the "no quotes" instruction). Only MATCHED pairs are
// stripped — a lone boundary apostrophe that is part of the text, as in
// "'70s slasher throwback", is preserved.
func stripWrappingQuotes(s string) string {
	pairs := [][2]string{
		{`"`, `"`}, {"'", "'"}, {"“", "”"}, {"‘", "’"},
	}
	for changed := true; changed; {
		changed = false
		s = strings.TrimSpace(s)
		for _, p := range pairs {
			if len(s) >= len(p[0])+len(p[1]) && strings.HasPrefix(s, p[0]) && strings.HasSuffix(s, p[1]) {
				s = strings.TrimSuffix(strings.TrimPrefix(s, p[0]), p[1])
				changed = true
				break
			}
		}
	}
	return strings.TrimSpace(s)
}

// neutralizeBenignPhrases blanks each benign idiom out of the lowercased
// text so its constituent banned word can't fire. Replacement is a space, so
// removal never glues neighboring words together into a false match.
func neutralizeBenignPhrases(s string) string {
	for _, p := range benignPhrases {
		if strings.Contains(s, p) {
			s = strings.ReplaceAll(s, p, " ")
		}
	}
	return s
}

// allLightGenres reports whether the item has at least one genre tag and
// every tag is in lightToneGenres. Empty genre lists return false — no
// metadata means no tone verdict.
func allLightGenres(genres []string) bool {
	if len(genres) == 0 {
		return false
	}
	for _, g := range genres {
		if _, ok := lightToneGenres[strings.ToLower(strings.TrimSpace(g))]; !ok {
			return false
		}
	}
	return true
}

// containsAnyWord reports whether s (already lowercased) contains any of the
// given lowercase words/phrases on word boundaries.
func containsAnyWord(s string, words []string) bool {
	for _, w := range words {
		if containsWord(s, w) {
			return true
		}
	}
	return false
}

// containsWord matches w in s on word boundaries: start/end of string or a
// non-letter/digit RUNE. Runes, not bytes — multibyte punctuation (em dash,
// smart quote) glued to a banned word must still count as a boundary, or
// "drama—dark" would slip through exactly the metadata-echo shape the guard
// exists to catch. "darkly"/"darkness" do not trip "dark".
func containsWord(s, w string) bool {
	for i := 0; ; {
		j := strings.Index(s[i:], w)
		if j < 0 {
			return false
		}
		j += i
		end := j + len(w)
		if boundaryBefore(s, j) && boundaryAfter(s, end) {
			return true
		}
		i = j + 1
	}
}

func boundaryBefore(s string, idx int) bool {
	if idx == 0 {
		return true
	}
	r, _ := utf8.DecodeLastRuneInString(s[:idx])
	return !isWordRune(r)
}

func boundaryAfter(s string, end int) bool {
	if end >= len(s) {
		return true
	}
	r, _ := utf8.DecodeRuneInString(s[end:])
	return !isWordRune(r)
}

// isWordRune treats letters and digits (any script) as word runes; everything
// else — punctuation, symbols, separators — is a boundary. An accented
// letter therefore still extends a word (no manufactured boundary), while an
// em dash does not shield an adjacent banned word.
func isWordRune(r rune) bool {
	return unicode.IsLetter(r) || unicode.IsDigit(r)
}
