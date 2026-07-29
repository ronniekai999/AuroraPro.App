package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"

	"github.com/aurora-media/aurora/internal/auth"
)

// Regression tests for UpdateSettings' validate-all-then-write-all ordering.
//
// The handler used to validate and upsert in the same pass over req.Settings.
// Go randomizes map iteration, so a request carrying one bad key persisted an
// arbitrary, non-reproducible subset of the good keys before returning 400.
// That was survivable while every admin panel saved one key at a time; the
// referral prompt editor saves its question and its option list together, where
// a half-applied save leaves the pair inconsistent.
//
// These exercise the validation ordering through the real allowedKeys map by
// calling the handler, with the write step captured — the previous behavior is
// only observable in WHICH writes happen before the error.

// recordingSettingsWriter captures UpsertSetting calls in order.
type recordingSettingsWriter struct {
	writes []string
}

func (w *recordingSettingsWriter) UpsertSetting(_ context.Context, key, _ string, _ int64) error {
	w.writes = append(w.writes, key)
	return nil
}

func settingsPutReq(body string) *http.Request {
	r := httptest.NewRequest(http.MethodPut, "/api/admin/settings", strings.NewReader(body))
	claims := &auth.JWTClaims{UserID: 1, Username: "admin", Role: "admin"}
	return r.WithContext(context.WithValue(r.Context(), auth.ClaimsContextKey, claims))
}

// TestUpdateSettingsWritesNothingWhenAnyKeyIsInvalid is the actual regression.
// The valid key here sorts BEFORE the invalid one, so under the old
// validate-and-write-in-one-pass code it would have been persisted roughly half
// the time (whenever map iteration happened to reach it first).
func TestUpdateSettingsWritesNothingWhenAnyKeyIsInvalid(t *testing.T) {
	w := &recordingSettingsWriter{}
	h := &AdminHandler{settingsWriter: w}
	rec := httptest.NewRecorder()

	// completion_threshold is valid; referral_prompt_options is malformed.
	h.UpdateSettings(rec, settingsPutReq(`{"settings":{
		"completion_threshold":"0.5",
		"referral_prompt_options":"[{\"key\":\"OTHER\"}]"
	}}`))

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (body=%s)", rec.Code, rec.Body.String())
	}
	if len(w.writes) != 0 {
		t.Errorf("persisted %v before rejecting the request; a rejected save must write nothing", w.writes)
	}
}

func TestUpdateSettingsRejectsUnknownKeysWithoutWriting(t *testing.T) {
	w := &recordingSettingsWriter{}
	h := &AdminHandler{settingsWriter: w}
	rec := httptest.NewRecorder()
	h.UpdateSettings(rec, settingsPutReq(`{"settings":{"completion_threshold":"0.5","not_a_setting":"x"}}`))

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	if len(w.writes) != 0 {
		t.Errorf("persisted %v alongside an unknown key", w.writes)
	}
}

// TestUpdateSettingsErrorIsDeterministic pins the sorted validation order. With
// two invalid keys, map iteration order previously decided which one the error
// named, so the same request body could produce different responses.
func TestUpdateSettingsErrorIsDeterministic(t *testing.T) {
	const body = `{"settings":{"requests_quota_daily":"nope","completion_threshold":"nope"}}`
	seen := map[string]bool{}
	for i := 0; i < 25; i++ {
		rec := httptest.NewRecorder()
		h := &AdminHandler{settingsWriter: &recordingSettingsWriter{}}
		h.UpdateSettings(rec, settingsPutReq(body))
		seen[rec.Body.String()] = true
	}
	if len(seen) != 1 {
		keys := make([]string, 0, len(seen))
		for k := range seen {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		t.Errorf("the same request produced %d different responses: %v", len(seen), keys)
	}
	// completion_threshold sorts first, so it is the one reported.
	for body := range seen {
		if !strings.Contains(body, "completion_threshold") {
			t.Errorf("error names %q, want the alphabetically-first invalid key", body)
		}
	}
}

func TestUpdateSettingsWritesEveryKeyWhenAllValid(t *testing.T) {
	w := &recordingSettingsWriter{}
	h := &AdminHandler{settingsWriter: w}
	rec := httptest.NewRecorder()
	h.UpdateSettings(rec, settingsPutReq(`{"settings":{
		"referral_prompt_question":"Where'd you find us?",
		"referral_prompt_options":"[{\"key\":\"podcast\",\"label\":\"A podcast\"}]"
	}}`))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body=%s)", rec.Code, rec.Body.String())
	}
	got := append([]string(nil), w.writes...)
	sort.Strings(got)
	want := []string{"referral_prompt_options", "referral_prompt_question"}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Errorf("writes = %v, want both referral keys — the pair must save together", got)
	}
}

// TestUpdateSettingsAcceptsReferralDefaultsRoundTrip guards the "empty means
// revert to the built-in default" contract both referral keys rely on.
func TestUpdateSettingsAcceptsReferralDefaultsRoundTrip(t *testing.T) {
	w := &recordingSettingsWriter{}
	h := &AdminHandler{settingsWriter: w}
	rec := httptest.NewRecorder()
	h.UpdateSettings(rec, settingsPutReq(`{"settings":{"referral_prompt_question":"","referral_prompt_options":""}}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 — clearing a customization must be allowed", rec.Code)
	}
	if len(w.writes) != 2 {
		t.Errorf("writes = %v, want both keys cleared", w.writes)
	}
}
