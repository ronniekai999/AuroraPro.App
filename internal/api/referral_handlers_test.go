package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/aurora-media/aurora/internal/auth"
	"github.com/aurora-media/aurora/internal/models"
)

// Handler-level tests for the referral endpoints, over httptest with a fake
// store. The package's other tests are all pure functions, which left the two
// claims this feature actually rests on unverified by `go test ./...`: that the
// prompt is disclosed ONLY to a pending user, and that a repeat submit is a
// no-op rather than an overwrite. Both were provable only against a live
// database, i.e. not by the gate anyone actually runs.

// fakeReferralStore implements referralStore in memory and records calls.
type fakeReferralStore struct {
	status       string
	statusErr    error
	resolveErr   error
	summary      *models.ReferralSummary
	summaryErr   error
	settings     map[string]string
	settingErr   error
	resolveCalls []resolveCall
	statusCalls  int
}

type resolveCall struct {
	userID         int64
	status, source string
	detail         *string
}

func (f *fakeReferralStore) GetReferralStatus(_ context.Context, _ int64) (string, error) {
	f.statusCalls++
	return f.status, f.statusErr
}

func (f *fakeReferralStore) ResolveReferral(_ context.Context, userID int64, status, source string, detail *string) (bool, error) {
	f.resolveCalls = append(f.resolveCalls, resolveCall{userID, status, source, detail})
	if f.resolveErr != nil {
		return false, f.resolveErr
	}
	// Mirror the real UPDATE ... WHERE referral_status = 'pending': it lands
	// only while pending, and resolving flips the row so a repeat cannot.
	if f.status != "pending" {
		return false, nil
	}
	f.status = status
	return true, nil
}

func (f *fakeReferralStore) ReferralSummary(_ context.Context, windowDays int) (*models.ReferralSummary, error) {
	if f.summaryErr != nil {
		return nil, f.summaryErr
	}
	s := *f.summary
	s.WindowDays = windowDays
	return &s, nil
}

func (f *fakeReferralStore) GetSetting(_ context.Context, key string) (string, error) {
	if f.settingErr != nil {
		return "", f.settingErr
	}
	return f.settings[key], nil
}

func newTestReferralHandler(store *fakeReferralStore) *ReferralHandler {
	if store.settings == nil {
		store.settings = map[string]string{}
	}
	return &ReferralHandler{queries: store}
}

// authed builds a request carrying JWT claims the way RequireAuth would.
func authed(method, target string, body string) *http.Request {
	var r *http.Request
	if body == "" {
		r = httptest.NewRequest(method, target, nil)
	} else {
		r = httptest.NewRequest(method, target, strings.NewReader(body))
	}
	claims := &auth.JWTClaims{UserID: 7, Username: "tester", Role: "user"}
	return r.WithContext(context.WithValue(r.Context(), auth.ClaimsContextKey, claims))
}

func decodeBody(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("response is not JSON: %v (body=%q)", err, rec.Body.String())
	}
	return out
}

// ---- GET /api/me/referral-prompt ----

func TestPromptDisclosesOnlyToPendingUsers(t *testing.T) {
	// The security property: an ineligible caller must not learn the question
	// or the option list. Anything else would let a client decide for itself
	// that the prompt should show.
	for _, status := range []string{"", "answered", "skipped"} {
		t.Run("status="+status, func(t *testing.T) {
			h := newTestReferralHandler(&fakeReferralStore{status: status})
			rec := httptest.NewRecorder()
			h.Prompt(rec, authed(http.MethodGet, "/api/me/referral-prompt", ""))

			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200", rec.Code)
			}
			body := decodeBody(t, rec)
			if body["pending"] != false {
				t.Errorf("pending = %v, want false", body["pending"])
			}
			if _, leaked := body["question"]; leaked {
				t.Error("question disclosed to an ineligible user")
			}
			if _, leaked := body["options"]; leaked {
				t.Error("options disclosed to an ineligible user")
			}
		})
	}
}

func TestPromptReturnsQuestionAndOptionsWhenPending(t *testing.T) {
	h := newTestReferralHandler(&fakeReferralStore{status: "pending"})
	rec := httptest.NewRecorder()
	h.Prompt(rec, authed(http.MethodGet, "/api/me/referral-prompt", ""))

	body := decodeBody(t, rec)
	if body["pending"] != true {
		t.Fatalf("pending = %v, want true", body["pending"])
	}
	if body["question"] != defaultReferralQuestion {
		t.Errorf("question = %v, want the default", body["question"])
	}
	opts, ok := body["options"].([]any)
	if !ok || len(opts) != len(defaultReferralOptions()) {
		t.Fatalf("options = %v, want %d defaults", body["options"], len(defaultReferralOptions()))
	}
	// "other" is implicit and must NOT be in the served list — the client
	// appends it, and shipping it here would let it be reordered or dropped.
	for _, o := range opts {
		if m, _ := o.(map[string]any); m["key"] == referralOtherKey {
			t.Error(`served options contain "other"; it is implicit and always last`)
		}
	}
}

func TestPromptUsesAdminConfiguredQuestionAndOptions(t *testing.T) {
	h := newTestReferralHandler(&fakeReferralStore{
		status: "pending",
		settings: map[string]string{
			settingReferralQuestion: "Where'd you find us?",
			settingReferralOptions:  `[{"key":"podcast","label":"A podcast"}]`,
		},
	})
	rec := httptest.NewRecorder()
	h.Prompt(rec, authed(http.MethodGet, "/api/me/referral-prompt", ""))

	body := decodeBody(t, rec)
	if body["question"] != "Where'd you find us?" {
		t.Errorf("question = %v, want the configured one", body["question"])
	}
	opts := body["options"].([]any)
	if len(opts) != 1 || opts[0].(map[string]any)["key"] != "podcast" {
		t.Errorf("options = %v, want the configured single option", opts)
	}
}

func TestPromptFallsBackWhenStoredOptionsAreCorrupt(t *testing.T) {
	// A hand-edited row must not take the prompt down.
	h := newTestReferralHandler(&fakeReferralStore{
		status:   "pending",
		settings: map[string]string{settingReferralOptions: `{"not":"an array"}`},
	})
	rec := httptest.NewRecorder()
	h.Prompt(rec, authed(http.MethodGet, "/api/me/referral-prompt", ""))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got := len(decodeBody(t, rec)["options"].([]any)); got != len(defaultReferralOptions()) {
		t.Errorf("served %d options, want the %d defaults", got, len(defaultReferralOptions()))
	}
}

func TestPromptHidesOnStoreError(t *testing.T) {
	// Onboarding is a nicety, not a gate: a read failure reports "nothing to
	// ask" rather than an error the client has to handle.
	h := newTestReferralHandler(&fakeReferralStore{statusErr: errors.New("db down")})
	rec := httptest.NewRecorder()
	h.Prompt(rec, authed(http.MethodGet, "/api/me/referral-prompt", ""))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if decodeBody(t, rec)["pending"] != false {
		t.Error("pending should be false when the status read fails")
	}
}

func TestPromptRequiresAuthentication(t *testing.T) {
	h := newTestReferralHandler(&fakeReferralStore{status: "pending"})
	rec := httptest.NewRecorder()
	// No claims in context — what an unauthenticated request looks like if it
	// ever reached the handler.
	h.Prompt(rec, httptest.NewRequest(http.MethodGet, "/api/me/referral-prompt", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

// ---- POST /api/me/referral ----

func TestSubmitRecordsAnswer(t *testing.T) {
	store := &fakeReferralStore{status: "pending"}
	h := newTestReferralHandler(store)
	rec := httptest.NewRecorder()
	h.Submit(rec, authed(http.MethodPost, "/api/me/referral", `{"source":"twitch"}`))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body=%s)", rec.Code, rec.Body.String())
	}
	if decodeBody(t, rec)["recorded"] != true {
		t.Error("recorded should be true for a first answer")
	}
	if len(store.resolveCalls) != 1 {
		t.Fatalf("%d resolve calls, want 1", len(store.resolveCalls))
	}
	got := store.resolveCalls[0]
	if got.userID != 7 || got.status != "answered" || got.source != "twitch" || got.detail != nil {
		t.Errorf("resolve call = %+v, want user 7 / answered / twitch / nil detail", got)
	}
}

func TestSubmitIsIdempotent(t *testing.T) {
	// The headline contract: a double-submit from a slow network must be a
	// 200 no-op, and must not overwrite the answer that already landed.
	store := &fakeReferralStore{status: "pending"}
	h := newTestReferralHandler(store)

	first := httptest.NewRecorder()
	h.Submit(first, authed(http.MethodPost, "/api/me/referral", `{"source":"twitch"}`))
	if decodeBody(t, first)["recorded"] != true {
		t.Fatal("first submit did not record")
	}

	second := httptest.NewRecorder()
	h.Submit(second, authed(http.MethodPost, "/api/me/referral", `{"skip":true}`))
	if second.Code != http.StatusOK {
		t.Fatalf("second submit status = %d, want 200 (not an error)", second.Code)
	}
	if decodeBody(t, second)["recorded"] != false {
		t.Error("second submit reported a write; it must be a no-op")
	}
	if store.status != "answered" {
		t.Errorf("status = %q after the repeat, want the original \"answered\"", store.status)
	}
}

func TestSubmitLosesTheRaceGracefully(t *testing.T) {
	// The handler's pre-write status check is an optimization, NOT the safety
	// mechanism. This is the window it cannot close: the row is pending when
	// the handler looks, and already resolved by the time the UPDATE runs —
	// a genuine double-submit landing on two connections at once.
	//
	// The store's `AND referral_status = 'pending'` is what actually decides,
	// and reporting zero rows must surface as a 200 no-op rather than a 500 on
	// a brand-new account. Without this test the whole race path is unpinned:
	// removing the store guard leaves every other test green, because they all
	// stop at the handler's check.
	store := &raceyReferralStore{fakeReferralStore: fakeReferralStore{status: "pending"}}
	h := &ReferralHandler{queries: store}
	rec := httptest.NewRecorder()
	h.Submit(rec, authed(http.MethodPost, "/api/me/referral", `{"source":"twitch"}`))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 — a lost race is not an error (body=%s)", rec.Code, rec.Body.String())
	}
	if decodeBody(t, rec)["recorded"] != false {
		t.Error("recorded should be false when the write matched no rows")
	}
}

// raceyReferralStore reports pending on read, then refuses the write — the
// interleaving a real concurrent submit produces.
type raceyReferralStore struct{ fakeReferralStore }

func (r *raceyReferralStore) ResolveReferral(_ context.Context, _ int64, _, _ string, _ *string) (bool, error) {
	return false, nil
}

func TestSubmitOnIneligibleUserIsANoOpAndLeaksNothing(t *testing.T) {
	// Eligibility is checked BEFORE the option list. Validating first turned
	// this into an enumeration oracle: a configured key answered 200 and an
	// unconfigured one 400, telling any authenticated user the option set the
	// GET handler deliberately withholds.
	for _, source := range []string{"twitch", "definitely-not-configured"} {
		t.Run(source, func(t *testing.T) {
			store := &fakeReferralStore{status: ""} // never eligible
			h := newTestReferralHandler(store)
			rec := httptest.NewRecorder()
			h.Submit(rec, authed(http.MethodPost, "/api/me/referral", `{"source":"`+source+`"}`))

			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d for source %q, want 200 — differing codes are the oracle",
					rec.Code, source)
			}
			if decodeBody(t, rec)["recorded"] != false {
				t.Error("recorded should be false for an ineligible user")
			}
			if len(store.resolveCalls) != 0 {
				t.Error("ineligible submit reached the write path")
			}
		})
	}
}

func TestSubmitSkipWithEmptyDetailSucceeds(t *testing.T) {
	// `JSON.stringify({skip: true, detail: note})` with an untouched textbox
	// sends "". Rejecting that would 400 every skip and re-prompt forever.
	store := &fakeReferralStore{status: "pending"}
	h := newTestReferralHandler(store)
	rec := httptest.NewRecorder()
	h.Submit(rec, authed(http.MethodPost, "/api/me/referral", `{"skip":true,"detail":""}`))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body=%s)", rec.Code, rec.Body.String())
	}
	if len(store.resolveCalls) != 1 || store.resolveCalls[0].status != "skipped" {
		t.Fatalf("resolve calls = %+v, want one skip", store.resolveCalls)
	}
}

func TestSubmitOtherCarriesTheNote(t *testing.T) {
	store := &fakeReferralStore{status: "pending"}
	h := newTestReferralHandler(store)
	rec := httptest.NewRecorder()
	h.Submit(rec, authed(http.MethodPost, "/api/me/referral", `{"source":"other","detail":"  a podcast\n"}`))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	got := store.resolveCalls[0]
	if got.detail == nil || *got.detail != "a podcast" {
		t.Errorf("detail = %v, want the trimmed/sanitized note", got.detail)
	}
}

func TestSubmitRejectsBadRequests(t *testing.T) {
	cases := []struct{ name, body string }{
		{"empty object", `{}`},
		{"skip false alone", `{"skip":false}`},
		{"both skip and source", `{"skip":true,"source":"twitch"}`},
		{"unknown source", `{"source":"billboard"}`},
		{"note against a preset option", `{"source":"twitch","detail":"hello"}`},
		{"note alongside a skip", `{"skip":true,"detail":"hello"}`},
		{"over-long note", `{"source":"other","detail":"` + strings.Repeat("x", referralDetailMaxLen+1) + `"}`},
		{"malformed JSON", `{"source":`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			store := &fakeReferralStore{status: "pending"}
			h := newTestReferralHandler(store)
			rec := httptest.NewRecorder()
			h.Submit(rec, authed(http.MethodPost, "/api/me/referral", tc.body))
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400 (body=%s)", rec.Code, rec.Body.String())
			}
			if len(store.resolveCalls) != 0 {
				t.Error("a rejected request still reached the write path")
			}
		})
	}
}

// TestSubmitKeepsTheAnswerWhenTheStatusReadFails pins the fall-through. The
// eligibility read is an optimization and an anti-enumeration guard, NOT the
// authority — ResolveReferral's pending predicate is. Short-circuiting on a
// transient read error threw away an answer the user actually gave, and the
// client never retries: it treats this call as fire-and-forget precisely so a
// failed write can't trap anyone.
func TestSubmitKeepsTheAnswerWhenTheStatusReadFails(t *testing.T) {
	store := &fakeReferralStore{status: "pending", statusErr: errors.New("transient blip")}
	h := newTestReferralHandler(store)
	rec := httptest.NewRecorder()
	h.Submit(rec, authed(http.MethodPost, "/api/me/referral", `{"source":"twitch"}`))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body=%s)", rec.Code, rec.Body.String())
	}
	if len(store.resolveCalls) != 1 {
		t.Fatalf("%d resolve calls, want 1 — the answer was discarded on a read blip",
			len(store.resolveCalls))
	}
	if got := store.resolveCalls[0]; got.source != "twitch" || got.status != "answered" {
		t.Errorf("resolve call = %+v, want the user's actual answer", got)
	}
	if decodeBody(t, rec)["recorded"] != true {
		t.Error("recorded should be true — the write landed despite the read failing")
	}
}

func TestSubmitSurfacesWriteFailures(t *testing.T) {
	store := &fakeReferralStore{status: "pending", resolveErr: errors.New("db down")}
	h := newTestReferralHandler(store)
	rec := httptest.NewRecorder()
	h.Submit(rec, authed(http.MethodPost, "/api/me/referral", `{"source":"twitch"}`))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
}

func TestSubmitRequiresAuthentication(t *testing.T) {
	h := newTestReferralHandler(&fakeReferralStore{status: "pending"})
	rec := httptest.NewRecorder()
	h.Submit(rec, httptest.NewRequest(http.MethodPost, "/api/me/referral", strings.NewReader(`{"skip":true}`)))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

// ---- GET /api/admin/referrals/summary ----

func TestSummaryLabelsKeysAndMarksRemovedOnes(t *testing.T) {
	store := &fakeReferralStore{
		settings: map[string]string{settingReferralOptions: `[{"key":"twitch","label":"Twitch.tv"}]`},
		summary: &models.ReferralSummary{
			Total: 3, Answered: 3,
			BySource: []models.ReferralSourceCount{
				{Key: "twitch", Count: 2},
				{Key: "myspace", Count: 1}, // option deleted after users chose it
				{Key: referralOtherKey, Count: 1},
			},
		},
	}
	h := newTestReferralHandler(store)
	rec := httptest.NewRecorder()
	h.Summary(rec, authed(http.MethodGet, "/api/admin/referrals/summary", ""))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	rows := decodeBody(t, rec)["by_source"].([]any)
	if len(rows) != 3 {
		t.Fatalf("%d rows, want 3 — a deleted option's answers must not be dropped", len(rows))
	}
	byKey := map[string]any{}
	for _, r := range rows {
		m := r.(map[string]any)
		byKey[m["key"].(string)] = m["label"]
	}
	// A renamed label follows, because answers store the key.
	if byKey["twitch"] != "Twitch.tv" {
		t.Errorf("twitch label = %v, want the current label", byKey["twitch"])
	}
	// A deleted option gets a nil label so the panel can mark it, not hide it.
	if byKey["myspace"] != nil {
		t.Errorf("removed key label = %v, want null", byKey["myspace"])
	}
	// "other" is deliberately UNLABELLED by the server: its display text is
	// product copy for an option the server does not store, and a second
	// spelling in Go is what let the admin panel say "Other" while the user was
	// shown "Something else". The client resolves it from its own constant.
	if byKey[referralOtherKey] != nil {
		t.Errorf("other label = %v, want null — the server must not name this option",
			byKey[referralOtherKey])
	}
}

func TestSummaryWindowParsing(t *testing.T) {
	empty := &models.ReferralSummary{BySource: []models.ReferralSourceCount{}}
	t.Run("valid windows are passed through", func(t *testing.T) {
		for _, days := range []string{"", "0", "7", "3650"} {
			store := &fakeReferralStore{summary: empty}
			h := newTestReferralHandler(store)
			rec := httptest.NewRecorder()
			h.Summary(rec, authed(http.MethodGet, "/api/admin/referrals/summary?days="+days, ""))
			if rec.Code != http.StatusOK {
				t.Errorf("days=%q → %d, want 200", days, rec.Code)
			}
		}
	})
	t.Run("out-of-range and non-numeric are rejected", func(t *testing.T) {
		for _, days := range []string{"-1", "3651", "abc", "1e3"} {
			store := &fakeReferralStore{summary: empty}
			h := newTestReferralHandler(store)
			rec := httptest.NewRecorder()
			h.Summary(rec, authed(http.MethodGet, "/api/admin/referrals/summary?days="+days, ""))
			if rec.Code != http.StatusBadRequest {
				t.Errorf("days=%q → %d, want 400", days, rec.Code)
			}
		}
	})
}

func TestSummaryOnAVirginInstance(t *testing.T) {
	// Nobody was ever eligible: a shaped zero payload, not an error, and
	// by_source must marshal as [] rather than null so the panel can map it.
	store := &fakeReferralStore{summary: &models.ReferralSummary{BySource: []models.ReferralSourceCount{}}}
	h := newTestReferralHandler(store)
	rec := httptest.NewRecorder()
	h.Summary(rec, authed(http.MethodGet, "/api/admin/referrals/summary", ""))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `"by_source":[]`) {
		t.Errorf("body = %s, want by_source as an empty array", rec.Body.String())
	}
}

func TestSummarySurfacesStoreFailures(t *testing.T) {
	h := newTestReferralHandler(&fakeReferralStore{summaryErr: errors.New("db down")})
	rec := httptest.NewRecorder()
	h.Summary(rec, authed(http.MethodGet, "/api/admin/referrals/summary", ""))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
}
