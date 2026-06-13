package streaming

// Tests for issue #324 — "4K stream playing but not 1080p" on Chromecast.
//
// Root cause: a REMUX session's master playlist omits the CODECS attribute
// (the copied stream's exact H.264 profile/level is unknown at session-create
// time). hls.js/Safari tolerate that, but the Chromecast Default Media
// Receiver does not — with fMP4 (CMAF) segments it silently fails to play
// after loadMedia resolves. A 4K HEVC source already got an H.264 transcode
// clone (#322), which DOES carry CODECS, so 4K worked while 1080p H.264 remux
// did not. The fix forces ANY remux session to a transcode clone before
// casting so the cast manifest always carries a CODECS attribute.

import (
	"testing"

	"github.com/aurora-media/aurora/internal/config"
)

func TestCastRemuxNeedsTranscode(t *testing.T) {
	if !CastRemuxNeedsTranscode(true) {
		t.Error("CastRemuxNeedsTranscode(remux=true) = false, want true — remux playlists omit CODECS and the receiver needs it")
	}
	if CastRemuxNeedsTranscode(false) {
		t.Error("CastRemuxNeedsTranscode(remux=false) = true, want false — transcode sessions already carry CODECS")
	}
}

// TestCloneForCast_H264RemuxForcesTranscode is the regression test for #324:
// an H.264 remux session (the 1080p case that failed) must be re-cloned as a
// transcode so its cast master playlist carries the CODECS attribute.
func TestCloneForCast_H264RemuxForcesTranscode(t *testing.T) {
	fakeFFmpegOnPath(t)
	tm, err := NewTranscodeManager(t.TempDir(), config.TranscodeConfig{SegmentFormat: "fmp4"})
	if err != nil {
		t.Fatalf("new transcode manager: %v", err)
	}
	defer tm.Close()

	// H.264 1080p remux with AAC audio — the exact shape that the cast guard
	// previously treated as "already safe" and reused unchanged.
	src := &TranscodeSession{
		ID:               "src-h264-remux",
		UserID:           7,
		FilePath:         "/library/show/s01e01.mkv",
		SourceWidth:      1920,
		SourceHeight:     1080,
		Remux:            true,
		SourceVideoCodec: "h264",
		AudioCodecOut:    "aac",
		AudioTrackIndex:  -1,
		BurnSubIndex:     -1,
		BurnSubRelIndex:  -1,
	}
	tm.mu.Lock()
	tm.sessions[src.ID] = src
	tm.mu.Unlock()

	clone, err := tm.CloneForCast(7, "ronnie", src.ID)
	if err != nil {
		t.Fatalf("CloneForCast: %v", err)
	}
	if clone.ID == src.ID {
		t.Fatal("CloneForCast reused the H.264 remux session unchanged — must create a transcode clone so the cast manifest carries CODECS (#324)")
	}
	if clone.Remux {
		t.Error("cast clone is still a remux — must be a transcode so master playlist CODECS is populated")
	}
	// A transcode clone populates CodecString on every profile (the receiver
	// needs it); a remux session would leave it empty.
	if len(clone.Profiles) == 0 {
		t.Fatal("cast clone has no profiles")
	}
	for _, p := range clone.Profiles {
		if p.CodecString == "" {
			t.Errorf("cast clone profile %q has empty CodecString — master playlist would omit CODECS and the receiver would silently fail", p.Name)
		}
	}
}

// TestCloneForCast_DropsSubtitleTracks is the regression test for issue #328:
// the cast clone must not carry the source session's SubtitleTracks. When
// subtitle tracks propagate into the clone, GenerateMasterPlaylist emits a
// SUBTITLES rendition group, and the Chromecast Default Media Receiver (Shaka)
// stalls after loadMedia resolves — it accepts the LoadRequest but never begins
// decoding. Dropping SubtitleTracks produces a subtitle-free master playlist that
// Shaka plays without issue.
func TestCloneForCast_DropsSubtitleTracks(t *testing.T) {
	fakeFFmpegOnPath(t)
	tm, err := NewTranscodeManager(t.TempDir(), config.TranscodeConfig{SegmentFormat: "fmp4"})
	if err != nil {
		t.Fatalf("new transcode manager: %v", err)
	}
	defer tm.Close()

	src := &TranscodeSession{
		ID:               "src-with-subs",
		UserID:           7,
		FilePath:         "/library/movie.mkv",
		SourceWidth:      1920,
		SourceHeight:     1080,
		Remux:            true, // triggers CloneForCast
		SourceVideoCodec: "h264",
		AudioCodecOut:    "aac",
		AudioTrackIndex:  -1,
		BurnSubIndex:     -1,
		BurnSubRelIndex:  -1,
		SubtitleTracks: []HLSSubtitleTrack{
			{Language: "eng", Title: "English", Default: true},
		},
	}
	tm.mu.Lock()
	tm.sessions[src.ID] = src
	tm.mu.Unlock()

	clone, err := tm.CloneForCast(7, "ronnie", src.ID)
	if err != nil {
		t.Fatalf("CloneForCast: %v", err)
	}
	if clone.ID == src.ID {
		t.Fatal("CloneForCast reused the remux session unchanged — expected a transcode clone")
	}
	if len(clone.SubtitleTracks) != 0 {
		t.Errorf("cast clone has %d SubtitleTracks, want 0 — subtitle group in master playlist causes Shaka to stall after loadMedia resolves (#328)", len(clone.SubtitleTracks))
	}
}

// TestCloneForCast_TranscodeWithSubsForcesClone is the regression test for the
// common #328 trigger: an HEVC (or other non-H.264) source on Chrome produces a
// H.264 transcode session with AAC audio and attached subtitle tracks. Before the
// fix, CloneForCast treated that session as "already cast-safe" (H.264+AAC) and
// returned it unchanged — its master playlist still carried the SUBTITLES group
// that causes Shaka to stall. Now, having subtitle tracks is itself a clone
// trigger so the Chromecast always gets a subtitle-free manifest.
func TestCloneForCast_TranscodeWithSubsForcesClone(t *testing.T) {
	fakeFFmpegOnPath(t)
	tm, err := NewTranscodeManager(t.TempDir(), config.TranscodeConfig{SegmentFormat: "fmp4"})
	if err != nil {
		t.Fatalf("new transcode manager: %v", err)
	}
	defer tm.Close()

	// H.264 transcode with AAC audio and English subtitles — would previously
	// have been returned unchanged and stalled the Chromecast receiver.
	src := &TranscodeSession{
		ID:               "src-h264-transcode-with-subs",
		UserID:           7,
		FilePath:         "/library/movie.mkv",
		SourceWidth:      1920,
		SourceHeight:     1080,
		Remux:            false, // transcode — H.264+AAC already "cast-safe" on video/audio
		SourceVideoCodec: "hevc",
		AudioCodecOut:    "aac",
		AudioTrackIndex:  -1,
		BurnSubIndex:     -1,
		BurnSubRelIndex:  -1,
		SubtitleTracks:   []HLSSubtitleTrack{{AbsoluteIndex: 0, Language: "eng", Title: "English"}},
	}
	tm.mu.Lock()
	tm.sessions[src.ID] = src
	tm.mu.Unlock()

	clone, err := tm.CloneForCast(7, "ronnie", src.ID)
	if err != nil {
		t.Fatalf("CloneForCast: %v", err)
	}
	if clone.ID == src.ID {
		t.Fatal("CloneForCast reused the transcode-with-subtitles session unchanged — must clone to produce a subtitle-free cast manifest (#328)")
	}
	if len(clone.SubtitleTracks) != 0 {
		t.Errorf("cast clone has %d SubtitleTracks, want 0 — SUBTITLES group in master playlist causes Shaka to stall (#328)", len(clone.SubtitleTracks))
	}
}

// TestCloneForCast_TranscodeReusedUnchanged confirms the fix did NOT over-reach:
// a plain H.264 transcode session with AAC audio and NO subtitles is already
// cast-safe and must be reused as-is, never needlessly re-cloned.
func TestCloneForCast_TranscodeReusedUnchanged(t *testing.T) {
	tm, err := NewTranscodeManager(t.TempDir(), config.TranscodeConfig{SegmentFormat: "fmp4"})
	if err != nil {
		t.Fatalf("new transcode manager: %v", err)
	}
	defer tm.Close()

	src := &TranscodeSession{
		ID:              "src-h264-transcode",
		UserID:          7,
		FilePath:        "/library/movie.mkv",
		SourceWidth:     1920,
		SourceHeight:    1080,
		Remux:           false, // transcode → emits H.264 + CODECS string
		AudioCodecOut:   "aac",
		AudioTrackIndex: -1,
		BurnSubIndex:    -1,
		BurnSubRelIndex: -1,
		// SubtitleTracks: nil — no subs, so no clone needed
	}
	tm.mu.Lock()
	tm.sessions[src.ID] = src
	tm.mu.Unlock()

	clone, err := tm.CloneForCast(7, "ronnie", src.ID)
	if err != nil {
		t.Fatalf("CloneForCast: %v", err)
	}
	if clone.ID != src.ID {
		t.Errorf("CloneForCast re-cloned an already-safe H.264 transcode session with no subs (got %q, want %q) — wasteful", clone.ID, src.ID)
	}
}
