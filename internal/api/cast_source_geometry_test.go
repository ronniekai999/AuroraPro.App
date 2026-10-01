package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCastSourceResolutionParsingDoesNotInventFacts(t *testing.T) {
	for _, raw := range []string{"", "unknown", "1920x", "0x1080", "1920x0", "-640x1280", "1920x1080x30"} {
		if w, h := parseResolution(raw); w != 0 || h != 0 {
			t.Fatalf("parseResolution(%q) invented source dimensions %dx%d", raw, w, h)
		}
	}
	if w, h := parseResolution("640x1280"); w != 640 || h != 1280 {
		t.Fatalf("real portrait geometry was replaced: %dx%d", w, h)
	}
}

// Follow stored geometry through every production session mint path, then the
// Cast endpoint. A parser-only assertion would miss a later browser fallback
// being copied back into the source facts.
func TestCreateCastToken_SourceGeometryProvenanceAcrossSessionHandlers(t *testing.T) {
	for _, resolution := range []string{"", "malformed", "1920x720"} {
		t.Run("stored_"+resolution, func(t *testing.T) {
			f := newRCFixture(t)
			ctx := context.Background()
			mf, err := f.q.GetMediaFileByID(ctx, f.movieFileID)
			if err != nil {
				t.Fatal(err)
			}
			mf.Resolution, mf.Container, mf.VideoCodec, mf.VideoFPS = resolution, "mkv", "hevc", 30
			if err := f.q.UpsertMediaFile(ctx, mf); err != nil {
				t.Fatal(err)
			}
			ef, err := f.q.GetEpisodeFileByID(ctx, f.episodeFileID)
			if err != nil {
				t.Fatal(err)
			}
			ef.Resolution, ef.Container, ef.VideoCodec, ef.VideoFPS = resolution, "mkv", "hevc", 30
			if err := f.q.UpsertEpisodeFile(ctx, ef); err != nil {
				t.Fatal(err)
			}
			for _, tc := range []struct {
				name, fileType string
				fileID         int64
				legacy         bool
			}{
				{"session_movie", "media", f.movieFileID, false},
				{"session_episode", "episode", f.episodeFileID, false},
				{"legacy_movie", "media", f.movieFileID, true},
				{"legacy_episode", "episode", f.episodeFileID, true},
			} {
				t.Run(tc.name, func(t *testing.T) {
					h, tm := castAnchorHandler(t, "1080p")
					h.queries = f.q
					var req *http.Request
					var handler func(http.ResponseWriter, *http.Request)
					wantStatus := http.StatusCreated
					if tc.legacy {
						req = rcRouteReq(http.MethodGet, "/api/stream/"+tc.fileType+"/x", map[string]string{"fileID": i64(tc.fileID)})
						handler = h.StreamMediaFile
						if tc.fileType == "episode" {
							handler = h.StreamEpisodeFile
						}
						wantStatus = http.StatusOK
					} else {
						body := `{"file_id":` + i64(tc.fileID) + `,"file_type":"` + tc.fileType + `"}`
						req = httptest.NewRequest(http.MethodPost, "/api/stream/sessions", strings.NewReader(body))
						req.Header.Set("Content-Type", "application/json")
						handler = h.CreateSession
					}
					req = rcClaimsCtx(req, f.userID, f.unrestrictedRefreshID)
					rr := httptest.NewRecorder()
					handler(rr, req)
					if rr.Code != wantStatus {
						t.Fatalf("browser session failed: status=%d body=%s", rr.Code, rr.Body.String())
					}
					rows := tm.ListSessions()
					if len(rows) != 1 {
						t.Fatalf("expected one browser session, got %+v", rows)
					}
					src, ok := tm.GetSession(rows[0].ID)
					if !ok {
						t.Fatal("missing browser session")
					}
					castReq := castTokenRequest(t, src.ID, "at=0", nil)
					castReq = rcClaimsCtx(castReq, f.userID, f.unrestrictedRefreshID)
					rr = httptest.NewRecorder()
					h.CreateCastToken(rr, castReq)
					if resolution != "1920x720" {
						if src.SourceWidth != 0 || src.SourceHeight != 0 || len(src.Profiles) != 1 || src.Profiles[0].Width != 1920 {
							t.Fatalf("browser fallback overwrote source facts: %+v", src)
						}
						if rr.Code != http.StatusServiceUnavailable || len(tm.ListSessions()) != 1 {
							t.Fatalf("unknown geometry accepted/leaked copy: status=%d body=%s", rr.Code, rr.Body.String())
						}
						// AirPlay keeps using the original browser stream, including
						// native-HLS token minting when no receiver is connected.
						rr = httptest.NewRecorder()
						h.CreateCastToken(rr, rcClaimsCtx(castTokenRequest(t, src.ID, "for_airplay=true", nil), f.userID, f.unrestrictedRefreshID))
						if rr.Code != http.StatusOK || len(tm.ListSessions()) != 1 {
							t.Fatalf("AirPlay/browser fallback regressed: status=%d body=%s", rr.Code, rr.Body.String())
						}
					} else {
						if rr.Code != http.StatusOK || len(tm.ListSessions()) != 2 || src.SourceWidth != 1920 || src.SourceHeight != 720 {
							t.Fatalf("wide crop did not get a supported copy: status=%d body=%s", rr.Code, rr.Body.String())
						}
						for _, row := range tm.ListSessions() {
							if row.ID == src.ID {
								continue
							}
							copy, _ := tm.GetSession(row.ID)
							if len(copy.Profiles) != 1 || copy.Profiles[0].CodecString != "avc1.640028,mp4a.40.2" || src.Profiles[0].CodecString != "avc1.640020,mp4a.40.2" {
								t.Fatalf("copy/local levels incorrect: copy=%+v local=%+v", copy.Profiles, src.Profiles)
							}
						}
					}
				})
			}
		})
	}
}
