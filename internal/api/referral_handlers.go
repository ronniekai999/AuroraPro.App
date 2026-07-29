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

// ReferralHandler serves the user-facing prompt and the admin aggregate.
type ReferralHandler struct {
	queries *db.Queries
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
		if req.Detail != nil {
			return referralAnswer{}, "detail is not allowed when skipping"
		}
		return referralAnswer{Status: "skipped"}, ""
	}

	if source != referralOtherKey && !optionKeys[source] {
		return referralAnswer{}, "unknown source"
	}

	var detail *string
	if req.Detail != nil {
		if source != referralOtherKey {
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

// sanitizeReferralDetail trims the note and strips control characters. This is
// storage hygiene, NOT injection defense — the admin UI renders the value as
// text through React, which escapes it. Newlines and tabs go too: the value is
// displayed in a single table cell.
func sanitizeReferralDetail(s string) string {
	cleaned := strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, s)
	return strings.TrimSpace(cleaned)
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

	// Label the keys against the CURRENT options. A key with no matching
	// option is left with a nil label so the panel can render
	// "<removed: key>" — dropping the row would quietly under-report history
	// every time an operator tidies the list.
	_, options := h.promptConfig(r.Context())
	labels := make(map[string]string, len(options)+1)
	for _, o := range options {
		labels[o.Key] = o.Label
	}
	labels[referralOtherKey] = "Other"
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
	return len([]rune(strings.TrimSpace(v))) <= referralQuestionMaxLen
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
