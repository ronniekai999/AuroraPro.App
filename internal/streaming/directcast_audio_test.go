package streaming

import (
	"os"
	"strings"
	"testing"

	"github.com/aurora-media/aurora/internal/models"
)

// The SPA's Chromecast gate for DIRECT-PLAY titles (castDirectPlaySupported in
// static/redesign/app/src/lib/cast.ts, issue #503) decides whether a file can
// be handed to the Default Media Receiver as a progressive MP4. It reads
// `audio_codec_out` and it MUST: a receiver that cannot decode the audio does
// not report an error, it resolves loadMedia and then spins forever.
//
// That gate rests on an invariant this package owns and nothing else pins: for
// a direct_play decision, audio_codec_out is the codec of the track the
// receiver will actually START — the file's effective default. It holds
// because direct play requires dpIsDefault, so the engine's chosen track IS
// the effective default, and OutputAudioCodec reports a passthrough decision's
// own codec verbatim.
//
// The trap this guards is `audio_codec`, the neighbouring field: that is the
// FIRST audio stream's codec ("backward compat" in the scanner), which is a
// different track whenever stream 0 is not the flagged default. Reading it
// admitted an AAC-at-stream-0 / FLAC-default MP4 — a shape `ffmpeg -c copy`
// produces routinely — straight into the silent hang.
func TestDirectPlayAudioCodecOutIsTheDefaultTrack(t *testing.T) {
	// A browser that direct-plays FLAC in MP4 (Chrome does).
	caps := &ClientCaps{
		VideoCodecs: map[string]bool{"h264": true},
		AudioCodecs: map[string]bool{"aac": true, "flac": true, "mp3": true},
		Containers:  map[string]bool{"mp4_container": true},
		HLSJS:       true,
	}
	// Stream 0 is AAC and NOT the default; the flagged default is FLAC.
	tracks := []models.AudioTrack{
		{Index: 0, Codec: "aac", Channels: 2, IsDefault: false},
		{Index: 1, Codec: "flac", Channels: 2, IsDefault: true},
	}

	pd := DecidePlaybackFor(DecisionInput{
		Container:   "mp4",
		VideoCodec:  "h264",
		PixFmt:      "yuv420p",
		AudioTracks: tracks,
		Caps:        caps,
	})
	if pd.Decision != "direct_play" {
		t.Fatalf("decision = %q, want direct_play (this browser plays FLAC-in-MP4)", pd.Decision)
	}

	got := OutputAudioCodec(pd, caps, tracks[pd.AudioTrackIndex].Channels)
	if got != "flac" {
		t.Errorf("audio_codec_out = %q, want flac — it must name the track the "+
			"RECEIVER starts (the effective default), not stream 0", got)
	}
	// The field the gate must NOT read would have said "aac" here and let a
	// FLAC-default file through to the receiver.
	if first := tracks[0].Codec; got == first {
		t.Errorf("audio_codec_out collapsed onto the first track's codec %q; "+
			"the cast gate's whole premise is that these differ", first)
	}

	// The direct-play track is the effective default, which is what makes
	// audio_codec_out meaningful for a receiver at all.
	if want := effectiveDefaultIndex(tracks); pd.AudioTrackIndex != want {
		t.Errorf("direct play chose track %d, want the effective default %d",
			pd.AudioTrackIndex, want)
	}
}

// The other half of the invariant: a file whose default IS stream 0 must still
// report that track, and a decision carrying no audio codec at all falls back
// to a codec the receiver can decode rather than to "".
func TestDirectPlayAudioCodecOutOnOrdinaryAndSilentFiles(t *testing.T) {
	caps := &ClientCaps{
		VideoCodecs: map[string]bool{"h264": true},
		AudioCodecs: map[string]bool{"aac": true},
		Containers:  map[string]bool{"mp4_container": true},
		HLSJS:       true,
	}
	tracks := []models.AudioTrack{{Index: 0, Codec: "aac", Channels: 2, IsDefault: true}}

	pd := DecidePlaybackFor(DecisionInput{
		Container: "mp4", VideoCodec: "h264", PixFmt: "yuv420p",
		AudioTracks: tracks, Caps: caps,
	})
	if pd.Decision != "direct_play" {
		t.Fatalf("decision = %q, want direct_play", pd.Decision)
	}
	if got := OutputAudioCodec(pd, caps, 2); got != "aac" {
		t.Errorf("audio_codec_out = %q, want aac", got)
	}

	// A silent file: no audio tracks at all. The SPA gate refuses "" and
	// admits "aac", so this fallback is what lets a silent MP4 cast.
	silent := DecidePlaybackFor(DecisionInput{
		Container: "mp4", VideoCodec: "h264", PixFmt: "yuv420p",
		AudioTracks: nil, Caps: caps,
	})
	if got := OutputAudioCodec(silent, caps, 0); got == "" {
		t.Error("audio_codec_out for a silent file is empty; the cast gate " +
			"fails closed on that, so a silent MP4 would stop casting")
	}
}

// The invariant above is a SERVER fact, and the code that depends on it is one
// field name in TypeScript. Changing `audio_codec_out` to `audio_codec` at that
// single call site would hand a FLAC-default MP4 to the receiver and leave
// every Go test in this repo green — so this reads the SPA source, the same way
// TestSPAProbeEmitsNoNativeOnlyCapabilities does for the caps probe.
//
// Deliberately a text assertion rather than a model of how the player builds
// the probe: it is the field NAME that carries the risk, and a substring check
// cannot be fooled by a spread, a ternary or a rename of the local.
const directCastGateCallSite = "../../static/redesign/app/src/components/VideoPlayer.tsx"

func TestSPADirectCastGateReadsTheDefaultTrackCodec(t *testing.T) {
	src, err := os.ReadFile(directCastGateCallSite)
	if err != nil {
		t.Fatalf("read %s: %v", directCastGateCallSite, err)
	}
	body := string(src)

	// Locate the gate call and take the object literal it is given.
	const marker = "castDirectPlaySupported({"
	i := strings.Index(body, marker)
	if i < 0 {
		t.Fatalf("no castDirectPlaySupported({...}) call in %s — if the gate moved, "+
			"move this test with it rather than deleting it", directCastGateCallSite)
	}
	rest := body[i+len(marker):]
	end := strings.Index(rest, "})")
	if end < 0 {
		t.Fatalf("could not find the end of the castDirectPlaySupported call")
	}
	args := rest[:end]

	if !strings.Contains(args, "audio_codec_out") {
		t.Errorf("the Chromecast direct-play gate is not fed audio_codec_out.\n"+
			"It must be: audio_codec is the FIRST audio stream's codec, while the "+
			"receiver starts the flagged default, so an AAC-at-stream-0 / FLAC-default "+
			"MP4 passes the gate and then hangs the TV.\ngot: %s", args)
	}
	// `audio_codec_out` contains `audio_codec`, so check for the bare field as
	// a whole property value rather than as a substring.
	if strings.Contains(args, "stream.audio_codec,") || strings.Contains(args, "stream.audio_codec ") {
		t.Errorf("the gate reads the bare stream.audio_codec — see above.\ngot: %s", args)
	}
}
