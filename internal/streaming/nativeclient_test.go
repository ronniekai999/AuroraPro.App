package streaming

import (
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
// essentially every container and codec in a real library. Mirrors the
// contract documented in docs/native-client-caps.md.
const nativeAppCaps = "h264,h264_hi10,hevc,hevc_main10,vp8,vp9,av1,mpeg4,mpeg2video,vc1," +
	"aac,mp3,ac3,eac3,flac,opus,vorbis,dts,truehd,alac,mp2,pcm_s16le,pcm_bluray," +
	"mp4_container,webm_container,mkv_container,avi_container,ts_container,hls_native"

// browserCaps strings are what static/redesign/app/src/lib/streaming.ts
// actually emits. Note what is ABSENT: no mkv_container, no dts/truehd/pcm_*,
// no mpeg4/vc1. That absence is the entire safety argument for this change —
// every new capability is opt-in by naming it.
const (
	chromeCapsStr = "h264,vp8,vp9,av1,mp4_container,webm_container,aac,mp3,opus,vorbis,hls_js"
	safariCapsStr = "h264,hevc,h265,hevc_main10,mp4_container,aac,mp3,ac3,eac3,eac3_mse,flac,hls_js,hls_native"
	iosCapsStr    = "h264,hevc,h265,hevc_main10,mp4_container,aac,mp3,ac3,eac3,flac,hls_native"
)

func track(codec string, isDefault bool) models.AudioTrack {
	return models.AudioTrack{Codec: codec, IsDefault: isDefault}
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

// A browser must NEVER be handed an MKV to direct-play. This is the failure
// mode that would break every existing user, so it is asserted directly
// against the real caps strings the SPA emits rather than hand-built maps.
func TestBrowsersNeverDirectPlayNativeOnlyContainers(t *testing.T) {
	browsers := map[string]string{"chrome": chromeCapsStr, "safari": safariCapsStr, "ios": iosCapsStr}
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

// The SPA's probe can never emit a native-only capability. If someone adds a
// container/codec probe to streaming.ts, this test does not fail — but the
// constants above are copied from it, so it documents the coupling and fails
// the moment those constants are updated without thinking about this file.
func TestBrowserCapsStringsCarryNoNativeOnlyCapabilities(t *testing.T) {
	for name, capsStr := range map[string]string{"chrome": chromeCapsStr, "safari": safariCapsStr, "ios": iosCapsStr} {
		t.Run(name, func(t *testing.T) {
			caps := ParseClientCaps(capsStr)
			for container, key := range containerCapKey {
				if container == "mp4" || container == "webm" {
					continue
				}
				if caps.Containers[key] {
					t.Errorf("browser claims %q — the SPA probe must not emit it", key)
				}
			}
			for codec := range caps.AudioCodecs {
				if isDirectPlayOnlyAudio(codec) {
					t.Errorf("browser claims direct-play-only audio %q", codec)
				}
			}
			for codec := range caps.VideoCodecs {
				if directPlayOnlyVideoCodecs[codec] {
					t.Errorf("browser claims direct-play-only video %q", codec)
				}
			}
		})
	}
}

// Full before/after equivalence for browser clients: the decision engine's
// output for every browser × realistic-file combination must be what it was
// before native caps existed. Rather than snapshotting strings, this asserts
// the property that makes that true — browser decisions cannot depend on
// capabilities browsers do not have.
func TestBrowserDecisionsAreUnchangedByNativeCapabilities(t *testing.T) {
	files := []struct {
		container, video, pixFmt string
		audio                    []models.AudioTrack
	}{
		{"mp4", "h264", "yuv420p", []models.AudioTrack{track("aac", true)}},
		{"matroska", "h264", "yuv420p", []models.AudioTrack{track("ac3", true)}},
		{"matroska", "hevc", "yuv420p10le", []models.AudioTrack{track("eac3", true)}},
		{"matroska", "h264", "yuv420p", []models.AudioTrack{track("dts", true)}},
		{"matroska", "h264", "yuv420p", []models.AudioTrack{track("dts", true), track("aac", false)}},
		{"matroska", "h264", "yuv420p", []models.AudioTrack{track("truehd", true), track("ac3", false)}},
		{"mp4", "av1", "yuv420p", []models.AudioTrack{track("opus", true)}},
		{"avi", "mpeg4", "yuv420p", []models.AudioTrack{track("mp3", true)}},
		{"mpegts", "mpeg2video", "yuv420p", []models.AudioTrack{track("mp2", true)}},
	}

	for name, capsStr := range map[string]string{"chrome": chromeCapsStr, "safari": safariCapsStr, "ios": iosCapsStr} {
		for _, f := range files {
			t.Run(name+"/"+f.container+"-"+f.video, func(t *testing.T) {
				caps := ParseClientCaps(capsStr)
				caps.FMP4 = true
				pd := DecidePlayback(f.container, f.video, f.audio, caps, f.pixFmt)

				// A browser decision may only ever be direct_play for a
				// container+codec+audio combination it actually claimed.
				if pd.Decision == "direct_play" {
					nc := NormalizeContainer(f.container)
					if !caps.Containers[containerCapKey[nc]] {
						t.Fatalf("direct_play for unclaimed container %q", nc)
					}
				}
				// Whatever it decided, the audio it selected for an HLS path
				// must be one the HLS pipeline can carry or re-encode — never
				// a native-only codec presented as passthrough.
				if pd.AudioPassthrough && isDirectPlayOnlyAudio(pd.AudioCodec) {
					t.Fatalf("passthrough of native-only audio %q on %s", pd.AudioCodec, pd.Decision)
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
			if pd.VideoCodecOut == codec {
				t.Errorf("transcode output is %q — must re-encode to a deliverable codec", codec)
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
	t.Run("video", func(t *testing.T) {
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
	// ffprobe format_name first-elements for the extensions the scanner
	// ingests (internal/library/parser.go videoExtensions).
	probeFormats := []string{"mov", "mp4", "matroska", "webm", "avi", "mpegts", "asf", "flv", "mpeg"}
	reachable := map[string]bool{}
	for _, f := range probeFormats {
		reachable[NormalizeContainer(f)] = true
	}
	for container := range containerCapKey {
		if !reachable[container] {
			t.Errorf("containerCapKey has %q, which NormalizeContainer never produces", container)
		}
	}
	// And the key format must match what ParseClientCaps accepts.
	for container, key := range containerCapKey {
		if !strings.HasSuffix(key, "_container") {
			t.Errorf("cap key for %q is %q — ParseClientCaps only accepts *_container", container, key)
		}
	}
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
