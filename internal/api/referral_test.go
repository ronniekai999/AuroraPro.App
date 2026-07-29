package api

import (
	"strconv"
	"strings"
	"testing"

	"github.com/aurora-media/aurora/internal/models"
)

// strptr is a local helper — the validator's detail field is *string so tests
// need to distinguish "absent" from "present but empty".
func strptr(s string) *string { return &s }

// defaultKeys is the option key set the handler builds from promptConfig.
func defaultKeys() map[string]bool {
	keys := make(map[string]bool)
	for _, o := range defaultReferralOptions() {
		keys[o.Key] = true
	}
	return keys
}

// TestValidateReferralAnswer pins every accept/reject path of the submission
// contract. This is the security-relevant surface: `source` is validated
// against the CURRENT option keys, `detail` is only legal alongside "other",
// and it is length-capped because it's untrusted text an admin will later read.
func TestValidateReferralAnswer(t *testing.T) {
	cases := []struct {
		name       string
		req        referralAnswerRequest
		wantStatus string // "" means expect a rejection
		wantSource string
		wantDetail *string
		wantErrSub string
	}{
		{
			name:       "known source",
			req:        referralAnswerRequest{Source: "twitch"},
			wantStatus: "answered", wantSource: "twitch",
		},
		{
			name:       "other without a note is legitimate",
			req:        referralAnswerRequest{Source: "other"},
			wantStatus: "answered", wantSource: "other",
		},
		{
			name:       "other with a note",
			req:        referralAnswerRequest{Source: "other", Detail: strptr("a podcast ad")},
			wantStatus: "answered", wantSource: "other", wantDetail: strptr("a podcast ad"),
		},
		{
			name:       "other with a whitespace-only note stores NULL",
			req:        referralAnswerRequest{Source: "other", Detail: strptr("   \t  ")},
			wantStatus: "answered", wantSource: "other", wantDetail: nil,
		},
		{
			name:       "detail is trimmed and control chars stripped",
			req:        referralAnswerRequest{Source: "other", Detail: strptr("  a\x00b\nc  ")},
			wantStatus: "answered", wantSource: "other", wantDetail: strptr("abc"),
		},
		{
			name:       "source is trimmed before matching",
			req:        referralAnswerRequest{Source: "  discord  "},
			wantStatus: "answered", wantSource: "discord",
		},
		{
			name:       "skip",
			req:        referralAnswerRequest{Skip: true},
			wantStatus: "skipped",
		},
		// Rejections.
		{
			name:       "neither skip nor source",
			req:        referralAnswerRequest{},
			wantErrSub: "source is required",
		},
		{
			name:       "both skip and source",
			req:        referralAnswerRequest{Skip: true, Source: "twitch"},
			wantErrSub: "not both",
		},
		{
			name:       "unknown source is rejected",
			req:        referralAnswerRequest{Source: "billboard"},
			wantErrSub: "unknown source",
		},
		{
			// The option key set is the CURRENT config; a client rendered
			// before an option was deleted fails closed rather than writing an
			// unresolvable key into the users table.
			name:       "removed option key is rejected",
			req:        referralAnswerRequest{Source: "myspace"},
			wantErrSub: "unknown source",
		},
		{
			name:       "detail alongside a non-other source",
			req:        referralAnswerRequest{Source: "twitch", Detail: strptr("hello")},
			wantErrSub: "only allowed when source is other",
		},
		{
			// An EMPTY note against a preset option is absent, not illegal.
			// A client that always sends the field — `detail: this.note` with
			// an untouched textbox — would otherwise 400 on every non-"other"
			// answer, leaving the row pending and re-prompting forever. The
			// stored detail is still nil, so the schema CHECK is satisfied.
			name:       "empty detail alongside a non-other source is treated as absent",
			req:        referralAnswerRequest{Source: "twitch", Detail: strptr("  ")},
			wantStatus: "answered", wantSource: "twitch", wantDetail: nil,
		},
		{
			// A NON-empty note against a preset option is still contradictory.
			name:       "non-empty detail alongside a non-other source",
			req:        referralAnswerRequest{Source: "twitch", Detail: strptr("hello")},
			wantErrSub: "only allowed when source is other",
		},
		{
			name:       "empty detail alongside a skip is treated as absent",
			req:        referralAnswerRequest{Skip: true, Detail: strptr("")},
			wantStatus: "skipped",
		},
		{
			name:       "detail alongside a skip",
			req:        referralAnswerRequest{Skip: true, Detail: strptr("hello")},
			wantErrSub: "not allowed when skipping",
		},
		{
			name:       "over-long detail",
			req:        referralAnswerRequest{Source: "other", Detail: strptr(strings.Repeat("x", referralDetailMaxLen+1))},
			wantErrSub: "too long",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, errMsg := validateReferralAnswer(tc.req, defaultKeys())
			if tc.wantErrSub != "" {
				if errMsg == "" {
					t.Fatalf("expected rejection containing %q, got acceptance %+v", tc.wantErrSub, got)
				}
				if !strings.Contains(errMsg, tc.wantErrSub) {
					t.Fatalf("error = %q, want it to contain %q", errMsg, tc.wantErrSub)
				}
				return
			}
			if errMsg != "" {
				t.Fatalf("unexpected rejection: %q", errMsg)
			}
			if got.Status != tc.wantStatus {
				t.Errorf("status = %q, want %q", got.Status, tc.wantStatus)
			}
			if got.Source != tc.wantSource {
				t.Errorf("source = %q, want %q", got.Source, tc.wantSource)
			}
			switch {
			case tc.wantDetail == nil && got.Detail != nil:
				t.Errorf("detail = %q, want nil", *got.Detail)
			case tc.wantDetail != nil && got.Detail == nil:
				t.Errorf("detail = nil, want %q", *tc.wantDetail)
			case tc.wantDetail != nil && *got.Detail != *tc.wantDetail:
				t.Errorf("detail = %q, want %q", *got.Detail, *tc.wantDetail)
			}
		})
	}
}

// TestSanitizeReferralDetailStripsDeceptiveRunes covers the characters that
// change how the SURROUNDING text renders without being visible themselves.
// The detail field's whole purpose is to be read and believed by an admin, so
// a user who controls how it displays can mislead the person acting on it —
// U+202E reverses the rest of the cell, zero-width characters hide inside it.
// unicode.IsControl alone (category Cc) catches none of these.
func TestSanitizeReferralDetailStripsDeceptiveRunes(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"right-to-left override", "safe‮gnihsihp", "safegnihsihp"},
		{"left-to-right override", "a‭b", "ab"},
		{"zero-width space", "spa​ced", "spaced"},
		{"zero-width joiner", "a‍b", "ab"},
		{"line separator", "a b", "ab"},
		{"paragraph separator", "a b", "ab"},
		{"soft hyphen", "a­b", "ab"},
		{"C0 control", "a\x00b", "ab"},
		{"C1 control", "ab", "ab"},
		{"newline and tab", "a\nb\tc", "abc"},
		{"legitimate text is untouched", "Björk's podcast — ep. 12 (2024)", "Björk's podcast — ep. 12 (2024)"},
		{"emoji survive", "saw it on 🎬 twitch", "saw it on 🎬 twitch"},
		{"CJK survives", "朋友推荐的", "朋友推荐的"},
		{"surrounding whitespace trimmed", "  hello  ", "hello"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := sanitizeReferralDetail(tc.in); got != tc.want {
				t.Errorf("sanitizeReferralDetail(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// TestAdminStringsRejectDeceptiveRunes pins the asymmetry and the reason for
// it: admin-authored strings are REJECTED rather than stripped, because an
// operator should see their input round-trip exactly rather than be silently
// rewritten. These strings are also shown to every eligible user, not just to
// one admin, so they get at least as much scrutiny as the detail field.
func TestAdminStringsRejectDeceptiveRunes(t *testing.T) {
	if validReferralQuestionSetting("How did you hear‮ about Aurora?") {
		t.Error("a question containing U+202E was accepted")
	}
	if validReferralQuestionSetting("Zero​width?") {
		t.Error("a question containing a zero-width space was accepted")
	}
	if !validReferralQuestionSetting("How did you hear about Aurora? — be honest!") {
		t.Error("a legitimate question with punctuation and an em dash was rejected")
	}
	if validReferralOptionsSetting(`[{"key":"a","label":"A‮b"}]`) {
		t.Error("an option label containing U+202E was accepted")
	}
	if !validReferralOptionsSetting(`[{"key":"a","label":"A friend — or family"}]`) {
		t.Error("a legitimate label was rejected")
	}
}

// TestValidateReferralAnswerDetailLengthIsRunes guards the cap against
// multi-byte input: a 200-emoji note is 200 characters to the user but ~800
// bytes, and counting bytes would reject a legal answer.
func TestValidateReferralAnswerDetailLengthIsRunes(t *testing.T) {
	atCap := strings.Repeat("🎬", referralDetailMaxLen)
	if _, errMsg := validateReferralAnswer(
		referralAnswerRequest{Source: "other", Detail: &atCap}, defaultKeys()); errMsg != "" {
		t.Fatalf("a %d-rune note was rejected: %q", referralDetailMaxLen, errMsg)
	}
	overCap := strings.Repeat("🎬", referralDetailMaxLen+1)
	if _, errMsg := validateReferralAnswer(
		referralAnswerRequest{Source: "other", Detail: &overCap}, defaultKeys()); errMsg == "" {
		t.Fatalf("a %d-rune note was accepted", referralDetailMaxLen+1)
	}
}

// TestParseReferralOptions covers the repo's first JSON-valued setting.
// server_settings stores TEXT, so Postgres validates nothing — this function is
// the only guard between a malformed blob and a prompt that cannot render.
func TestParseReferralOptions(t *testing.T) {
	cases := []struct {
		name       string
		raw        string
		wantLen    int
		wantErrSub string
	}{
		{
			name:    "well-formed",
			raw:     `[{"key":"friend","label":"A friend"},{"key":"twitch","label":"Twitch"}]`,
			wantLen: 2,
		},
		{
			name:    "keys and labels are trimmed",
			raw:     `[{"key":"  friend  ","label":"  A friend  "}]`,
			wantLen: 1,
		},
		{
			name:    "max count is accepted",
			raw:     optionsJSON(referralOptionsMaxCount),
			wantLen: referralOptionsMaxCount,
		},
		{name: "not an array", raw: `{"key":"friend","label":"x"}`, wantErrSub: "JSON array"},
		{name: "malformed JSON", raw: `[{"key":`, wantErrSub: "JSON array"},
		{name: "empty array", raw: `[]`, wantErrSub: "at least one"},
		{name: "over max count", raw: optionsJSON(referralOptionsMaxCount + 1), wantErrSub: "too many"},
		{name: "duplicate keys", raw: `[{"key":"a","label":"A"},{"key":"a","label":"B"}]`, wantErrSub: "duplicate"},
		{name: "uppercase key", raw: `[{"key":"Friend","label":"A"}]`, wantErrSub: "invalid option key"},
		{name: "key with a space", raw: `[{"key":"a friend","label":"A"}]`, wantErrSub: "invalid option key"},
		{name: "empty key", raw: `[{"key":"","label":"A"}]`, wantErrSub: "invalid option key"},
		{name: "key starting with a dash", raw: `[{"key":"-a","label":"A"}]`, wantErrSub: "invalid option key"},
		{name: "over-long key", raw: `[{"key":"` + strings.Repeat("a", 33) + `","label":"A"}]`, wantErrSub: "invalid option key"},
		{
			// "other" is implicit, always offered, and not deletable — listing
			// it would let an operator remove it and strand referral_detail.
			name: "explicit other is rejected", raw: `[{"key":"other","label":"Other"}]`, wantErrSub: "cannot be listed",
		},
		{name: "missing label", raw: `[{"key":"a","label":""}]`, wantErrSub: "label is required"},
		{name: "whitespace label", raw: `[{"key":"a","label":"   "}]`, wantErrSub: "label is required"},
		{
			name: "over-long label", raw: `[{"key":"a","label":"` + strings.Repeat("x", referralLabelMaxLen+1) + `"}]`,
			wantErrSub: "label is too long",
		},
		{name: "oversized blob", raw: "[" + strings.Repeat(" ", referralOptionsMaxBytes) + "]", wantErrSub: "too large"},
		{name: "unknown field", raw: `[{"key":"a","label":"A","weight":5}]`, wantErrSub: "JSON array"},
		{
			// Decode stops after the first complete value; without a trailing
			// check this would validate on the array and store the junk too.
			name: "trailing content after the array", raw: `[{"key":"a","label":"A"}]{"evil":1}`,
			wantErrSub: "JSON array",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseReferralOptions(tc.raw)
			if tc.wantErrSub != "" {
				if err == nil {
					t.Fatalf("expected error containing %q, parsed %d options", tc.wantErrSub, len(got))
				}
				if !strings.Contains(err.Error(), tc.wantErrSub) {
					t.Fatalf("error = %q, want it to contain %q", err.Error(), tc.wantErrSub)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if len(got) != tc.wantLen {
				t.Fatalf("parsed %d options, want %d", len(got), tc.wantLen)
			}
			for _, o := range got {
				if o.Key != strings.TrimSpace(o.Key) || o.Label != strings.TrimSpace(o.Label) {
					t.Errorf("option %+v was not trimmed", o)
				}
			}
		})
	}
}

// TestReferralSettingValidators pins the two whitelist entries, including the
// empty-means-default contract that lets an operator clear a customization.
func TestReferralSettingValidators(t *testing.T) {
	if !validReferralQuestionSetting("") {
		t.Error("empty question must be allowed — it reverts to the default")
	}
	if !validReferralQuestionSetting("Where'd you hear about us?") {
		t.Error("a normal question was rejected")
	}
	if !validReferralQuestionSetting(strings.Repeat("q", referralQuestionMaxLen)) {
		t.Error("a question at the cap was rejected")
	}
	if validReferralQuestionSetting(strings.Repeat("q", referralQuestionMaxLen+1)) {
		t.Error("an over-long question was accepted")
	}
	if !validReferralOptionsSetting("") {
		t.Error("empty options must be allowed — it reverts to the defaults")
	}
	if !validReferralOptionsSetting(`[{"key":"friend","label":"A friend"}]`) {
		t.Error("a valid options list was rejected")
	}
	if validReferralOptionsSetting(`[{"key":"OTHER","label":"x"}]`) {
		t.Error("an invalid options list was accepted")
	}
}

// TestDefaultReferralOptionsAreValid keeps the built-in fallback honest: the
// defaults must satisfy the same validator the admin's input does, or the
// prompt would ship in a state an operator could never re-create.
func TestDefaultReferralOptionsAreValid(t *testing.T) {
	opts := defaultReferralOptions()
	if len(opts) == 0 {
		t.Fatal("defaults are empty")
	}
	encoded := encodeOptions(t, opts)
	parsed, err := parseReferralOptions(encoded)
	if err != nil {
		t.Fatalf("default options fail their own validator: %v", err)
	}
	if len(parsed) != len(opts) {
		t.Fatalf("round-trip changed the option count: %d → %d", len(opts), len(parsed))
	}
}

// TestReferralEligible pins the rule the OAuth callback applies at user
// creation. Attribution is only missing when the invite gate was bypassed AND
// no invite was redeemed; a user who presented a valid invite already has
// attribution, so asking them would be noise.
//
// This calls the production referralEligible. An earlier version of this test
// recomputed `bypassInvite && inviteClaimID <= 0` in the test body and asserted
// against its own copy — which meant deleting the second condition from the
// caller left the suite green, and the test that claimed to pin the rule could
// not fail. Restating the logic under test IS the bug.
func TestReferralEligible(t *testing.T) {
	cases := []struct {
		name          string
		bypassInvite  bool
		inviteClaimID int64
		want          bool
	}{
		{"bypass on, no claim → ask", true, 0, true},
		// PLAN.md trigger condition 4, the one that looks redundant with 3 and
		// isn't: a user may present a valid invite AND use a bypassed provider.
		{"bypass on, claim redeemed → already attributed", true, 42, false},
		{"bypass off, claim redeemed → already attributed", false, 42, false},
		// Unreachable at the call site (tier 3 rejects this combination before
		// creating anyone), but the predicate stays total.
		{"bypass off, no claim → not eligible", false, 0, false},
		// A negative id is not a claim; treat it as absent rather than as a
		// truthy "some claim exists".
		{"bypass on, negative claim id → ask", true, -1, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := referralEligible(tc.bypassInvite, tc.inviteClaimID); got != tc.want {
				t.Errorf("referralEligible(%v, %d) = %v, want %v",
					tc.bypassInvite, tc.inviteClaimID, got, tc.want)
			}
		})
	}
}

// optionsJSON builds a valid n-option JSON list for the count-boundary cases.
func optionsJSON(n int) string {
	var b strings.Builder
	b.WriteByte('[')
	for i := 0; i < n; i++ {
		if i > 0 {
			b.WriteByte(',')
		}
		// Keys must be unique and match the slug pattern.
		b.WriteString(`{"key":"opt`)
		b.WriteString(strings.Repeat("x", i%3))
		b.WriteString(strconv.Itoa(i))
		b.WriteString(`","label":"Option `)
		b.WriteString(strconv.Itoa(i))
		b.WriteString(`"}`)
	}
	b.WriteByte(']')
	return b.String()
}

func encodeOptions(t *testing.T, opts []models.ReferralOption) string {
	t.Helper()
	var b strings.Builder
	b.WriteByte('[')
	for i, o := range opts {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(`{"key":"`)
		b.WriteString(o.Key)
		b.WriteString(`","label":"`)
		b.WriteString(o.Label)
		b.WriteString(`"}`)
	}
	b.WriteByte(']')
	return b.String()
}
