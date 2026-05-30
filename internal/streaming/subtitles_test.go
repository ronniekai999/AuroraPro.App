package streaming

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestIsBitmapSubtitle(t *testing.T) {
	tests := []struct {
		name  string
		codec string
		want  bool
	}{
		// Bitmap formats (should return true)
		{name: "PGS full name", codec: "hdmv_pgs_subtitle", want: true},
		{name: "PGS short", codec: "pgssub", want: true},
		{name: "PGS alias", codec: "pgs", want: true},
		{name: "DVD subtitle", codec: "dvd_subtitle", want: true},
		{name: "DVD sub short", codec: "dvdsub", want: true},
		{name: "VOBSUB", codec: "vobsub", want: true},
		{name: "DVB subtitle", codec: "dvb_subtitle", want: true},
		{name: "DVB sub short", codec: "dvbsub", want: true},
		{name: "XSUB", codec: "xsub", want: true},

		// Case insensitive
		{name: "uppercase PGS", codec: "HDMV_PGS_SUBTITLE", want: true},
		{name: "mixed case PGS", codec: "Hdmv_Pgs_Subtitle", want: true},

		// Text formats (should return false)
		{name: "SRT", codec: "srt", want: false},
		{name: "subrip", codec: "subrip", want: false},
		{name: "ASS", codec: "ass", want: false},
		{name: "SSA", codec: "ssa", want: false},
		{name: "WebVTT", codec: "webvtt", want: false},
		{name: "mov_text", codec: "mov_text", want: false},

		// Edge cases
		{name: "empty string", codec: "", want: false},
		{name: "unknown codec", codec: "unknown_codec", want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := IsBitmapSubtitle(tt.codec)
			if got != tt.want {
				t.Errorf("IsBitmapSubtitle(%q) = %v, want %v", tt.codec, got, tt.want)
			}
		})
	}
}

func TestFindExternalSubtitles(t *testing.T) {
	dir := t.TempDir()

	// Create a media file and associated subtitle files
	mediaPath := filepath.Join(dir, "Movie.2024.mkv")
	if err := os.WriteFile(mediaPath, []byte{}, 0o644); err != nil {
		t.Fatal(err)
	}

	// Create subtitle files
	subFiles := []string{
		"Movie.2024.eng.srt",
		"Movie.2024.fra.srt",
		"Movie.2024.vtt",
		"Movie.2024.jpn.ass",
		"Movie.2024.ssa",
	}
	for _, f := range subFiles {
		if err := os.WriteFile(filepath.Join(dir, f), []byte("subtitle content"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	// Create unrelated files that should NOT be picked up
	unrelated := []string{
		"OtherMovie.eng.srt", // Different base name
		"Movie.2024.nfo",     // Not a subtitle extension
		"Movie.2024.eng.txt", // Not a subtitle extension
	}
	for _, f := range unrelated {
		if err := os.WriteFile(filepath.Join(dir, f), []byte("content"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	tracks := FindExternalSubtitles(mediaPath)

	if len(tracks) != 5 {
		var names []string
		for _, tr := range tracks {
			names = append(names, filepath.Base(tr.Title))
		}
		t.Fatalf("expected 5 tracks, got %d: %v", len(tracks), names)
	}

	// Verify indices start at 1000 (to avoid collision with embedded tracks)
	for _, track := range tracks {
		if track.Index < 1000 {
			t.Errorf("external track index %d should be >= 1000", track.Index)
		}
	}

	// Verify language extraction
	langMap := make(map[string]bool)
	for _, track := range tracks {
		langMap[track.Language] = true
	}
	if !langMap["eng"] {
		t.Error("expected to find 'eng' language track")
	}
	if !langMap["fra"] {
		t.Error("expected to find 'fra' language track")
	}
	if !langMap["jpn"] {
		t.Error("expected to find 'jpn' language track")
	}
}

func TestFindExternalSubtitles_NoSubtitles(t *testing.T) {
	dir := t.TempDir()

	mediaPath := filepath.Join(dir, "Movie.mkv")
	if err := os.WriteFile(mediaPath, []byte{}, 0o644); err != nil {
		t.Fatal(err)
	}

	tracks := FindExternalSubtitles(mediaPath)
	if len(tracks) != 0 {
		t.Errorf("expected 0 tracks, got %d", len(tracks))
	}
}

func TestFindExternalSubtitles_NonexistentDir(t *testing.T) {
	tracks := FindExternalSubtitles("/nonexistent/path/Movie.mkv")
	if tracks != nil {
		t.Errorf("expected nil tracks for nonexistent dir, got %v", tracks)
	}
}

func TestConvertSRTtoVTT(t *testing.T) {
	dir := t.TempDir()
	cacheDir := filepath.Join(dir, "cache")

	srtContent := `1
00:00:01,000 --> 00:00:04,500
Hello, world!

2
00:00:05,000 --> 00:00:08,999
This is a test subtitle.

3
00:01:00,123 --> 00:01:05,456
Third cue with timestamps.
`
	srtPath := filepath.Join(dir, "test.srt")
	if err := os.WriteFile(srtPath, []byte(srtContent), 0o644); err != nil {
		t.Fatal(err)
	}

	vttPath, err := ConvertSRTtoVTT(srtPath, cacheDir)
	if err != nil {
		t.Fatalf("ConvertSRTtoVTT() error: %v", err)
	}

	if !strings.HasSuffix(vttPath, ".vtt") {
		t.Errorf("output path should end with .vtt: %q", vttPath)
	}

	// Read the VTT content and verify
	content, err := os.ReadFile(vttPath)
	if err != nil {
		t.Fatalf("read VTT file: %v", err)
	}

	vtt := string(content)

	// Must start with WEBVTT header
	if !strings.HasPrefix(vtt, "WEBVTT") {
		t.Error("VTT file should start with WEBVTT header")
	}

	// Commas should be converted to periods in timestamps
	if strings.Contains(vtt, "00:00:01,000") {
		t.Error("SRT comma timestamps should be converted to periods")
	}
	if !strings.Contains(vtt, "00:00:01.000") {
		t.Error("VTT should contain period-based timestamps")
	}
	if !strings.Contains(vtt, "00:00:04.500") {
		t.Error("VTT should contain period-based timestamps for end time")
	}

	// Subtitle text should be preserved
	if !strings.Contains(vtt, "Hello, world!") {
		t.Error("subtitle text should be preserved")
	}
	if !strings.Contains(vtt, "This is a test subtitle.") {
		t.Error("subtitle text should be preserved")
	}
}

func TestConvertSRTtoVTT_Caching(t *testing.T) {
	dir := t.TempDir()
	cacheDir := filepath.Join(dir, "cache")

	srtPath := filepath.Join(dir, "test.srt")
	if err := os.WriteFile(srtPath, []byte("1\n00:00:01,000 --> 00:00:02,000\nHello\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	// First call creates the VTT
	vttPath1, err := ConvertSRTtoVTT(srtPath, cacheDir)
	if err != nil {
		t.Fatalf("first call error: %v", err)
	}

	// Second call should return cached version
	vttPath2, err := ConvertSRTtoVTT(srtPath, cacheDir)
	if err != nil {
		t.Fatalf("second call error: %v", err)
	}

	if vttPath1 != vttPath2 {
		t.Errorf("cached path mismatch: %q vs %q", vttPath1, vttPath2)
	}
}

func TestConvertSRTtoVTT_NonexistentSRT(t *testing.T) {
	dir := t.TempDir()
	_, err := ConvertSRTtoVTT("/nonexistent/test.srt", dir)
	if err == nil {
		t.Error("expected error for nonexistent SRT file")
	}
}

func TestEscapeFFmpegPath(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{name: "no special chars", input: "/media/movie.mkv", want: "/media/movie.mkv"},
		{name: "colon", input: "C:/media/movie.mkv", want: "C\\:/media/movie.mkv"},
		{name: "brackets", input: "/media/[movie].mkv", want: "/media/\\[movie\\].mkv"},
		{name: "semicolon", input: "/media/a;b.mkv", want: "/media/a\\;b.mkv"},
		{name: "equals", input: "/media/a=b.mkv", want: "/media/a\\=b.mkv"},
		{name: "comma", input: "/media/a,b.mkv", want: "/media/a\\,b.mkv"},
		{name: "backslash", input: "C:\\media\\movie.mkv", want: "C\\:\\\\media\\\\movie.mkv"},
		// Filtergraph escaping: a single quote becomes \' (backslash-quote), NOT
		// shell-style '\'' which would toggle quote regions (audit LOW).
		{name: "single quote", input: "/media/it's.mkv", want: "/media/it\\'s.mkv"},
		// Every filtergraph metacharacter present at once must round-trip to a
		// literal form: each is prefixed with exactly one backslash and the
		// quote never opens a region (no bare leading/trailing ' left unescaped).
		{
			name:  "all filtergraph metachars",
			input: "/m/a:b;c=d,e[f]g'h.mkv",
			want:  "/m/a\\:b\\;c\\=d\\,e\\[f\\]g\\'h.mkv",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := escapeFFmpegPath(tt.input)
			if got != tt.want {
				t.Errorf("escapeFFmpegPath(%q) = %q, want %q", tt.input, got, tt.want)
			}
			// A filtergraph literal must never contain the shell-style
			// quote-toggle sequence '\'' (apostrophe, backslash, apostrophe,
			// apostrophe) — that would open/close quote regions instead of
			// escaping. Asserting its absence pins the fix.
			if strings.Contains(got, "'\\''") {
				t.Errorf("escapeFFmpegPath(%q) = %q contains shell-style quote toggle %q", tt.input, got, "'\\''")
			}
			// Every apostrophe in the output must be backslash-escaped: each "'"
			// is immediately preceded by an odd run of backslashes. Since the
			// source paths above contain no backslashes of their own, a simpler
			// invariant holds — no apostrophe is unescaped.
			if strings.Contains(tt.input, "'") && !strings.Contains(got, "\\'") {
				t.Errorf("escapeFFmpegPath(%q) = %q did not backslash-escape the quote", tt.input, got)
			}
		})
	}
}

func TestBurnInArgs_External(t *testing.T) {
	args := BurnInArgs("/media/movie.mkv", 0, "/media/movie.eng.srt")

	if len(args) != 2 {
		t.Fatalf("expected 2 args, got %d: %v", len(args), args)
	}
	if args[0] != "-vf" {
		t.Errorf("args[0] = %q, want %q", args[0], "-vf")
	}
	if !strings.HasPrefix(args[1], "subtitles=") {
		t.Errorf("args[1] should start with subtitles=, got %q", args[1])
	}
}

func TestBurnInArgs_Embedded(t *testing.T) {
	args := BurnInArgs("/media/movie.mkv", 3, "")

	if len(args) != 2 {
		t.Fatalf("expected 2 args, got %d: %v", len(args), args)
	}
	if args[0] != "-vf" {
		t.Errorf("args[0] = %q, want %q", args[0], "-vf")
	}
	if !strings.Contains(args[1], "stream_index=3") {
		t.Errorf("args should reference stream_index=3, got %q", args[1])
	}
}

func TestBurnInBitmapArgs_WithScale(t *testing.T) {
	args := BurnInBitmapArgs(5, "scale=1920:1080")

	if len(args) != 2 {
		t.Fatalf("expected 2 args, got %d: %v", len(args), args)
	}
	if args[0] != "-filter_complex" {
		t.Errorf("args[0] = %q, want %q", args[0], "-filter_complex")
	}
	if !strings.Contains(args[1], "overlay") {
		t.Error("filter_complex should contain overlay")
	}
	if !strings.Contains(args[1], "scale=1920:1080") {
		t.Error("filter_complex should contain the scale filter")
	}
	if !strings.Contains(args[1], "[0:5]") {
		t.Errorf("filter_complex should reference subtitle stream index 5, got %q", args[1])
	}
}

func TestBurnInBitmapArgs_NoScale(t *testing.T) {
	args := BurnInBitmapArgs(3, "")

	if len(args) != 2 {
		t.Fatalf("expected 2 args, got %d: %v", len(args), args)
	}
	if !strings.Contains(args[1], "[0:v][0:3]overlay") {
		t.Errorf("expected overlay of video and stream 3, got %q", args[1])
	}
}

// ============================================================
// HLS Inline Subtitle Pipeline Tests
// ============================================================

func TestGenerateMasterPlaylist_WithSubtitles(t *testing.T) {
	profiles := []QualityProfile{
		{Name: "1080p", Width: 1920, Height: 1080, HLSBandwidth: 5500000, CodecString: "avc1.420028,mp4a.40.2"},
		{Name: "720p", Width: 1280, Height: 720, HLSBandwidth: 3200000, CodecString: "avc1.42001f,mp4a.40.2"},
	}
	subs := []HLSSubtitleTrack{
		{AbsoluteIndex: 2, Language: "eng", Title: "English", Default: true},
		{AbsoluteIndex: 3, Language: "spa", Title: "Spanish"},
		{AbsoluteIndex: 4, Language: "fre", Title: "French (Forced)", Forced: true},
	}

	playlist := GenerateMasterPlaylist(profiles, "/api/stream/hls/abc", "", subs)

	// Must contain subtitle media entries
	if !strings.Contains(playlist, "#EXT-X-MEDIA:TYPE=SUBTITLES") {
		t.Error("playlist should contain EXT-X-MEDIA SUBTITLES entries")
	}
	if !strings.Contains(playlist, `GROUP-ID="subs"`) {
		t.Error("playlist should use GROUP-ID subs")
	}
	if !strings.Contains(playlist, `LANGUAGE="eng"`) {
		t.Error("playlist should have English language")
	}
	if !strings.Contains(playlist, `LANGUAGE="spa"`) {
		t.Error("playlist should have Spanish language")
	}
	if !strings.Contains(playlist, `LANGUAGE="fre"`) {
		t.Error("playlist should have French language")
	}
	if !strings.Contains(playlist, "DEFAULT=YES") {
		t.Error("English track should be DEFAULT=YES")
	}
	if !strings.Contains(playlist, `FORCED=YES`) {
		t.Error("French forced track should have FORCED=YES")
	}
	if !strings.Contains(playlist, "subs_0.m3u8") {
		t.Error("playlist should reference subs_0.m3u8")
	}
	if !strings.Contains(playlist, "subs_1.m3u8") {
		t.Error("playlist should reference subs_1.m3u8")
	}
	if !strings.Contains(playlist, "subs_2.m3u8") {
		t.Error("playlist should reference subs_2.m3u8")
	}

	// STREAM-INF lines should have SUBTITLES="subs"
	if !strings.Contains(playlist, `SUBTITLES="subs"`) {
		t.Error("STREAM-INF lines should include SUBTITLES attribute")
	}

	// Variant URLs should still be present
	if !strings.Contains(playlist, "/api/stream/hls/abc/1080p/stream.m3u8") {
		t.Error("playlist should contain 1080p variant URL")
	}
}

func TestGenerateMasterPlaylist_WithSubtitlesAndToken(t *testing.T) {
	profiles := []QualityProfile{
		{Name: "720p", Width: 1280, Height: 720, HLSBandwidth: 3200000},
	}
	subs := []HLSSubtitleTrack{
		{AbsoluteIndex: 2, Language: "eng", Title: "English"},
	}

	playlist := GenerateMasterPlaylist(profiles, "/api/stream/hls/abc", "tok123", subs)

	// Subtitle playlist URL should include token
	if !strings.Contains(playlist, "subs_0.m3u8?token=tok123") {
		t.Errorf("subtitle playlist URL should include token:\n%s", playlist)
	}
	// Variant URL should also include token
	if !strings.Contains(playlist, "stream.m3u8?token=tok123") {
		t.Errorf("variant URL should include token:\n%s", playlist)
	}
}

func TestGenerateMasterPlaylist_NoSubtitles(t *testing.T) {
	profiles := []QualityProfile{
		{Name: "720p", Width: 1280, Height: 720, HLSBandwidth: 3200000},
	}

	// No subtitle tracks (empty slice)
	playlist := GenerateMasterPlaylist(profiles, "/api/stream/hls/abc", "", []HLSSubtitleTrack{})

	// Should NOT contain subtitle entries
	if strings.Contains(playlist, "EXT-X-MEDIA") {
		t.Error("playlist without subtitles should not have EXT-X-MEDIA entries")
	}
	if strings.Contains(playlist, "SUBTITLES=") {
		t.Error("playlist without subtitles should not have SUBTITLES attribute")
	}
}

func TestGenerateMasterPlaylist_SubtitleDefaults(t *testing.T) {
	profiles := []QualityProfile{
		{Name: "720p", Width: 1280, Height: 720, HLSBandwidth: 3200000},
	}
	subs := []HLSSubtitleTrack{
		{AbsoluteIndex: 5, Language: "", Title: ""}, // No language or title
	}

	playlist := GenerateMasterPlaylist(profiles, "/api/stream/hls/abc", "", subs)

	// Should default language to "und"
	if !strings.Contains(playlist, `LANGUAGE="und"`) {
		t.Errorf("empty language should default to und:\n%s", playlist)
	}
	// Should use language as name when title is empty
	if !strings.Contains(playlist, `NAME="und"`) {
		t.Errorf("empty title should default to language:\n%s", playlist)
	}
}

func TestSanitizeHLSAttr(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{name: "no special chars", input: "English", want: "English"},
		{name: "double quotes", input: `English "SDH"`, want: "English SDH"},
		{name: "newline", input: "English\nSDH", want: "EnglishSDH"},
		{name: "carriage return", input: "English\rSDH", want: "EnglishSDH"},
		{name: "CRLF", input: "English\r\nSDH", want: "EnglishSDH"},
		{name: "mixed", input: "Eng\"lish\n(SDH)\r", want: "English(SDH)"},
		{name: "empty", input: "", want: ""},
		{name: "only quotes", input: `""`, want: ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := sanitizeHLSAttr(tt.input)
			if got != tt.want {
				t.Errorf("sanitizeHLSAttr(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestGenerateMasterPlaylist_SubtitleInjectionPrevention(t *testing.T) {
	profiles := []QualityProfile{
		{Name: "720p", Width: 1280, Height: 720, HLSBandwidth: 3200000},
	}
	subs := []HLSSubtitleTrack{
		{AbsoluteIndex: 2, Language: "eng", Title: "English \"SDH\"\nINJECTED"},
	}

	playlist := GenerateMasterPlaylist(profiles, "/api/stream/hls/abc", "", subs)

	// Double quotes should be stripped, preventing attribute injection
	if strings.Contains(playlist, "\"SDH\"") {
		t.Error("double quotes in title should be stripped")
	}
	// Newlines should be stripped, preventing line injection
	if strings.Contains(playlist, "INJECTED") && strings.Contains(playlist, "\nINJECTED") {
		t.Error("newlines in title should be stripped, not injected as new playlist lines")
	}
	// The sanitized name should appear
	if !strings.Contains(playlist, `NAME="English SDH`) {
		t.Errorf("sanitized name should appear in playlist:\n%s", playlist)
	}
}

func TestBoolYesNo(t *testing.T) {
	if boolYesNo(true) != "YES" {
		t.Error("boolYesNo(true) should be YES")
	}
	if boolYesNo(false) != "NO" {
		t.Error("boolYesNo(false) should be NO")
	}
}

func TestCanDirectPlay(t *testing.T) {
	tests := []struct {
		name       string
		container  string
		videoCodec string
		audioCodec string
		want       bool
	}{
		{name: "mp4 h264 aac", container: "mp4", videoCodec: "h264", audioCodec: "aac", want: true},
		{name: "webm vp9 opus", container: "webm", videoCodec: "vp9", audioCodec: "opus", want: false}, // opus not in HLS-safe DirectPlayAudioCodecs
		{name: "mkv h264 aac", container: "mkv", videoCodec: "h264", audioCodec: "aac", want: false},
		{name: "mp4 hevc aac", container: "mp4", videoCodec: "hevc", audioCodec: "aac", want: false},
		{name: "case insensitive", container: "MP4", videoCodec: "H264", audioCodec: "AAC", want: true},
		{name: "mov h264 aac", container: "mov", videoCodec: "h264", audioCodec: "aac", want: true},
		{name: "mp4 h264 dts rejected", container: "mp4", videoCodec: "h264", audioCodec: "dts", want: false},
		{name: "mp4 h264 truehd rejected", container: "mp4", videoCodec: "h264", audioCodec: "truehd", want: false},
		{name: "mp4 h264 mp3", container: "mp4", videoCodec: "h264", audioCodec: "mp3", want: true},
		{name: "mp4 h264 flac", container: "mp4", videoCodec: "h264", audioCodec: "flac", want: false}, // flac not in HLS-safe DirectPlayAudioCodecs
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := CanDirectPlay(tt.container, tt.videoCodec, tt.audioCodec)
			if got != tt.want {
				t.Errorf("CanDirectPlay(%q, %q, %q) = %v, want %v", tt.container, tt.videoCodec, tt.audioCodec, got, tt.want)
			}
		})
	}
}
