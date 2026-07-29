package api

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"unicode"

	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/models"
)

// Referral prompt (migration 046) — "How did you hear about Aurora?" for
// signups that bypassed the invite gate.
//
// Aurora already models "this provider is trusted enough to skip the invite" as
// a per-provider admin toggle. When that toggle is on, the invite code — the
// only record of where a new account came from — is exactly what gets skipped.
// So the providers an operator most wants to grow through are the ones that
// produce zero attribution. This asks those users directly, once.
//
// Eligibility is decided by the server at signup and stored in
// users.referral_status; the client is never trusted to decide whether the
// prompt should appear. See resolveOAuthUser's tier-3 branch in
// oauth_handlers.go for where the 'pending' stamp originates.

const (
	// referralDetailMaxLen caps the free-text "other" answer. Untrusted input
	// that an admin will later read — bounded here so a single user cannot
	// wedge an unbounded blob into the users table or the admin table cell.
	referralDetailMaxLen = 200
	// referralQuestionMaxLen caps the admin-authored question text.
	referralQuestionMaxLen = 200
	// referralOptionsMaxBytes caps the raw options JSON. Well under
	// decodeJSON's 1 MiB body limit; a 12-option list is a few hundred bytes.
	referralOptionsMaxBytes = 4096
	referralOptionsMaxCount = 12
	referralLabelMaxLen     = 64
	// referralOtherKey is the implicit free-text option. Always offered,
	// always last, never in the configured list, and not deletable — removing
	// it would strand users.referral_detail.
	referralOtherKey = "other"

	settingReferralQuestion = "referral_prompt_question"
	settingReferralOptions  = "referral_prompt_options"

	defaultReferralQuestion = "How did you hear about Aurora?"
)

// defaultReferralOptions is the fallback list when the operator hasn't
// configured one. Defined in code rather than seeded by migration so that
// "operator cleared the list" stays distinguishable from "never configured" —
// the settings table has no third state to express that.
func defaultReferralOptions() []models.ReferralOption {
	return []models.ReferralOption{
		{Key: "friend", Label: "A friend or family member"},
		{Key: "twitch", Label: "Twitch"},
		{Key: "discord", Label: "Discord"},
		{Key: "reddit", Label: "Reddit"},
		{Key: "search", Label: "Search engine"},
	}
}

// referralOptionKeyRe bounds option keys to a lowercase slug. Keys are written
// into users.referral_source and never rendered as markup, but keeping them
// boring means they stay safe in URLs, CSS hooks, and log lines.
var referralOptionKeyRe = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,31}$`)

// referralEligible reports whether a brand-new OAuth user should be asked where
// they heard about Aurora. Called from resolveOAuthUser's tier-3 branch, which
// supplies the two facts only it knows.
//
// Both conditions are load-bearing, and the second is the one that looks
// redundant and isn't:
//
//   - bypassInvite: the provider's invite-bypass toggle is on, so this signup
//     skipped the invite code — and the invite code was the only record Aurora
//     kept of where an account came from. Without bypass there is nothing to
//     replace.
//   - inviteClaimID <= 0: no invite was actually redeemed. A user can present a
//     valid invite AND arrive through a bypassed provider; that user already
//     has attribution, so asking would be noise.
//
// A named function rather than an inline expression specifically so a test can
// call THIS instead of restating the rule — an eligibility test that recomputes
// its own copy of the predicate passes no matter what the caller does.
func referralEligible(bypassInvite bool, inviteClaimID int64) bool {
	return bypassInvite && inviteClaimID <= 0
}

// referralStore is the slice of the query layer this handler needs. *db.Queries
// satisfies it; the indirection exists so the handlers can be exercised over
// httptest without a live Postgres, which is what the package's other tests
// (which are all pure functions) have never been able to do. Mirrors the
// HeroProvider indirection in router.go.
type referralStore interface {
	GetReferralStatus(ctx context.Context, userID int64) (string, error)
	ResolveReferral(ctx context.Context, userID int64, status, source string, detail *string) (bool, error)
	ReferralSummary(ctx context.Context, windowDays int) (*models.ReferralSummary, error)
	GetSetting(ctx context.Context, key string) (string, error)
}

// ReferralHandler serves the user-facing prompt and the admin aggregate.
type ReferralHandler struct {
	queries referralStore
}

func NewReferralHandler(queries *db.Queries) *ReferralHandler {
	return &ReferralHandler{queries: queries}
}

// promptConfig returns the configured question and options, falling back to the
// defaults when unset or unparseable. Both endpoints read through this so the
// list used to VALIDATE an answer is always the same list that was DISPLAYED.
func (h *ReferralHandler) promptConfig(ctx context.Context) (string, []models.ReferralOption) {
	question := defaultReferralQuestion
	if v, err := h.queries.GetSetting(ctx, settingReferralQuestion); err != nil {
		slog.Warn("referral: read question setting failed, using default", "error", err)
	} else if t := strings.TrimSpace(v); t != "" {
		question = t
	}

	options := defaultReferralOptions()
	if v, err := h.queries.GetSetting(ctx, settingReferralOptions); err != nil {
		slog.Warn("referral: read options setting failed, using defaults", "error", err)
	} else if strings.TrimSpace(v) != "" {
		parsed, perr := parseReferralOptions(v)
		if perr != nil {
			// A stored value that no longer parses (hand-edited row, or a
			// validator that tightened after the write) must not take the
			// prompt down — fall back and say so loudly.
			slog.Warn("referral: stored options unparseable, using defaults", "error", perr)
		} else {
			options = parsed
		}
	}
	return question, options
}

// Prompt handles GET /api/me/referral-prompt.
//
// Returns pending:false — and nothing else — unless the user is genuinely
// eligible and unresolved. The client cannot be tricked into showing the prompt
// by a crafted response because the server is the only authority on
// eligibility, and an ineligible caller learns nothing about the configured
// question or options.
func (h *ReferralHandler) Prompt(w http.ResponseWriter, r *http.Request) {
	claims, ok := requireClaims(w, r)
	if !ok {
		return
	}
	status, err := h.queries.GetReferralStatus(r.Context(), claims.UserID)
	if err != nil {
		// Never block the app on a nicety: a read failure reports "nothing to
		// ask" rather than an error the onboarding gate would have to handle.
		slog.Warn("referral: status read failed", "user_id", claims.UserID, "error", err)
		writeJSON(w, http.StatusOK, map[string]any{"pending": false})
		return
	}
	if status != "pending" {
		writeJSON(w, http.StatusOK, map[string]any{"pending": false})
		return
	}
	question, options := h.promptConfig(r.Context())
	writeJSON(w, http.StatusOK, map[string]any{
		"pending":  true,
		"question": question,
		"options":  options,
	})
}

type referralAnswerRequest struct {
	Source string  `json:"source"`
	Detail *string `json:"detail"`
	Skip   bool    `json:"skip"`
}

// referralAnswer is the validated result of a submission.
type referralAnswer struct {
	Status string // "answered" | "skipped"
	Source string // "" for a skip
	Detail *string
}

// validateReferralAnswer is the pure core of POST /api/me/referral, split out
// so every rejection path is table-testable without a database.
//
// optionKeys is the CURRENT configured key set; "other" is always accepted on
// top of it. A user whose page was rendered before an option was deleted will
// fail here — accepted deliberately: the client logs and continues into the
// app, because attribution is worth less than a signup.
func validateReferralAnswer(req referralAnswerRequest, optionKeys map[string]bool) (referralAnswer, string) {
	source := strings.TrimSpace(req.Source)

	// Exactly one of skip / source. Both is contradictory; neither is empty.
	if req.Skip && source != "" {
		return referralAnswer{}, "send either skip or source, not both"
	}
	if !req.Skip && source == "" {
		return referralAnswer{}, "source is required"
	}

	if req.Skip {
		// An EMPTY detail is treated as absent, not as a violation. The obvious
		// client shape is `{skip: true, detail: this.note}` with an untouched
		// textbox, which sends "" — rejecting that would 400 every skip, leave
		// the row pending forever, and re-prompt the user on each visit. Only a
		// non-empty note alongside a skip is contradictory enough to refuse.
		if req.Detail != nil && sanitizeReferralDetail(*req.Detail) != "" {
			return referralAnswer{}, "detail is not allowed when skipping"
		}
		return referralAnswer{Status: "skipped"}, ""
	}

	if source != referralOtherKey && !optionKeys[source] {
		return referralAnswer{}, "unknown source"
	}

	var detail *string
	if req.Detail != nil {
		// Same reasoning as the skip branch: an empty note from a client that
		// always sends the field is not an error, it's an absent note. A
		// non-empty note against a preset option still is.
		if source != referralOtherKey {
			if sanitizeReferralDetail(*req.Detail) == "" {
				return referralAnswer{Status: "answered", Source: source}, ""
			}
			return referralAnswer{}, "detail is only allowed when source is other"
		}
		clean := sanitizeReferralDetail(*req.Detail)
		if len([]rune(clean)) > referralDetailMaxLen {
			return referralAnswer{}, "detail is too long"
		}
		// An "other" answer with an empty note is legitimate — the note is
		// optional. Store NULL rather than an empty string so the two cases
		// don't have to be distinguished downstream.
		if clean != "" {
			detail = &clean
		}
	}
	return referralAnswer{Status: "answered", Source: source, Detail: detail}, ""
}

// sanitizeReferralDetail trims the note and strips characters that render
// deceptively rather than visibly.
//
// This is NOT injection defense — the admin UI renders the value as a text node
// through React, which escapes it. It's about a subtler problem: this string
// exists to be read and believed by an admin, so a user who can control how it
// DISPLAYS can mislead the person acting on it. unicode.IsControl alone covers
// only category Cc, which leaves U+202E RIGHT-TO-LEFT OVERRIDE (Cf) free to
// reverse the rest of the cell, and zero-width characters free to hide content
// inside it. Cf/Zl/Zp go too. Newlines and tabs go with Cc: the value is
// displayed in a single table cell.
func sanitizeReferralDetail(s string) string {
	return strings.TrimSpace(strings.Map(dropDeceptiveRune, s))
}

// dropDeceptiveRune reports -1 (drop) for control, format, and line/paragraph
// separator characters — the ones that change how surrounding text renders
// without being visible themselves.
func dropDeceptiveRune(r rune) rune {
	if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) || unicode.Is(unicode.Zl, r) || unicode.Is(unicode.Zp, r) {
		return -1
	}
	return r
}

// hasDeceptiveRunes reports whether s contains any of the characters
// dropDeceptiveRune removes. Admin-authored strings are REJECTED rather than
// silently stripped: an operator should see their input round-trip exactly, and
// a validator that quietly rewrote what they typed would be worse than one that
// says no. The user-supplied detail is stripped instead, because there is
// nobody to show an error to by the time it reaches storage.
func hasDeceptiveRunes(s string) bool {
	return strings.ContainsFunc(s, func(r rune) bool { return dropDeceptiveRune(r) == -1 })
}

// Submit handles POST /api/me/referral.
//
// Idempotent by construction: ResolveReferral's UPDATE is predicated on the row
// still being 'pending', so a double-submit from a slow network resolves to a
// 200 no-op instead of a 500 on a brand-new account.
func (h *ReferralHandler) Submit(w http.ResponseWriter, r *http.Request) {
	claims, ok := requireClaims(w, r)
	if !ok {
		return
	}
	var req referralAnswerRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	// Check eligibility BEFORE validating against the option list. Validating
	// first would turn this endpoint into an enumeration oracle: any
	// authenticated user — including a password signup who can never be pending
	// — could probe one key at a time and tell configured keys (200) from
	// unconfigured ones (400), which contradicts the disclosure guarantee the
	// GET handler makes. It also means the common ineligible case costs one
	// cheap read instead of two setting reads and a JSON parse.
	//
	// This is an early-out, not the authority: ResolveReferral's
	// `AND referral_status = 'pending'` is still what makes the write safe
	// against a status that changes between here and there.
	// A read failure short-circuits, and the answer is NOT lost by doing so.
	//
	// An earlier version fell through here on the theory that returning would
	// discard input the user had given. That was wrong: the row stays
	// 'pending', and TasteOnboardingGate re-reads /api/me/referral-prompt on
	// every mount, so the user is asked again next session — the designed
	// fallback OnboardingFlow already documents. The answer is deferred, not
	// dropped.
	//
	// What falling through DID cost was real. Validation runs against the
	// option list, so a configured key answered 200 and an unconfigured one
	// 400: the enumeration oracle this early-out exists to close, reopened for
	// any authenticated user whenever a single statement fails (a pool
	// connection stale across a Postgres restart is enough). Worse, when the
	// settings read fails too, promptConfig falls back to the BUILT-IN
	// defaults, so a real operator-configured answer is rejected as "unknown
	// source" — losing the very input the fall-through was meant to save.
	if status, err := h.queries.GetReferralStatus(r.Context(), claims.UserID); err != nil {
		slog.Warn("referral: status read failed on submit", "user_id", claims.UserID, "error", err)
		writeJSON(w, http.StatusOK, map[string]any{"pending": false, "recorded": false})
		return
	} else if status != "pending" {
		writeJSON(w, http.StatusOK, map[string]any{"pending": false, "recorded": false})
		return
	}

	_, options := h.promptConfig(r.Context())
	keys := make(map[string]bool, len(options))
	for _, o := range options {
		keys[o.Key] = true
	}

	answer, verr := validateReferralAnswer(req, keys)
	if verr != "" {
		writeError(w, http.StatusBadRequest, verr)
		return
	}

	resolved, err := h.queries.ResolveReferral(r.Context(), claims.UserID, answer.Status, answer.Source, answer.Detail)
	if err != nil {
		slog.Error("referral: resolve failed", "user_id", claims.UserID, "error", err)
		writeError(w, http.StatusInternalServerError, "failed to save answer")
		return
	}
	if !resolved {
		// Not pending: already resolved, or never eligible. Both are no-ops,
		// not errors — see the doc comment above.
		writeJSON(w, http.StatusOK, map[string]any{"pending": false, "recorded": false})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"pending": false, "recorded": true})
}

// Summary handles GET /api/admin/referrals/summary?days=N (admin-only via the
// router group).
//
// Always 200 with a shaped payload — an instance where nobody was ever eligible
// gets zeros and an empty breakdown, not an error, mirroring EmbeddingStatus.
func (h *ReferralHandler) Summary(w http.ResponseWriter, r *http.Request) {
	days := 0
	if v := strings.TrimSpace(r.URL.Query().Get("days")); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 0 || n > 3650 {
			writeError(w, http.StatusBadRequest, "days must be an integer between 0 and 3650")
			return
		}
		days = n
	}

	summary, err := h.queries.ReferralSummary(r.Context(), days)
	if err != nil {
		slog.Error("referral: summary failed", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to build referral summary")
		return
	}

	// Label the keys against the CURRENT options. A nil label means "this key
	// has no configured option", which covers two cases the CLIENT tells apart
	// by the key itself:
	//
	//   - a key whose option was deleted after users chose it — rendered as
	//     "<removed: key>", because dropping the row would quietly under-report
	//     history every time an operator tidies the list; and
	//   - the implicit "other", which has no stored option by design.
	//
	// "other" is deliberately NOT labelled here. Its display text is product
	// copy for an option this server does not store, and writing a second
	// spelling of it in Go is what let the admin panel say "Other" while the
	// user had been shown "Something else". The frontend owns that string.
	_, options := h.promptConfig(r.Context())
	labels := make(map[string]string, len(options))
	for _, o := range options {
		labels[o.Key] = o.Label
	}
	for i := range summary.BySource {
		if label, found := labels[summary.BySource[i].Key]; found {
			l := label
			summary.BySource[i].Label = &l
		}
	}
	writeJSON(w, http.StatusOK, summary)
}

// ============================================================
// Settings validation (used by the admin settings whitelist)
// ============================================================

// parseReferralOptions parses and validates the referral_prompt_options
// setting: a JSON array of {key,label}.
//
// This is the repo's first JSON-valued server_settings value, and server_settings
// stores TEXT — Postgres validates nothing for us, so this function is the only
// thing standing between a malformed blob and a prompt that can't render. The
// admin editor mirrors these rules client-side to produce per-row error text,
// because the settings whitelist's validator signature can only answer yes/no.
func parseReferralOptions(raw string) ([]models.ReferralOption, error) {
	if len(raw) > referralOptionsMaxBytes {
		return nil, errReferralOptions("options JSON is too large")
	}
	var opts []models.ReferralOption
	dec := json.NewDecoder(strings.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&opts); err != nil {
		return nil, errReferralOptions("options must be a JSON array of {key,label}")
	}
	// Decode stops at the end of the first JSON value, so `[...]{"x":1}` would
	// otherwise validate on the array alone and silently store the trailing
	// junk. A settings blob must be exactly one value.
	if dec.More() {
		return nil, errReferralOptions("options must be a JSON array of {key,label}")
	}
	if len(opts) == 0 {
		return nil, errReferralOptions("at least one option is required")
	}
	if len(opts) > referralOptionsMaxCount {
		return nil, errReferralOptions("too many options")
	}
	seen := make(map[string]bool, len(opts))
	for i := range opts {
		key := strings.TrimSpace(opts[i].Key)
		label := strings.TrimSpace(opts[i].Label)
		if !referralOptionKeyRe.MatchString(key) {
			return nil, errReferralOptions("invalid option key: " + key)
		}
		if key == referralOtherKey {
			// "other" is implicit and always offered; listing it would let an
			// operator delete it, stranding referral_detail.
			return nil, errReferralOptions(`"other" is always offered and cannot be listed`)
		}
		if seen[key] {
			return nil, errReferralOptions("duplicate option key: " + key)
		}
		seen[key] = true
		if label == "" {
			return nil, errReferralOptions("option label is required: " + key)
		}
		if len([]rune(label)) > referralLabelMaxLen {
			return nil, errReferralOptions("option label is too long: " + key)
		}
		// Labels are shown to EVERY eligible user, so they get at least the
		// scrutiny the single-admin-facing detail field gets.
		if hasDeceptiveRunes(label) {
			return nil, errReferralOptions("option label contains disallowed characters: " + key)
		}
		opts[i].Key = key
		opts[i].Label = label
	}
	return opts, nil
}

type referralOptionsError string

func (e referralOptionsError) Error() string { return string(e) }

func errReferralOptions(msg string) error { return referralOptionsError(msg) }

// validReferralQuestionSetting reports whether the question setting is
// acceptable. Empty is allowed and means "revert to the built-in default",
// matching GetSetting's missing-is-empty semantics.
func validReferralQuestionSetting(v string) bool {
	// The RAW value is what UpsertSetting persists, so bound that too. Checking
	// only the trimmed length let a megabyte of spaces validate as zero runes
	// and land in server_settings intact.
	if len(v) > referralQuestionMaxLen*4 {
		return false
	}
	t := strings.TrimSpace(v)
	return len([]rune(t)) <= referralQuestionMaxLen && !hasDeceptiveRunes(t)
}

// validReferralOptionsSetting reports whether the options setting is
// acceptable. Empty means "use the defaults".
func validReferralOptionsSetting(v string) bool {
	if strings.TrimSpace(v) == "" {
		return true
	}
	_, err := parseReferralOptions(v)
	return err == nil
}
