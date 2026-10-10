package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The create-session response must describe the effective audio mode after
// normalization. The old audio_passthrough flag applies only to full video
// transcodes, so copied-audio remuxes need a distinct response fact.
func TestCreateSession_ReportsEffectiveAudioCopy(t *testing.T) {
	for _, tc := range []struct {
		name, sourceCodec string
		remux, wantCopy   bool
	}{
		{"remux_copies_aac", "aac", true, true},
		{"remux_converts_unsafe_dts", "dts", true, false},
		{"video_transcode_copies_aac", "aac", false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newRCFixture(t)
			mf, err := f.q.GetMediaFileByID(context.Background(), f.movieFileID)
			if err != nil {
				t.Fatal(err)
			}
			mf.AudioCodec, mf.Resolution = tc.sourceCodec, "1920x1080"
			if err := f.q.UpsertMediaFile(context.Background(), mf); err != nil {
				t.Fatal(err)
			}
			h, tm := castAnchorHandler(t, "1080p")
			h.queries = f.q
			body := fmt.Sprintf(`{"file_id":%d,"file_type":"media","remux":%t,"audio_passthrough":true,"audio_codec_out":"aac"}`, f.movieFileID, tc.remux)
			r := httptest.NewRequest(http.MethodPost, "/api/stream/sessions", strings.NewReader(body))
			r.Header.Set("Content-Type", "application/json")
			r = rcClaimsCtx(r, f.userID, f.unrestrictedRefreshID)
			rr := httptest.NewRecorder()
			h.CreateSession(rr, r)
			if rr.Code != http.StatusCreated {
				t.Fatalf("create-session: status=%d body=%s", rr.Code, rr.Body.String())
			}
			var response map[string]any
			if err := json.Unmarshal(rr.Body.Bytes(), &response); err != nil {
				t.Fatal(err)
			}
			if got, ok := response["audio_copy"].(bool); !ok || got != tc.wantCopy {
				t.Fatalf("effective audio_copy=%v, want %v: %v", response["audio_copy"], tc.wantCopy, response)
			}
			if got := response["audio_passthrough"]; got != (!tc.remux && tc.wantCopy) {
				t.Fatalf("legacy audio_passthrough contract changed: %v", got)
			}
			session, ok := tm.GetSession(response["session_id"].(string))
			if !ok || session.Remux != tc.remux {
				t.Fatalf("fixture did not exercise requested session mode: %+v", session)
			}
		})
	}
}
