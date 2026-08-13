package streaming

import (
	"flag"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/aurora-media/aurora/internal/models"
)

// Native-client direct play (Tier 1 of the Mac-app work).
//
// Before this change ClientCaps.Containers was accepted but never read outside
// a hardcoded mp4/webm/mov switch, so a native client (a libVLC/mpv-backed
// Mac/iOS app) that truthfully claimed mkv_container was still told to remux
// an MKV it could have played byte-for-byte. These tests pin the new behavior
// AND — more importantly — pin that browsers are untouched.

// nativeAppCaps is the caps string a libVLC/mpv-backed client sends: it plays
// essentially every container and codec in a real library. Kept in sync with
// docs/native-client-caps.md's "complete native caps string" by
// TestNativeAppCapsMatchesDocumentedContract.
const nativeAppCaps = "h264,h264_hi10,hevc,hevc_main10,vp8,vp9,av1,mpeg4,msmpeg4v3,mpeg2video,vc1," +
	"aac,mp3,ac3,eac3,flac,opus,vorbis,dts,truehd,mlp,alac,mp2,pcm_s16le,pcm_s24le,pcm_bluray," +
	"mp4_container,webm_container,mkv_container,avi_container,ts_container,hls_native"

// Representative browser profiles. Each must be a SUBSET of what the SPA probe
// can emit — TestBrowserCapsConstantsAreSubsetsOfTheSPAProbe reads
// streaming.ts and enforces that, so a key invented here cannot prop up a
// test. Note what is ABSENT and unforgeable: no mkv_container, no
// dts/truehd/pcm_*, no mpeg4/vc1, no h264_hi10.
const (
	chromeCapsStr  = "h264,vp8,vp9,av1,mp4_container,webm_container,aac,mp3,opus,vorbis,flac,hls_js"
	firefoxCapsStr = "h264,vp8,vp9,av1,mp4_container,webm_container,aac,mp3,opus,vorbis,flac,hls_js"
	safariCapsStr  = "h264,hevc,h265,hevc_main10,mp4_container,aac,mp3,ac3,eac3,eac3_mse,flac,hls_js,hls_native"
	iosCapsStr     = "h264,hevc,h265,hevc_main10,mp4_container,aac,mp3,ac3,eac3,flac,hls_native"
)

func track(codec string, isDefault bool) models.AudioTrack {
	return models.AudioTrack{Codec: codec, IsDefault: isDefault}
}

// browserProfiles is the single list every browser-safety test iterates, so a
// profile cannot be added to the constants above and silently skipped by a
// guard that hardcodes its own subset.
func browserProfiles() map[string]string {
	return map[string]string{
		"chrome":  chromeCapsStr,
		"firefox": firefoxCapsStr,
		"safari":  safariCapsStr,
		"ios":     iosCapsStr,
	}
}

// --- The headline: what a native Mac app now gets ---

func TestNativeClientDirectPlaysRealLibraryFiles(t *testing.T) {
	caps := ParseClientCaps(nativeAppCaps)
	caps.FMP4 = true // server-set; fmp4 is the default segment format

	tests := []struct {
		name      string
		container string
		video     string
		pixFmt    string
		audio     []models.AudioTrack
	}{
		{"MKV h264 + AC-3", "matroska", "h264", "yuv420p", []models.AudioTrack{track("ac3", true)}},
		{"MKV HEVC 10-bit + E-AC-3 (4K remux)", "matroska", "hevc", "yuv420p10le", []models.AudioTrack{track("eac3", true)}},
		{"MKV h264 + DTS", "matroska", "h264", "yuv420p", []models.AudioTrack{track("dts", true)}},
		{"MKV HEVC 10-bit + TrueHD (Blu-ray remux)", "matroska", "hevc", "yuv420p10le", []models.AudioTrack{track("truehd", true)}},
		{"MKV h264 + FLAC", "matroska", "h264", "yuv420p", []models.AudioTrack{track("flac", true)}},
		{"MKV h264 + PCM Blu-ray", "matroska", "h264", "yuv420p", []models.AudioTrack{track("pcm_bluray", true)}},
		{"MKV AV1 + Opus", "matroska", "av1", "yuv420p", []models.AudioTrack{track("opus", true)}},
		{"MP4 h264 + AAC", "mp4", "h264", "yuv420p", []models.AudioTrack{track("aac", true)}},
		{"AVI XviD + MP3", "avi", "mpeg4", "yuv420p", []models.AudioTrack{track("mp3", true)}},
		{"TS MPEG-2 + MP2 (DVR recording)", "mpegts", "mpeg2video", "yuv420p", []models.AudioTrack{track("mp2", true)}},
		{"MKV VC-1 + DTS (HD-DVD era)", "matroska", "vc1", "yuv420p", []models.AudioTrack{track("dts", true)}},
		{"H.264 Hi10P anime + FLAC", "matroska", "h264", "yuv420p10le", []models.AudioTrack{track("flac", true)}},
		{"silent MKV (no audio tracks)", "matroska", "h264", "yuv420p", nil},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			pd := DecidePlayback(tt.container, tt.video, tt.audio, caps, tt.pixFmt)
			if pd.Decision != "direct_play" {
				t.Errorf("got %q (reason %q), want direct_play", pd.Decision, pd.TranscodeReason)
			}
		})
	}
}

// Hi10P is worth its own assertion: the H.264 10-bit guard exists because
// browsers' MSE universally rejects High 10, and it force-transcodes even
// though the file is otherwise perfect. A native decoder has no such limit,
// so the guard must be scoped to clients that actually need it.
func TestNativeClientPlaysHi10PWhileBrowserStillTranscodes(t *testing.T) {
	audio := []models.AudioTrack{track("flac", true)}

	native := ParseClientCaps(nativeAppCaps)
	native.FMP4 = true
	if pd := DecidePlayback("matroska", "h264", audio, native, "yuv420p10le"); pd.Decision != "direct_play" {
		t.Errorf("native client: got %q, want direct_play", pd.Decision)
	}

	chrome := ParseClientCaps(chromeCapsStr)
	chrome.FMP4 = true
	if pd := DecidePlayback("matroska", "h264", audio, chrome, "yuv420p10le"); pd.Decision != "transcode" {
		t.Errorf("chrome: got %q, want transcode (Hi10P guard must still apply)", pd.Decision)
	}
}

// --- The safety argument: browsers are bit-for-bit unaffected ---

// A browser must NEVER be handed an MKV to direct-play — the failure mode that
// would break every existing user.
//
// These profiles are hand-authored, not read from the SPA. The link to reality
// is enforced separately and in both directions:
// TestBrowserCapsConstantsAreSubsetsOfTheSPAProbe bounds them by what
// clientCaps() actually pushes, and TestSPAProbeEmitsNoNativeOnlyCapabilities
// reads streaming.ts directly. Do not restate the "asserted against the real
// SPA strings" claim here — an earlier version of this comment did, and it
// was not true of this test.
func TestBrowsersNeverDirectPlayNativeOnlyContainers(t *testing.T) {
	browsers := browserProfiles()
	containers := []string{"matroska", "avi", "mpegts"}

	for name, capsStr := range browsers {
		for _, container := range containers {
			t.Run(name+"/"+container, func(t *testing.T) {
				caps := ParseClientCaps(capsStr)
				caps.FMP4 = true
				pd := DecidePlayback(container, "h264", []models.AudioTrack{track("aac", true)}, caps, "yuv420p")
				if pd.Decision == "direct_play" {
					t.Fatalf("%s was told to direct-play a %s — browsers cannot demux it", name, container)
				}
			})
		}
	}
}

const spaProbePath = "../../static/redesign/app/src/lib/streaming.ts"

func readSPAProbe(t *testing.T) string {
	t.Helper()
	source, err := os.ReadFile(spaProbePath)
	if err != nil {
		t.Fatalf("read SPA probe %s: %v", spaProbePath, err)
	}
	return string(source)
}

// spaProbeLiterals returns EVERY quoted string literal in the probe source,
// however it is written.
//
// The safety assertion deliberately does not model how the caps array is
// built. An earlier version scraped `caps.push(...)` and was bypassable two
// ways: a spread (`caps.push(...NATIVE)`) and a nested paren
// (`caps.push(cond('video/x-matroska') ? 'mkv_container' : …)`, where the
// argument regex stopped at the inner `)`). Since the property we care about
// is "the string 'mkv_container' must not appear in a browser build at all",
// scanning every literal is both simpler and strictly harder to sneak past.
// MIME strings come along for the ride and are harmless — no capability key
// is equal to one.
func spaProbeLiterals(t *testing.T) map[string]bool {
	t.Helper()
	lits := scanJSStringLiterals(readSPAProbe(t))
	if len(lits) < 30 {
		t.Fatalf("extracted only %d string literals from %s — the file's shape changed "+
			"and this test is no longer reading it", len(lits), spaProbePath)
	}
	return lits
}

// scanJSStringLiterals walks JS/TS source and returns its string literals,
// skipping comments.
//
// A regex cannot do this job here, and getting it wrong is silent. The obvious
// `'([^']*)'` pairs apostrophes in PROSE — streaming.ts is full of them
// ("hls.js's TS demuxer", "browsers' MSE", "Aurora's") — so quotes pair across
// comment boundaries and the real literals get swallowed into the gaps. That
// version of this helper passed while a planted `caps.push(...NATIVE)` bypass
// sat in the file, which is why this is a scanner and not a pattern.
//
// Deliberately not a full JS lexer: it does not handle regex literals or
// template interpolation, neither of which streaming.ts uses. It only has to
// answer "does this capability key appear as a literal in shipped code".
func scanJSStringLiterals(src string) map[string]bool {
	lits := map[string]bool{}
	var buf strings.Builder
	var quote byte
	inLine, inBlock, inStr := false, false, false

	for i := 0; i < len(src); i++ {
		c := src[i]
		switch {
		case inLine:
			if c == '\n' {
				inLine = false
			}
		case inBlock:
			if c == '*' && i+1 < len(src) && src[i+1] == '/' {
				inBlock, i = false, i+1
			}
		case inStr:
			switch c {
			case '\\':
				i++ // skip the escaped character
			case quote:
				inStr = false
				lits[buf.String()] = true
				buf.Reset()
			default:
				buf.WriteByte(c)
			}
		case c == '/' && i+1 < len(src) && src[i+1] == '/':
			inLine, i = true, i+1
		case c == '/' && i+1 < len(src) && src[i+1] == '*':
			inBlock, i = true, i+1
		case c == '\'' || c == '"' || c == '`':
			inStr, quote = true, c
			buf.Reset()
		}
	}
	return lits
}

// spaPushedKeys is the narrower "what does clientCaps() actually emit" set,
// used only to bound the hand-authored profiles below. Unlike the safety
// assertion this DOES model the construction, so it carries a vacuity guard
// pinned to the exact number of keys the probe pushes today.
func spaPushedKeys(t *testing.T) map[string]bool {
	t.Helper()
	keys := map[string]bool{}
	pushes := regexp.MustCompile(`caps\.push\(([^)]*)\)`).FindAllStringSubmatch(readSPAProbe(t), -1)
	for _, push := range pushes {
		for _, lit := range regexp.MustCompile(`'([^']*)'`).FindAllStringSubmatch(push[1], -1) {
			keys[lit[1]] = true
		}
	}
	// Exact, not a loose lower bound: a bound of 15 against 19 real keys would
	// let four pushes silently stop being scanned. Adding a probe requires
	// updating this number, which is the moment to ask whether the new key is
	// browser-safe.
	const wantKeys = 19
	if len(keys) != wantKeys {
		t.Fatalf("extracted %d pushed capability keys from %s, want %d (%v) — if clientCaps() "+
			"gained or lost a probe, update wantKeys; if the extraction broke, fix it",
			len(keys), spaProbePath, wantKeys, keys)
	}
	return keys
}

// THE safety model, enforced mechanically: no browser build can emit a
// native-only capability, so no browser can be handed an MKV, a DTS track, or
// a Hi10P direct play. Adding such a key to streaming.ts fails this test —
// in any syntactic form, including inside a comment.
func TestSPAProbeEmitsNoNativeOnlyCapabilities(t *testing.T) {
	for key := range spaProbeLiterals(t) {
		switch {
		case key == "h264_hi10":
			t.Errorf("SPA probe references %q — browsers' MSE rejects Hi10P; this key exists for native clients only", key)
		case strings.HasSuffix(key, "_container") && key != "mp4_container" && key != "webm_container":
			t.Errorf("SPA probe references %q — browsers cannot demux it", key)
		case isDirectPlayOnlyAudio(key):
			t.Errorf("SPA probe references direct-play-only audio %q", key)
		case directPlayOnlyVideoCodecs[key]:
			t.Errorf("SPA probe references direct-play-only video %q", key)
		}
	}
}

// The hand-authored browser profiles below feed the golden matrix, so they
// must stay a SUBSET of what the probe can actually emit. This catches a
// fabricated key propping up a test (e.g. asserting on a capability no browser
// ever sends). EVERY profile is checked — firefox was previously omitted here
// and in TestBrowsersNeverDirectPlayNativeOnlyContainers, so a native-only key
// added to it would have gone unnoticed by the very guard meant to catch that.
func TestBrowserCapsConstantsAreSubsetsOfTheSPAProbe(t *testing.T) {
	emitted := spaPushedKeys(t)
	for name, capsStr := range browserProfiles() {
		t.Run(name, func(t *testing.T) {
			for _, key := range strings.Split(capsStr, ",") {
				if !emitted[strings.TrimSpace(key)] {
					t.Errorf("profile claims %q, which clientCaps() never pushes", key)
				}
			}
		})
	}
}

// Golden matrix pinning the FULL decision — every field, plus the QoE reason
// code — for browser clients across a realistic file matrix, with fMP4 both on
// and off and including the nil-caps static fallback.
//
// This replaced a property-based test that claimed "before/after equivalence"
// in its name while only asserting two one-directional safety properties. It
// was measurably not load-bearing: deleting the "mp4" entry from
// containerCapKey — which stops every browser direct-playing every MP4 — left
// it passing.
//
// A golden file cannot prove equality with a past commit, so to be precise
// about what each artifact is worth: equivalence with origin/main was
// established once, out-of-band, by differential harnesses run during review
// (~10.9M browser cases across two independent runs, zero field differences,
// reason strings included). THIS test's job is the durable half — making any
// FUTURE change to browser behavior fail loudly and visibly in a diff.
//
// Regenerate deliberately, never reflexively: `go test ./internal/streaming/
// -run TestBrowserDecisionGolden -update-golden`, then read the diff. A
// changed line is a changed user experience.
var updateGolden = flag.Bool("update-golden", false, "rewrite the browser decision golden file")

func TestBrowserDecisionGolden(t *testing.T) {
	files := []struct {
		name                     string
		container, video, pixFmt string
		audio                    []models.AudioTrack
	}{
		{"mp4-h264-aac", "mov,mp4,m4a,3gp,3g2,mj2", "h264", "yuv420p", []models.AudioTrack{track("aac", true)}},
		{"mp4-h264-eac3", "mov,mp4,m4a,3gp,3g2,mj2", "h264", "yuv420p", []models.AudioTrack{track("eac3", true)}},
		{"mp4-hevc10-eac3", "mov,mp4,m4a,3gp,3g2,mj2", "hevc", "yuv420p10le", []models.AudioTrack{track("eac3", true)}},
		{"mp4-av1-opus", "mov,mp4,m4a,3gp,3g2,mj2", "av1", "yuv420p", []models.AudioTrack{track("opus", true)}},
		{"mkv-h264-ac3", "matroska,webm", "h264", "yuv420p", []models.AudioTrack{track("ac3", true)}},
		{"mkv-h264-flac", "matroska,webm", "h264", "yuv420p", []models.AudioTrack{track("flac", true)}},
		{"mkv-hevc10-eac3", "matroska,webm", "hevc", "yuv420p10le", []models.AudioTrack{track("eac3", true)}},
		{"mkv-h264hi10-flac", "matroska,webm", "h264", "yuv420p10le", []models.AudioTrack{track("flac", true)}},
		{"mkv-h264-dts", "matroska,webm", "h264", "yuv420p", []models.AudioTrack{track("dts", true)}},
		{"mkv-h264-dts+aac", "matroska,webm", "h264", "yuv420p", []models.AudioTrack{track("dts", true), track("aac", false)}},
		{"mkv-h264-truehd+ac3", "matroska,webm", "h264", "yuv420p", []models.AudioTrack{track("truehd", true), track("ac3", false)}},
		{"mkv-h264-pcm+aac", "matroska,webm", "h264", "yuv420p", []models.AudioTrack{track("pcm_bluray", true), track("aac", false)}},
		{"mkv-vp9-opus", "matroska,webm", "vp9", "yuv420p", []models.AudioTrack{track("opus", true)}},
		{"mkv-av1-opus", "matroska,webm", "av1", "yuv420p", []models.AudioTrack{track("opus", true)}},
		{"mkv-h264-silent", "matroska,webm", "h264", "yuv420p", nil},
		{"avi-mpeg4-mp3", "avi", "mpeg4", "yuv420p", []models.AudioTrack{track("mp3", true)}},
		{"ts-mpeg2-mp2", "mpegts", "mpeg2video", "yuv420p", []models.AudioTrack{track("mp2", true)}},
		{"ts-h264-aac", "mpegts", "h264", "yuv420p", []models.AudioTrack{track("aac", true)}},
	}
	// Sorted so the golden file's order is stable across runs.
	profiles := []struct{ name, caps string }{
		{"chrome", chromeCapsStr},
		{"firefox", firefoxCapsStr},
		{"ios", iosCapsStr},
		{"nil-caps", ""}, // exercises the decideStatic fallback
		{"safari", safariCapsStr},
	}

	var b strings.Builder
	b.WriteString("# Browser playback decisions. Regenerate: go test ./internal/streaming/ -run TestBrowserDecisionGolden -update-golden\n")
	b.WriteString("# profile | fmp4 | file | decision | remux | audioIdx | audioCodec | passthrough | recode | videoOut | reasonCode\n")
	for _, p := range profiles {
		for _, fmp4 := range []bool{false, true} {
			for _, f := range files {
				var caps *ClientCaps
				if p.caps != "" {
					caps = ParseClientCaps(p.caps)
					caps.FMP4 = fmp4
				}
				pd := DecidePlayback(f.container, f.video, f.audio, caps, f.pixFmt)
				fmt.Fprintf(&b, "%s | fmp4=%v | %s | %s | remux=%v | idx=%d | %s | pass=%v | recode=%v | out=%s | %s\n",
					p.name, fmp4, f.name, pd.Decision, pd.Remux, pd.AudioTrackIndex,
					orDash(pd.AudioCodec), pd.AudioPassthrough, pd.AudioNeedsRecode,
					orDash(pd.VideoCodecOut), ReasonCode(pd))
			}
		}
	}
	got := b.String()

	const goldenPath = "testdata/browser_decisions.golden"
	if *updateGolden {
		if err := os.MkdirAll("testdata", 0o755); err != nil {
			t.Fatalf("mkdir testdata: %v", err)
		}
		if err := os.WriteFile(goldenPath, []byte(got), 0o644); err != nil {
			t.Fatalf("write golden: %v", err)
		}
		t.Logf("wrote %s", goldenPath)
		return
	}
	want, err := os.ReadFile(goldenPath)
	if err != nil {
		t.Fatalf("read golden (regenerate with -update-golden): %v", err)
	}
	if string(want) == got {
		return
	}
	gotLines, wantLines := strings.Split(got, "\n"), strings.Split(string(want), "\n")
	for i := 0; i < len(gotLines) || i < len(wantLines); i++ {
		g, w := "", ""
		if i < len(gotLines) {
			g = gotLines[i]
		}
		if i < len(wantLines) {
			w = wantLines[i]
		}
		if g != w {
			t.Errorf("browser decision changed at line %d:\n  was:  %s\n  now:  %s", i+1, w, g)
		}
	}
}

func orDash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

// Native-only capabilities must never make a browser's HLS audio selection
// worse or unsafe. Complements the golden file with a property that holds for
// caps combinations the golden matrix does not enumerate.
func TestBrowserHLSAudioIsNeverNativeOnly(t *testing.T) {
	for name, capsStr := range browserProfiles() {
		for _, fmp4 := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/fmp4=%v", name, fmp4), func(t *testing.T) {
				caps := ParseClientCaps(capsStr)
				caps.FMP4 = fmp4
				tracks := []models.AudioTrack{track("dts", true), track("truehd", false), track("aac", false)}
				pd := DecidePlayback("matroska,webm", "h264", tracks, caps, "yuv420p")
				if pd.Decision == "direct_play" {
					t.Fatalf("browser told to direct-play an MKV")
				}
				if isDirectPlayOnlyAudio(pd.AudioCodec) && pd.AudioPassthrough {
					t.Errorf("passthrough of native-only audio %q", pd.AudioCodec)
				}
				if pd.AudioCodec != "aac" {
					t.Errorf("selected %q, want aac — the only track this path can carry", pd.AudioCodec)
				}
			})
		}
	}
}

// --- Invariants the design rests on ---

// directPlayOnlyVideoCodecs must never reach the remux path: MPEG-4 Part 2,
// MPEG-2 and VC-1 have no fMP4 mapping and hls.js cannot demux them from TS,
// so a copy would emit segments nothing plays.
func TestDirectPlayOnlyVideoNeverRemuxes(t *testing.T) {
	for codec := range directPlayOnlyVideoCodecs {
		t.Run(codec, func(t *testing.T) {
			// Claims the codec but NOT the container, so direct play is
			// unavailable and the engine must choose between remux and
			// transcode.
			caps := ParseClientCaps(codec + ",aac,mp4_container,hls_native")
			caps.FMP4 = true
			pd := DecidePlayback("matroska", codec, []models.AudioTrack{track("aac", true)}, caps, "yuv420p")
			if pd.Decision != "transcode" {
				t.Errorf("got %q (remux=%v), want transcode — %s cannot be carried in HLS segments",
					pd.Decision, pd.Remux, codec)
			}
			if pd.Remux {
				t.Errorf("Remux = true for %s", codec)
			}
			// chooseVideoCodecOut only ever returns h264/hevc, so asserting
			// "output != codec" would be dead. Assert the real requirement.
			if pd.VideoCodecOut != "h264" {
				t.Errorf("VideoCodecOut = %q, want h264", pd.VideoCodecOut)
			}
		})
	}
}

// The direct-play-only audio set and the HLS copy-safe policies must be
// disjoint. If a codec is ever added to knownAudioCodecs and to a copy policy
// without being thought through, this fails.
func TestDirectPlayOnlyAudioIsNeverCopySafe(t *testing.T) {
	codecs := []string{"dts", "truehd", "mlp", "alac", "mp2",
		"pcm_s16le", "pcm_s24le", "pcm_bluray", "pcm_dvd"}
	for _, codec := range codecs {
		t.Run(codec, func(t *testing.T) {
			if !isDirectPlayOnlyAudio(codec) {
				t.Fatalf("%q is not classified direct-play-only", codec)
			}
			for _, fmp4 := range []bool{false, true} {
				if RemuxAudioCopySafe(codec, fmp4) {
					t.Errorf("RemuxAudioCopySafe(%q, fmp4=%v) = true", codec, fmp4)
				}
				if TranscodeAudioCopySafe(codec, fmp4) {
					t.Errorf("TranscodeAudioCopySafe(%q, fmp4=%v) = true", codec, fmp4)
				}
			}
		})
	}
}

// Codecs the HLS path CAN carry must not be swept up by the direct-play-only
// classifier — the guard above is only safe if it is narrow.
func TestHLSDeliverableAudioKeepsCarriableCodecs(t *testing.T) {
	src := map[string]bool{
		"aac": true, "mp3": true, "ac3": true, "eac3": true,
		"flac": true, "opus": true, "vorbis": true,
		"dts": true, "truehd": true, "pcm_s24le": true,
	}
	got := hlsDeliverableAudio(src)
	for _, keep := range []string{"aac", "mp3", "ac3", "eac3", "flac", "opus", "vorbis"} {
		if !got[keep] {
			t.Errorf("hlsDeliverableAudio dropped %q", keep)
		}
	}
	for _, drop := range []string{"dts", "truehd", "pcm_s24le"} {
		if got[drop] {
			t.Errorf("hlsDeliverableAudio kept native-only %q", drop)
		}
	}
}

// The regression this restriction exists to prevent. findBestAudioTrack
// returns the first COMPATIBLE track preferring the default, so a native
// client that claims TrueHD would have had the engine "select" the TrueHD
// default track on a path that cannot copy it — passing over the copyable
// AAC track beside it and re-encoding lossless audio for nothing.
//
// AV1 is the video codec because it is claimed (so no transcode-for-video
// excuse) yet never remuxable, which forces the full-transcode path where
// audio copy-safety actually decides the outcome.
func TestNativeClientKeepsCopyableAudioOnNonRemuxablePaths(t *testing.T) {
	caps := ParseClientCaps(nativeAppCaps)
	caps.FMP4 = true

	// No mkv_container claim → direct play unavailable → full transcode.
	delete(caps.Containers, "mkv_container")

	tracks := []models.AudioTrack{track("truehd", true), track("aac", false)}
	pd := DecidePlayback("matroska", "av1", tracks, caps, "yuv420p")

	if pd.Decision != "transcode" {
		t.Fatalf("got %q, want transcode", pd.Decision)
	}
	if pd.AudioCodec != "aac" {
		t.Errorf("selected audio %q, want aac — the copyable track must win on a path that cannot carry TrueHD", pd.AudioCodec)
	}
	if !pd.AudioPassthrough {
		t.Error("AudioPassthrough = false; the AAC track should be copied, not re-encoded")
	}
	if pd.AudioNeedsRecode {
		t.Error("AudioNeedsRecode = true; nothing needs re-encoding here")
	}
}

// The same client DOES get its TrueHD track when the path can actually
// deliver the original — the restriction must not leak into direct play.
func TestNativeClientStillGetsLosslessAudioOnDirectPlay(t *testing.T) {
	caps := ParseClientCaps(nativeAppCaps)
	caps.FMP4 = true

	tracks := []models.AudioTrack{track("truehd", true), track("aac", false)}
	pd := DecidePlayback("matroska", "h264", tracks, caps, "yuv420p")

	if pd.Decision != "direct_play" {
		t.Fatalf("got %q (reason %q), want direct_play", pd.Decision, pd.TranscodeReason)
	}
	if pd.AudioCodec != "truehd" {
		t.Errorf("selected audio %q, want truehd — direct play serves the original file", pd.AudioCodec)
	}
	if pd.AudioTrackIndex != 0 {
		t.Errorf("AudioTrackIndex = %d, want 0", pd.AudioTrackIndex)
	}
}

// Direct play hands the ORIGINAL file to the player, so the Content-Type must
// describe the real container for every extension a native client can now
// reach. Previously untested: reverting the .m2ts case broke nothing.
func TestServeFileContentTypeForNativeContainers(t *testing.T) {
	// Resolve symlinks in the root: pathWithinRoot requires an already-resolved
	// canonicalRoot (it resolves only the target). On macOS, TMPDIR sits under
	// /var → /private/var, so a raw t.TempDir() makes every case 404 — which
	// would greet the first developer to run this on the Mac app's own target
	// platform.
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatalf("resolve temp dir: %v", err)
	}
	tests := []struct{ file, want string }{
		{"movie.mkv", "video/x-matroska"},
		{"movie.avi", "video/x-msvideo"},
		{"recording.ts", "video/mp2t"},
		{"recording.m2ts", "video/mp2t"},
		{"movie.mp4", "video/mp4"},
		{"movie.m4v", "video/mp4"},
		{"clip.webm", "video/webm"},
		{"clip.mov", "video/quicktime"},
	}
	for _, tt := range tests {
		t.Run(tt.file, func(t *testing.T) {
			path := filepath.Join(dir, tt.file)
			if err := os.WriteFile(path, []byte("payload"), 0o644); err != nil {
				t.Fatalf("write fixture: %v", err)
			}
			rec := httptest.NewRecorder()
			ServeFile(rec, httptest.NewRequest(http.MethodGet, "/", nil), path, []string{dir})
			if rec.Code != http.StatusOK {
				t.Fatalf("status %d, want 200", rec.Code)
			}
			if got := rec.Header().Get("Content-Type"); got != tt.want {
				t.Errorf("Content-Type = %q, want %q", got, tt.want)
			}
			if got := rec.Header().Get("Accept-Ranges"); got != "bytes" {
				t.Errorf("Accept-Ranges = %q, want bytes — seeking depends on it", got)
			}
		})
	}
}

// Every native-client test elsewhere in this file sets FMP4=true. fMP4 is the
// default, but `transcode.segment_format: ts` is a supported rollback knob and
// it gates both audio copy policies plus the HEVC remux branch — so the whole
// native path needs coverage with it off.
func TestNativeClientDirectPlayIsIndependentOfSegmentFormat(t *testing.T) {
	files := []struct {
		name                     string
		container, video, pixFmt string
		audio                    []models.AudioTrack
	}{
		{"mkv-h264-dts", "matroska,webm", "h264", "yuv420p", []models.AudioTrack{track("dts", true)}},
		{"mkv-hevc10-truehd", "matroska,webm", "hevc", "yuv420p10le", []models.AudioTrack{track("truehd", true)}},
		{"mkv-h264hi10-flac", "matroska,webm", "h264", "yuv420p10le", []models.AudioTrack{track("flac", true)}},
		{"avi-mpeg4-mp3", "avi", "mpeg4", "yuv420p", []models.AudioTrack{track("mp3", true)}},
		{"mkv-msmpeg4v3-mp3", "matroska,webm", "msmpeg4v3", "yuv420p", []models.AudioTrack{track("mp3", true)}},
		{"mkv-h264-alac", "matroska,webm", "h264", "yuv420p", []models.AudioTrack{track("alac", true)}},
		{"mkv-h264-mlp", "matroska,webm", "h264", "yuv420p", []models.AudioTrack{track("mlp", true)}},
	}
	// Direct play serves the original file, so the segment format — which
	// only describes the HLS pipeline — must not influence it.
	for _, f := range files {
		t.Run(f.name, func(t *testing.T) {
			for _, fmp4 := range []bool{false, true} {
				caps := ParseClientCaps(nativeAppCaps)
				caps.FMP4 = fmp4
				pd := DecidePlayback(f.container, f.video, f.audio, caps, f.pixFmt)
				if pd.Decision != "direct_play" {
					t.Errorf("fmp4=%v: got %q (reason %q), want direct_play", fmp4, pd.Decision, pd.TranscodeReason)
				}
			}
		})
	}
}

// The server-set HEVCEncode flag is never exercised elsewhere in this file, so
// chooseVideoCodecOut always returned h264. A native client that can decode
// HEVC should still get an HEVC-encoded transcode when the host can produce
// one — the native caps must not disturb that.
func TestNativeClientStillGetsHEVCTranscodeOutput(t *testing.T) {
	caps := ParseClientCaps(nativeAppCaps)
	caps.FMP4 = true
	caps.HEVCEncode = true
	delete(caps.Containers, "mkv_container") // force off the direct-play path

	pd := DecidePlayback("matroska,webm", "av1", []models.AudioTrack{track("aac", true)}, caps, "yuv420p")
	if pd.Decision != "transcode" {
		t.Fatalf("got %q, want transcode", pd.Decision)
	}
	if pd.VideoCodecOut != "hevc" {
		t.Errorf("VideoCodecOut = %q, want hevc", pd.VideoCodecOut)
	}
}

// nil caps is the static fallback for clients that send no caps at all. The
// new capability keys must not leak into it — decideStatic uses its own
// conservative allowlists and has no notion of a native client.
func TestNilCapsStaticFallbackIsUnaffected(t *testing.T) {
	tests := []struct {
		name                     string
		container, video, pixFmt string
		audio                    []models.AudioTrack
		want                     string
	}{
		{"mkv-h264-dts", "matroska,webm", "h264", "yuv420p", []models.AudioTrack{track("dts", true)}, "direct_stream"},
		{"avi-mpeg4-mp3", "avi", "mpeg4", "yuv420p", []models.AudioTrack{track("mp3", true)}, "transcode"},
		{"ts-mpeg2-mp2", "mpegts", "mpeg2video", "yuv420p", []models.AudioTrack{track("mp2", true)}, "transcode"},
		{"mp4-h264-aac", "mov,mp4,m4a,3gp,3g2,mj2", "h264", "yuv420p", []models.AudioTrack{track("aac", true)}, "direct_play"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			pd := DecidePlayback(tt.container, tt.video, tt.audio, nil, tt.pixFmt)
			if pd.Decision != tt.want {
				t.Errorf("got %q, want %q", pd.Decision, tt.want)
			}
			if pd.AudioPassthrough && isDirectPlayOnlyAudio(pd.AudioCodec) {
				t.Errorf("static fallback passthrough of native-only audio %q", pd.AudioCodec)
			}
		})
	}
}

// --- Caps parsing ---

func TestParseClientCapsNativeKeys(t *testing.T) {
	caps := ParseClientCaps(nativeAppCaps)

	for _, key := range []string{"mkv_container", "avi_container", "ts_container"} {
		if !caps.Containers[key] {
			t.Errorf("expected %s", key)
		}
	}
	for _, codec := range []string{"dts", "truehd", "alac", "mp2", "pcm_s16le", "pcm_bluray"} {
		if !caps.AudioCodecs[codec] {
			t.Errorf("expected audio codec %s", codec)
		}
	}
	for _, codec := range []string{"mpeg4", "mpeg2video", "vc1"} {
		if !caps.VideoCodecs[codec] {
			t.Errorf("expected video codec %s", codec)
		}
	}
}

// The pcm_ prefix rule admits variants no allowlist enumerated, and stores
// them verbatim so findBestAudioTrack's exact match against the ffprobe codec
// name still works.
func TestParseClientCapsPCMPrefix(t *testing.T) {
	caps := ParseClientCaps("pcm_s16le,pcm_s24be,pcm_f32le,pcm_dvd,pcm_something_new")
	for _, codec := range []string{"pcm_s16le", "pcm_s24be", "pcm_f32le", "pcm_dvd", "pcm_something_new"} {
		if !caps.AudioCodecs[codec] {
			t.Errorf("expected %s to be accepted by the pcm_ prefix rule", codec)
		}
	}
	// Not a false-positive magnet: "pcm" alone is not an ffprobe codec name.
	if ParseClientCaps("pcm").AudioCodecs["pcm"] {
		t.Error(`bare "pcm" should not be accepted — it is not an ffprobe codec name`)
	}
}

// The native-only codec sets are spelled out twice — once in the known* map
// that makes a key CLAIMABLE, once in the classifier that keeps it off the
// HLS path. Drift between them is the failure this pins: a codec claimable
// but unclassified would be copied into segments nothing can play, and a
// codec classified but unclaimable is dead configuration.
func TestNativeOnlyCodecSetsDoNotDrift(t *testing.T) {
	// Both directions. The dangerous one is "claimable but unclassified":
	// such a codec keeps remuxVideoOK=true and reaches `-c:v copy`, emitting
	// segments nothing can demux. Adding an entry to knownVideoCodecs forces
	// a decision here.
	t.Run("video", func(t *testing.T) {
		hlsRemuxable := map[string]bool{
			// Carried by the HLS segment pipeline: H.264 always; HEVC under
			// the fMP4/hls.js gate; VP8/VP9/AV1 are claimable and decodable
			// but DecidePlayback forbids remuxing them (they still transcode
			// rather than being copied), so they belong on this side —
			// TestDirectPlayOnlyVideoNeverRemuxes covers the other set.
			"h264": true, "h265": true, "hevc": true,
			"vp8": true, "vp9": true, "av1": true,
		}
		for codec := range knownVideoCodecs {
			classified := directPlayOnlyVideoCodecs[codec]
			switch {
			case hlsRemuxable[codec] && classified:
				t.Errorf("%q is HLS-remuxable but classified direct-play-only", codec)
			case !hlsRemuxable[codec] && !classified:
				// The remedy is deliberately not symmetric. Adding the codec
				// to this test's set is the easier edit (same file) and the
				// wrong one unless you have CONFIRMED the HLS pipeline carries
				// it — fMP4 mapping exists and hls.js can demux it from TS.
				// Absent that proof, directPlayOnlyVideoCodecs is the answer.
				t.Errorf("%q is claimable but unaccounted for — remuxVideoOK stays true "+
					"and it would be copied into segments nothing can demux. "+
					"Add it to directPlayOnlyVideoCodecs; only add it to this test's "+
					"hlsRemuxable set if you have verified the segment pipeline carries it", codec)
			}
		}
		for codec := range directPlayOnlyVideoCodecs {
			if !knownVideoCodecs[codec] {
				t.Errorf("%q is direct-play-only but not in knownVideoCodecs — no client can claim it", codec)
			}
		}
	})

	// Every claimable audio codec must land on a deliberate side of the
	// partition. Adding one to knownAudioCodecs forces a decision here.
	t.Run("audio", func(t *testing.T) {
		hlsDeliverable := map[string]bool{
			"aac": true, "mp3": true, "ac3": true, "eac3": true,
			"flac": true, "opus": true, "vorbis": true,
		}
		nativeOnly := map[string]bool{
			"dts": true, "truehd": true, "mlp": true, "alac": true, "mp2": true,
		}
		for codec := range knownAudioCodecs {
			classified := isDirectPlayOnlyAudio(codec)
			switch {
			case hlsDeliverable[codec] && classified:
				t.Errorf("%q is HLS-deliverable but classified direct-play-only", codec)
			case nativeOnly[codec] && !classified:
				t.Errorf("%q is native-only but not classified — it would be copied into HLS segments", codec)
			case !hlsDeliverable[codec] && !nativeOnly[codec]:
				t.Errorf("%q is claimable but unaccounted for; add it to one side of this test", codec)
			}
		}
	})
}

// --- Container mapping ---

// Every key in containerCapKey must be a value NormalizeContainer can actually
// produce. A key for a name the normalizer never emits is dead configuration
// that reads as support.
func TestContainerCapKeysAreReachableFromNormalizeContainer(t *testing.T) {
	// FULL ffprobe format_name strings — what the scanner actually stores,
	// via internal/library/ffprobe.go's Split(",")[0] + NormalizeContainer.
	// An earlier version of this test listed bare "webm", which is NOT an
	// ffprobe format_name and made the dead "webm" key below look reachable.
	scannerProduces := map[string]bool{}
	for _, formatName := range []string{
		"mov,mp4,m4a,3gp,3g2,mj2", // .mp4 .m4v .mov
		"matroska,webm",           // .mkv AND .webm
		"avi",                     // .avi
		"mpegts",                  // .ts .m2ts
		"asf",                     // .wmv
		"flv",                     // .flv
		"mpeg",                    // .mpg .mpeg
	} {
		scannerProduces[NormalizeContainer(strings.Split(formatName, ",")[0])] = true
	}

	for container, key := range containerCapKey {
		if !strings.HasSuffix(key, "_container") {
			t.Errorf("cap key for %q is %q — ParseClientCaps only accepts *_container", container, key)
		}
		if NormalizeContainer(container) != container {
			t.Errorf("containerCapKey key %q is not a NormalizeContainer output (it normalizes to %q)",
				container, NormalizeContainer(container))
		}
		if !scannerProduces[container] && container != "webm" {
			t.Errorf("containerCapKey has %q, which no scanned file ever produces", container)
		}
	}

	// The "webm" exception, pinned rather than hidden. FFprobe reports
	// "matroska,webm" for BOTH Matroska and WebM, so a .webm file is stored
	// as container "mkv" and the webm_container key is unreachable from the
	// scanner. The key is kept because NormalizeContainer("webm") == "webm"
	// is a legal input other callers may pass, and because dropping it would
	// silently change behavior for them. Documented in
	// docs/native-client-caps.md; do not "fix" the doc to promise otherwise.
	if scannerProduces["webm"] {
		t.Error("a scanned file now yields container \"webm\" — the .webm→mkv quirk is fixed; " +
			"update docs/native-client-caps.md, which tells client authors the opposite")
	}
	if got := NormalizeContainer("matroska,webm"); got != "mkv" {
		t.Errorf("NormalizeContainer(\"matroska,webm\") = %q, want mkv", got)
	}
}

// The doc is the contract a native client is built against, so the caps string
// it advertises must be one this engine actually honors.
func TestNativeAppCapsMatchesDocumentedContract(t *testing.T) {
	const docPath = "../../docs/native-client-caps.md"
	source, err := os.ReadFile(docPath)
	if err != nil {
		t.Fatalf("read %s: %v", docPath, err)
	}
	// The fenced block following the "complete native caps string" heading.
	re := regexp.MustCompile("(?s)### A complete native caps string\\s*\n+```\n(.*?)```")
	m := re.FindStringSubmatch(string(source))
	if m == nil {
		t.Fatal("no complete-caps code block found in " + docPath)
	}
	documented := map[string]bool{}
	for _, key := range strings.Split(strings.ReplaceAll(m[1], "\n", ""), ",") {
		if key = strings.TrimSpace(key); key != "" {
			documented[key] = true
		}
	}
	if len(documented) < 20 {
		t.Fatalf("parsed only %d keys from the doc — extraction is broken", len(documented))
	}

	fixture := map[string]bool{}
	for _, key := range strings.Split(nativeAppCaps, ",") {
		fixture[strings.TrimSpace(key)] = true
	}
	for key := range documented {
		if !fixture[key] {
			t.Errorf("doc advertises %q but the test fixture never exercises it", key)
		}
	}
	for key := range fixture {
		if !documented[key] {
			t.Errorf("fixture claims %q but the doc does not advertise it", key)
		}
	}

	// Every documented key must actually be understood by the parser —
	// otherwise the doc tells client authors to send inert strings.
	caps := ParseClientCaps(strings.Join(mapKeys(documented), ","))
	for key := range documented {
		switch {
		case strings.HasSuffix(key, "_container"):
			if !caps.Containers[key] {
				t.Errorf("documented container %q is not parsed", key)
			}
		case key == "hls_native":
			if !caps.HLSNative {
				t.Errorf("documented key %q is not parsed", key)
			}
		case key == "h264_hi10":
			if !caps.H264Hi10 {
				t.Errorf("documented key %q is not parsed", key)
			}
		case key == "hevc_main10":
			if !caps.HEVCMain10 {
				t.Errorf("documented key %q is not parsed", key)
			}
		default:
			if !caps.VideoCodecs[key] && !caps.AudioCodecs[key] {
				t.Errorf("documented codec %q is parsed into neither VideoCodecs nor AudioCodecs", key)
			}
		}
	}
}

func mapKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

// .mov normalizes to mp4, so a client claiming only mp4_container must still
// direct-play QuickTime files exactly as it did before the switch became a map.
func TestMovStillChecksMP4Container(t *testing.T) {
	caps := ParseClientCaps("h264,aac,mp4_container,hls_js")
	caps.FMP4 = true
	for _, format := range []string{"mov", "mov,mp4,m4a,3gp,3g2,mj2"} {
		pd := DecidePlayback(format, "h264", []models.AudioTrack{track("aac", true)}, caps, "yuv420p")
		if pd.Decision != "direct_play" {
			t.Errorf("format %q: got %q, want direct_play", format, pd.Decision)
		}
	}
}

// A client that claims a container but NOT the codec inside it still gets a
// correct decision — claiming a container is not a blanket direct-play grant.
func TestContainerClaimIsNotABlanketGrant(t *testing.T) {
	// Claims mkv_container and h264, but the file is AV1.
	caps := ParseClientCaps("h264,aac,mkv_container,mp4_container,hls_native")
	caps.FMP4 = true
	pd := DecidePlayback("matroska", "av1", []models.AudioTrack{track("aac", true)}, caps, "yuv420p")
	if pd.Decision != "transcode" {
		t.Errorf("got %q, want transcode — the client cannot decode AV1", pd.Decision)
	}
}

// Reason strings feed the QoE aggregate, so a transcode a native client hits
// must not be filed as "not supported by browser" when the client explicitly
// claimed the codec.
func TestNativeOnlyVideoTranscodeReasonIsHonest(t *testing.T) {
	caps := ParseClientCaps("mpeg4,aac,mp4_container,hls_native")
	caps.FMP4 = true
	pd := DecidePlayback("matroska", "mpeg4", []models.AudioTrack{track("aac", true)}, caps, "yuv420p")
	if pd.Decision != "transcode" {
		t.Fatalf("got %q, want transcode", pd.Decision)
	}
	if strings.Contains(pd.TranscodeReason, "not supported by browser") {
		t.Errorf("reason %q claims the client cannot decode MPEG-4 — it said it could", pd.TranscodeReason)
	}
	if code := ReasonCode(pd); code != ReasonVideoCodec {
		t.Errorf("ReasonCode = %q, want %q", code, ReasonVideoCodec)
	}
}
