package streaming

// September 2026 playback pass — the contained fixes that came out of the
// "what can we do better" review of the direct-play / remux / transcode code:
//
//   - `-readrate_initial_burst` behind a real 6.1 version gate;
//   - scale BEFORE the float tonemap chain;
//   - HEVC output gated to hardware encoders (libx265 opt-in), x265 CRF map;
//   - an explicit stereo downmix policy with a limiter;
//   - a client bitrate ceiling in the decision engine and the ladder;
//   - a preferred audio language in track selection.
//
// Argument tests live here; the ffmpeg-backed cases at the bottom run the
// real pipeline over the fixture corpus (mediafixture_test.go).

import (
	"strings"
	"testing"

	"github.com/aurora-media/aurora/internal/config"
	"github.com/aurora-media/aurora/internal/models"
)

// --- readrate initial burst ---

func TestFFmpegVersionMinor(t *testing.T) {
	for _, tt := range []struct {
		banner       string
		major, minor int
	}{
		{"ffmpeg version 6.1.1-3ubuntu5 Copyright (c) 2000-2023", 6, 1},
		{"ffmpeg version 6.0 Copyright", 6, 0},
		{"ffmpeg version 7.0.2-static https://johnvansickle.com/ffmpeg/", 7, 0},
		{"ffmpeg version n5.1.4 Copyright", 5, 1},
		{"ffmpeg version 5 Copyright", 5, 0}, // bare major
		{"ffmpeg version 10.12.3", 10, 12},
		{"ffmpeg version N-109983-g4d216654ca", 0, 0}, // git snapshot: unknown
		// Date-stamped snapshots have leading digits that are a YEAR. Reading
		// 2023 as a major would enable the burst flag on a build that may
		// predate it, and an unknown option is fatal at launch (review).
		{"ffmpeg version 2023-06-05-git-2f7f6e3a5e Copyright", 0, 0},
		{"ffmpeg version git-2020-03-04-e2eb04b Copyright", 0, 0},
		{"ffmpeg version 2024-01-01", 0, 0},
		{"ffmpeg version 6.1", 6, 1},
		// FFmpeg's version.sh falls back to the RELEASE file without git
		// metadata, and on master that file reads "N.N.git": a snapshot whose
		// digits name the release it PRECEDES (third review). The marker is
		// the delimited field right after the numeric version.
		{"ffmpeg version 6.1.git Copyright", 0, 0},
		{"ffmpeg version 7.1.git-20240902 Copyright", 0, 0},
		{"ffmpeg version n6.1-dev-1234-gabcdef Copyright", 0, 0},
		{"ffmpeg version 6.1.dev Copyright", 0, 0},
		// Vendor suffixes that merely contain the letters are releases; an
		// unknown here would cost them the readrate pacing too (fourth review).
		{"ffmpeg version 6.1.1-digital Copyright", 6, 1},
		{"ffmpeg version 7.1.1-full_build-www.gyan.dev Copyright", 7, 1},
		{"ffmpeg version 7.1.1-essentials_build-www.gyan.dev Copyright", 7, 1},
		{"ffmpeg version 6.0-devuan1 Copyright", 6, 0},
		{"ffmpeg version 7.1-legit Copyright", 7, 1},
		// A release-branch build described from its tag is a real release.
		{"ffmpeg version n7.0.2-6-g1234abc Copyright", 7, 0},
		{"garbage", 0, 0},
		{"", 0, 0},
	} {
		major, minor := ffmpegVersion(tt.banner)
		if major != tt.major || minor != tt.minor {
			t.Errorf("ffmpegVersion(%q) = (%d, %d), want (%d, %d)", tt.banner, major, minor, tt.major, tt.minor)
		}
	}
}

// TestReadrateInitialBurstGate pins the rule to the option's actual history:
// 6.0 rejects `-readrate_initial_burst` (a fatal argv error), 6.1 introduced
// it. A major-only gate would have killed every transcode on a 6.0 build.
func TestReadrateInitialBurstGate(t *testing.T) {
	for _, tt := range []struct {
		major, minor int
		want         bool
	}{
		{0, 0, false}, {4, 4, false}, {5, 1, false}, {6, 0, false},
		{6, 1, true}, {6, 2, true}, {7, 0, true}, {8, 0, true},
	} {
		if got := readrateInitialBurstSupported(tt.major, tt.minor); got != tt.want {
			t.Errorf("readrateInitialBurstSupported(%d, %d) = %v, want %v", tt.major, tt.minor, got, tt.want)
		}
	}
	if !readrateSupported(5) || readrateSupported(4) {
		t.Error("readrateSupported must be exactly >= 5")
	}
}

func TestInputPacingArgs(t *testing.T) {
	if got := inputPacingArgs(true, true, true); got != nil {
		t.Errorf("remux must never be paced, got %v", got)
	}
	if got := inputPacingArgs(false, false, true); got != nil {
		t.Errorf("no readrate support → no pacing flags at all, got %v", got)
	}
	got := inputPacingArgs(false, true, false)
	if strings.Join(got, " ") != "-readrate "+readRateFactor {
		t.Errorf("readrate without burst support = %v", got)
	}
	got = inputPacingArgs(false, true, true)
	if strings.Join(got, " ") != "-readrate "+readRateFactor+" -readrate_initial_burst "+readRateInitialBurstSec {
		t.Errorf("readrate with burst support = %v", got)
	}
}

// --- tonemap order ---

func TestInjectTonemapFilterScalesBeforeTonemapping(t *testing.T) {
	sw := HWAccelInfo{Type: HWAccelNone}
	args := injectTonemapFilter(sw.VideoEncoderArgs(1920, 1080, 0), 1920, 1080)
	vf := vfOf(t, args)
	if !strings.HasPrefix(vf, "scale=1920:-2,zscale=") {
		t.Errorf("CPU chain must scale first, then tonemap: %q", vf)
	}
	if !strings.HasSuffix(vf, "format=yuv420p") {
		t.Errorf("CPU chain must still end in 8-bit 4:2:0 for the encoder: %q", vf)
	}
	// "zscale=" contains "scale=", so count swscale passes with zscale masked.
	if strings.Count(strings.ReplaceAll(vf, "zscale=", ""), "scale=") != 1 {
		t.Errorf("exactly one swscale pass expected (the old trailing scale is gone): %q", vf)
	}

	va := HWAccelInfo{Type: HWAccelVAAPI, DevicePath: "/dev/dri/renderD128"}
	args = injectTonemapFilter(va.VideoEncoderArgs(1280, 720, 0), 1280, 720)
	vf = vfOf(t, args)
	if !strings.HasPrefix(vf, "scale=1280:-2,zscale=") {
		t.Errorf("VAAPI chain must scale on the CPU before tonemapping: %q", vf)
	}
	up := strings.Index(vf, "format=nv12,hwupload")
	tm := strings.Index(vf, "tonemap=")
	if up < 0 || tm < 0 || tm > up {
		t.Errorf("VAAPI chain must tonemap on CPU frames before hwupload: %q", vf)
	}
	if !strings.Contains(vf, "scale_vaapi=w=1280:h=-2") {
		t.Errorf("the GPU scale stays as a same-size pass: %q", vf)
	}
}

// The VAAPI HDR burn-in anchor ("format=nv12,hwupload" at a non-zero index)
// must survive the reorder: subtitles render on tonemapped SDR frames, after
// the CPU scale, before the upload.
func TestInjectTonemapFilterKeepsVAAPIBurnInAnchor(t *testing.T) {
	va := HWAccelInfo{Type: HWAccelVAAPI, DevicePath: "/dev/dri/renderD128"}
	args := injectTonemapFilter(va.VideoEncoderArgs(1920, 1080, 0), 1920, 1080)
	session := &TranscodeSession{FilePath: "/library/x.mkv", BurnSubIndex: 3, BurnSubRelIndex: 0}
	args = injectBurnInFilter(args, session)
	vf := vfOf(t, args)
	sub := strings.Index(vf, "subtitles=")
	tm := strings.Index(vf, "tonemap=")
	up := strings.Index(vf, "format=nv12,hwupload")
	if sub < 0 || tm < 0 || up < 0 || !(tm < sub && sub < up) {
		t.Errorf("want tonemap < subtitles < hwupload, got %q", vf)
	}
}

func vfOf(t *testing.T, args []string) string {
	t.Helper()
	for i := 0; i+1 < len(args); i++ {
		if args[i] == "-vf" {
			return args[i+1]
		}
	}
	t.Fatalf("no -vf in %v", args)
	return ""
}

// --- HEVC output gate + x265 CRF ---

func TestSoftwareCRFMapsX264ScaleOntoX265(t *testing.T) {
	if got := softwareCRF(20, false); got != 20 {
		t.Errorf("x264 CRF must pass through, got %d", got)
	}
	if got := softwareCRF(20, true); got != 25 {
		t.Errorf("x265 CRF = %d, want 25 (x264 23 ≈ x265 28)", got)
	}
}

// TestProbeHEVCEncoder_SoftwareIsOptIn pins the gate hermetically: on a
// CPU-only host "auto" must answer "" WITHOUT consulting the encoder list
// (the probe is never reached), and "all" must reach the probe.
func TestProbeHEVCEncoder_SoftwareIsOptIn(t *testing.T) {
	orig := encoderAvailable
	t.Cleanup(func() { encoderAvailable = orig })

	consulted := 0
	encoderAvailable = func(name string) bool {
		consulted++
		return false // never reach a real test encode
	}
	sw := HWAccelInfo{Type: HWAccelNone}

	for _, mode := range []string{"", "auto", "hardware", "hw", "bogus"} {
		consulted = 0
		if got := ProbeHEVCEncoder(sw, mode); got != "" {
			t.Errorf("hevc_output=%q on a software host = %q, want \"\"", mode, got)
		}
		if consulted != 0 {
			t.Errorf("hevc_output=%q consulted the encoder list %d times; the software gate must short-circuit", mode, consulted)
		}
	}
	for _, mode := range []string{"all", "software", "force"} {
		consulted = 0
		if got := ProbeHEVCEncoder(sw, mode); got != "" {
			t.Errorf("hevc_output=%q with no libx265 = %q, want \"\"", mode, got)
		}
		if consulted != 1 {
			t.Errorf("hevc_output=%q must reach the encoder probe (consulted %d)", mode, consulted)
		}
	}
	// Hardware hosts are unaffected by the gate: auto consults the probe.
	consulted = 0
	if got := ProbeHEVCEncoder(HWAccelInfo{Type: HWAccelNVENC}, "auto"); got != "" || consulted != 1 {
		t.Errorf("NVENC auto: got %q, consulted %d; want \"\" (stub) and exactly one probe", got, consulted)
	}
	if got := ProbeHEVCEncoder(sw, "off"); got != "" {
		t.Errorf("off = %q", got)
	}
}

// --- stereo downmix ---

func TestParseStereoDownmix(t *testing.T) {
	for raw, want := range map[string]StereoDownmix{
		"": DownmixStandard, "standard": DownmixStandard, "ITU": DownmixStandard,
		"dialogue": DownmixDialogue, "dialog": DownmixDialogue,
		"night": DownmixNight, "nightmode": DownmixNight,
		"legacy": DownmixLegacy, "off": DownmixLegacy,
	} {
		got, ok := ParseStereoDownmix(raw)
		if !ok || got != want {
			t.Errorf("ParseStereoDownmix(%q) = (%q, %v), want (%q, true)", raw, got, ok, want)
		}
	}
	if got, ok := ParseStereoDownmix("loudest"); ok || got != DownmixStandard {
		t.Errorf("unknown value must fail safe to standard, got (%q, %v)", got, ok)
	}
}

func TestStereoDownmixFilter(t *testing.T) {
	// Layouts the matrices do not cover, and stereo-or-narrower sources,
	// keep the bare -ac 2 fold under every policy.
	for _, policy := range []StereoDownmix{DownmixStandard, DownmixDialogue, DownmixNight, DownmixLegacy} {
		for _, ch := range []int{0, 1, 2, 3, 4, 5, 7} {
			if got := stereoDownmixFilter(policy, ch); got != "" {
				t.Errorf("%s/%dch = %q, want \"\"", policy, ch, got)
			}
		}
	}
	// Legacy never emits a filter.
	if got := stereoDownmixFilter(DownmixLegacy, 6); got != "" {
		t.Errorf("legacy 6ch = %q, want \"\"", got)
	}

	std := stereoDownmixFilter(DownmixStandard, 6)
	// Every chain converts to float FIRST: pan folds in the source's own
	// sample format, and on an integer source the overs saturate inside pan
	// before the limiter sees them (fourth review).
	if !strings.HasPrefix(std, downmixFloat+",pan=stereo|c0=c0+0.707*c2+0.707*c4|c1=c1+0.707*c2+0.707*c5") {
		t.Errorf("standard 5.1 must fold in float with the ITU Lo/Ro matrix: %q", std)
	}
	if !strings.HasSuffix(std, downmixLimiter) {
		t.Errorf("standard must end in the limiter: %q", std)
	}
	if strings.Contains(std, "c3") {
		t.Errorf("standard must discard the LFE, like swresample: %q", std)
	}
	// 7.1: swresample adds the back AND the side pairs to the fronts at the
	// same surround level (0.707 each, no 7.1-specific rule); a matrix with
	// the backs at 0.5 was 3 dB quieter than the fold it claims to mirror
	// (second review, measured on a real 7.1 tone).
	std8 := stereoDownmixFilter(DownmixStandard, 8)
	if !strings.HasPrefix(std8, downmixFloat+",pan=stereo|c0=c0+0.707*c2+0.707*c4+0.707*c6|c1=c1+0.707*c2+0.707*c5+0.707*c7") {
		t.Errorf("standard 7.1 must mirror swresample (backs and sides both 0.707): %q", std8)
	}
	if strings.Contains(std8, "c3") || !strings.HasSuffix(std8, downmixLimiter) {
		t.Errorf("standard 7.1 must discard the LFE and end in the limiter: %q", std8)
	}

	dlg := stereoDownmixFilter(DownmixDialogue, 6)
	if !strings.HasPrefix(dlg, downmixFloat+",") || !strings.Contains(dlg, "c0=0.707*c0+c2+0.5*c4") || !strings.HasSuffix(dlg, downmixLimiter) {
		t.Errorf("dialogue 5.1 = %q", dlg)
	}
	night := stereoDownmixFilter(DownmixNight, 6)
	if !strings.HasPrefix(night, downmixFloat+",pan=stereo|c0=c2+0.3*c0+0.3*c4") || !strings.Contains(night, "dynaudnorm=") {
		t.Errorf("night 5.1 = %q", night)
	}
	if strings.Contains(night, "alimiter") {
		t.Errorf("night's compressor already caps peaks; no limiter expected: %q", night)
	}
	// Channel indices never exceed the input layout.
	for _, f := range []string{std, dlg, night} {
		if strings.Contains(f, "c6") || strings.Contains(f, "c7") {
			t.Errorf("5.1 matrix references a channel beyond c5: %q", f)
		}
	}
}

func TestAudioEncodeArgsAppliesDownmixOnlyToStereoAAC(t *testing.T) {
	// 5.1 source → stereo AAC: the pan chain rides in front of the encoder.
	s := &TranscodeSession{AudioChannels: 6}
	args := audioEncodeArgs(s, DownmixStandard)
	if args[0] != "-af" || !strings.HasPrefix(args[1], downmixFloat+",pan=stereo") {
		t.Errorf("5.1→stereo AAC must carry the downmix filter: %v", args)
	}
	assertContains(t, args, "-c:a", "aac")
	assertContains(t, args, "-ac", "2")

	// Stereo source: nothing to fold.
	args = audioEncodeArgs(&TranscodeSession{AudioChannels: 2}, DownmixStandard)
	if args[0] == "-af" {
		t.Errorf("stereo source must not get a downmix filter: %v", args)
	}
	// Legacy policy: byte-identical to the pre-policy arguments.
	args = audioEncodeArgs(s, DownmixLegacy)
	if strings.Join(args, " ") != "-c:a aac -ac 2 -ar 48000 -b:a 192k" {
		t.Errorf("legacy must reproduce the historical arguments exactly: %v", args)
	}
	// AC-3 surround re-encode is not a stereo fold and never gets the filter.
	args = audioEncodeArgs(&TranscodeSession{AudioChannels: 6, AudioCodecOut: "ac3"}, DownmixStandard)
	for _, a := range args {
		if a == "-af" {
			t.Errorf("AC-3 5.1 output must not carry a stereo downmix: %v", args)
		}
	}
}

// --- bitrate ceiling ---

func TestCapLadder(t *testing.T) {
	ladder := ResolveProfiles(nil, 1920, 1080) // 1080p, 720p, 480p, 360p
	names := func(ps []QualityProfile) string {
		var out []string
		for _, p := range ps {
			out = append(out, p.Name)
		}
		return strings.Join(out, ",")
	}
	if got := names(capLadder(ladder, 0, aacReencodeBitsPerSec)); got != "1080p,720p,480p,360p" {
		t.Errorf("no ceiling must keep the ladder: %s", got)
	}
	// 5 Mbps: 720p declares 4.5M + 192k = 4.692M and fits; 1080p (7.692M) does not.
	if got := names(capLadder(ladder, 5_000_000, aacReencodeBitsPerSec)); got != "720p,480p,360p" {
		t.Errorf("5 Mbps ceiling = %s, want 720p,480p,360p", got)
	}
	// The audio cost counts: with copied 5.1 AC-3 (448k declared) 720p is
	// 4.948M, still under 5M; at 4.7M only the stereo-AAC figure would fit.
	if got := names(capLadder(ladder, 4_700_000, ac3ReencodeBitsPerSec)); got != "480p,360p" {
		t.Errorf("4.7 Mbps ceiling with AC-3 audio = %s, want 480p,360p", got)
	}
	// Below the whole ladder: the lowest rung survives.
	if got := names(capLadder(ladder, 100_000, aacReencodeBitsPerSec)); got != "360p" {
		t.Errorf("tiny ceiling must keep the lowest rung: %s", got)
	}
	if got := capLadder(nil, 5_000_000, 0); len(got) != 0 {
		t.Errorf("empty ladder stays empty: %v", got)
	}
}

func TestDecidePlaybackFor_BitrateCeiling(t *testing.T) {
	chromium := ParseClientCaps("h264,aac,mp3,ac3,mp4_container,webm_container,hls_js")
	chromium.FMP4 = true
	aac := []models.AudioTrack{{Index: 0, Codec: "aac", Channels: 2, IsDefault: true}}

	decide := func(container string, ceiling, source int64) PlaybackDecision {
		caps := *chromium
		caps.MaxBitrate = ceiling
		return DecidePlaybackFor(DecisionInput{
			Container: container, VideoCodec: "h264", PixFmt: "yuv420p",
			AudioTracks: aac, Caps: &caps, SourceBitrate: source,
		})
	}

	// Under the ceiling, unknown bitrate, or no ceiling: the decision is
	// exactly what it was before the ceiling existed.
	for _, tt := range []struct {
		name            string
		ceiling, source int64
	}{
		{"under", 20_000_000, 8_000_000},
		{"equal", 8_000_000, 8_000_000},
		{"unknown source", 8_000_000, 0},
		{"no ceiling", 0, 80_000_000},
	} {
		if pd := decide("mp4", tt.ceiling, tt.source); pd.Decision != "direct_play" {
			t.Errorf("%s: mp4 = %q (%s), want direct_play", tt.name, pd.Decision, pd.TranscodeReason)
		}
		if pd := decide("mkv", tt.ceiling, tt.source); pd.Decision != "direct_stream" {
			t.Errorf("%s: mkv = %q (%s), want direct_stream", tt.name, pd.Decision, pd.TranscodeReason)
		}
	}

	// Over the ceiling: neither direct play nor remux, and the reason names
	// the ceiling rather than a capability the client actually has.
	for _, container := range []string{"mp4", "mkv"} {
		pd := decide(container, 8_000_000, 60_000_000)
		if pd.Decision != "transcode" {
			t.Fatalf("%s over ceiling = %q, want transcode", container, pd.Decision)
		}
		if !strings.Contains(pd.TranscodeReason, "60000 kbps") || !strings.Contains(pd.TranscodeReason, "8000 kbps") {
			t.Errorf("%s reason = %q, want both figures", container, pd.TranscodeReason)
		}
		if got := ReasonCode(pd); got != ReasonBitrate {
			t.Errorf("%s reason bucket = %q, want %q", container, got, ReasonBitrate)
		}
		if pd.VideoCodecOut != "h264" {
			t.Errorf("%s output codec = %q", container, pd.VideoCodecOut)
		}
		// Audio policy is the ordinary transcode one: copyable AAC is copied.
		if !pd.AudioPassthrough {
			t.Errorf("%s: AAC should still be copied on the capped transcode", container)
		}
	}

	// The no-caps static path has no ceiling to read and is unchanged.
	pd := DecidePlaybackFor(DecisionInput{Container: "mp4", VideoCodec: "h264", AudioTracks: aac, SourceBitrate: 60_000_000})
	if pd.Decision != "direct_play" {
		t.Errorf("static path = %q, want direct_play", pd.Decision)
	}
}

// --- preferred audio language ---

func TestNormalizeLang(t *testing.T) {
	for in, want := range map[string]string{
		"": "", "und": "", "auto": "", "AUTO": "", "none": "",
		"en": "eng", "eng": "eng", "en-US": "eng", "EN_GB": "eng",
		"ger": "deu", "deu": "deu", "de": "deu",
		"fre": "fra", "fra": "fra", "chi": "zho", "zh-Hant": "zho", "cmn": "zho",
		"ja": "jpn", "jpn": "jpn", "jp": "jpn",
		"xx": "xx", "tlh": "tlh", "yue": "yue", // unknown tags match themselves
		// Second review: the contract promises 639-1 OR 639-2 form for any
		// language, so every 639-1 code and every B/T twin has to fold.
		"fa": "fas", "per": "fas", "fas": "fas",
		"ms": "msa", "may": "msa", "msa": "msa",
		"sk": "slk", "slo": "slk", "slk": "slk",
		"sq": "sqi", "alb": "sqi",
		"hy": "hye", "arm": "hye",
		"eu": "eus", "baq": "eus",
		"my": "mya", "bur": "mya",
		"ka": "kat", "geo": "kat",
		"is": "isl", "ice": "isl",
		"bo": "bod", "tib": "bod",
		"cy": "cym", "wel": "cym",
		"mk": "mkd", "mac": "mkd",
		"mi": "mri", "mao": "mri",
		"bn": "ben", "ta": "tam", "hr": "hrv", "sr": "srp", "bg": "bul", "ca": "cat",
		"he": "heb", "hi": "hin", "ko": "kor", "pt-BR": "por", "es_419": "spa",
		"tl": "tgl", "tgl": "tgl", "fil": "tgl",
		// Norwegian: one preference covers both written forms.
		"no": "nor", "nor": "nor", "nb": "nor", "nob": "nor", "nn": "nor", "nno": "nor",
	} {
		if got := normalizeLang(in); got != want {
			t.Errorf("normalizeLang(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestLangTablesShape pins the tables structurally: ISO 639-1 has exactly
// 184 codes, every entry is a two-letter → three-letter fold, the twenty
// bibliographic codes all resolve to a terminology code the 639-1 table also
// produces, and no bibliographic code is itself a 639-1 value (they would
// otherwise fold twice).
func TestLangTablesShape(t *testing.T) {
	if got := len(iso6391To6392T); got != 184 {
		t.Errorf("ISO 639-1 table has %d entries, want 184", got)
	}
	tCodes := map[string]bool{}
	isLower := func(s string) bool {
		for _, r := range s {
			if r < 'a' || r > 'z' {
				return false
			}
		}
		return true
	}
	for k, v := range iso6391To6392T {
		if len(k) != 2 || !isLower(k) || len(v) != 3 || !isLower(v) {
			t.Errorf("639-1 entry %q → %q is not a two→three letter fold", k, v)
		}
		tCodes[v] = true
	}
	if got := len(iso6392BToT); got != 20 {
		t.Errorf("639-2/B table has %d entries, want 20", got)
	}
	for b, tc := range iso6392BToT {
		if len(b) != 3 || !isLower(b) {
			t.Errorf("639-2/B code %q malformed", b)
		}
		if !tCodes[tc] {
			t.Errorf("639-2/B %q → %q: target is not a 639-2/T code the 639-1 table produces", b, tc)
		}
		if tCodes[b] {
			t.Errorf("639-2/B %q is also a 639-1 target — it would fold twice", b)
		}
	}
	for from, to := range langExtraFolds {
		if normalizeLang(to) != to {
			t.Errorf("extra fold %q → %q must land on a canonical code (got %q)", from, to, normalizeLang(to))
		}
	}
}

func TestDecidePlaybackFor_PreferredAudioLanguage(t *testing.T) {
	chromium := ParseClientCaps("h264,aac,ac3,mp4_container,hls_js")
	chromium.FMP4 = true
	engThenJpn := []models.AudioTrack{
		{Index: 0, Codec: "aac", Channels: 2, Language: "eng", IsDefault: true},
		{Index: 1, Codec: "aac", Channels: 2, Language: "jpn"},
	}
	decide := func(lang string, tracks []models.AudioTrack, caps *ClientCaps) PlaybackDecision {
		return DecidePlaybackFor(DecisionInput{
			Container: "mp4", VideoCodec: "h264", PixFmt: "yuv420p",
			AudioTracks: tracks, Caps: caps, PreferredAudioLang: lang,
		})
	}

	// No preference, a preference the default already satisfies, or a
	// language the file lacks: the default track direct-plays as before.
	for _, lang := range []string{"", "auto", "en", "eng", "en-US", "de"} {
		pd := decide(lang, engThenJpn, chromium)
		if pd.Decision != "direct_play" || pd.AudioTrackIndex != 0 {
			t.Errorf("lang %q: %s track %d, want direct_play track 0", lang, pd.Decision, pd.AudioTrackIndex)
		}
	}
	// A preference for the non-default compatible track selects it, which
	// costs a remux (direct play cannot pick a non-default track).
	for _, lang := range []string{"ja", "jpn", "jp"} {
		pd := decide(lang, engThenJpn, chromium)
		if pd.Decision != "direct_stream" || pd.AudioTrackIndex != 1 || !pd.AudioPassthrough {
			t.Errorf("lang %q: %s track %d copy=%v, want direct_stream track 1 copied", lang, pd.Decision, pd.AudioTrackIndex, pd.AudioPassthrough)
		}
		if got := ReasonCode(pd); got != ReasonAudioTrack {
			t.Errorf("lang %q bucket = %q, want %q", lang, got, ReasonAudioTrack)
		}
	}

	// A preferred-language track the delivery path cannot COPY is still
	// selected — re-encoded on the remux path, exactly as an uncopyable
	// default track already is. The alternative (passing it over for the
	// compatible track in the wrong language) is what the first version did,
	// and with video and container both fine it then matched no remux branch
	// and fell into a full video transcode of the wrong track (review finding).
	dtsJpnThenAacEng := []models.AudioTrack{
		{Index: 0, Codec: "dts", Channels: 6, Language: "jpn", IsDefault: true},
		{Index: 1, Codec: "aac", Channels: 2, Language: "eng"},
	}
	// No preference: the compatible English track, copied — unchanged.
	if pd := decide("", dtsJpnThenAacEng, chromium); pd.Decision != "direct_stream" || pd.AudioTrackIndex != 1 || !pd.AudioPassthrough {
		t.Errorf("no pref: %s track %d copy=%v, want direct_stream track 1 copied", pd.Decision, pd.AudioTrackIndex, pd.AudioPassthrough)
	}
	// Japanese: the DTS default, re-encoded (stereo AAC / AC-3 for the client).
	pd := decide("ja", dtsJpnThenAacEng, chromium)
	if pd.Decision != "direct_stream" || pd.AudioTrackIndex != 0 || !pd.AudioNeedsRecode || pd.AudioPassthrough {
		t.Errorf("ja on a browser: %s track %d recode=%v copy=%v, want direct_stream track 0 re-encoded",
			pd.Decision, pd.AudioTrackIndex, pd.AudioNeedsRecode, pd.AudioPassthrough)
	}
	if got := ReasonCode(pd); got != ReasonAudioCodec {
		t.Errorf("ja on a browser bucket = %q, want %q (reason %q)", got, ReasonAudioCodec, pd.TranscodeReason)
	}

	// A native client that decodes DTS keeps the Japanese default when that
	// is what the viewer asked for, and pays the remux for English otherwise.
	native := ParseClientCaps("h264,hevc,aac,ac3,dts,mp4_container,mkv_container,hls_native")
	native.FMP4 = true
	if pd := decide("ja", dtsJpnThenAacEng, native); pd.Decision != "direct_play" || pd.AudioTrackIndex != 0 {
		t.Errorf("native ja: %s track %d, want direct_play track 0", pd.Decision, pd.AudioTrackIndex)
	}
	if pd := decide("en", dtsJpnThenAacEng, native); pd.Decision != "direct_stream" || pd.AudioTrackIndex != 1 {
		t.Errorf("native en: %s track %d, want direct_stream track 1", pd.Decision, pd.AudioTrackIndex)
	}

	// The review's two reproductions. Both used to come back as a full
	// transcode of the WRONG track with a "video codec not supported" reason.
	decideIn := func(container, lang string, tracks []models.AudioTrack, caps *ClientCaps) PlaybackDecision {
		return DecidePlaybackFor(DecisionInput{
			Container: container, VideoCodec: "h264", PixFmt: "yuv420p",
			AudioTracks: tracks, Caps: caps, PreferredAudioLang: lang,
		})
	}
	// Native client, MKV, AC-3 English default + DTS Japanese. The native
	// HLS fallback strips DTS from its copy set, so Japanese costs a recode.
	ac3EngThenDtsJpn := []models.AudioTrack{
		{Index: 0, Codec: "ac3", Channels: 6, Language: "eng", IsDefault: true},
		{Index: 1, Codec: "dts", Channels: 6, Language: "jpn"},
	}
	if pd := decideIn("mkv", "", ac3EngThenDtsJpn, native); pd.Decision != "direct_play" || pd.AudioTrackIndex != 0 {
		t.Errorf("native mkv no pref: %s track %d, want direct_play track 0", pd.Decision, pd.AudioTrackIndex)
	}
	pd = decideIn("mkv", "ja", ac3EngThenDtsJpn, native)
	if pd.Decision != "direct_stream" || pd.AudioTrackIndex != 1 || !pd.AudioNeedsRecode || pd.AudioPassthrough {
		t.Errorf("native mkv ja: %s track %d recode=%v copy=%v (reason %q), want direct_stream track 1 re-encoded",
			pd.Decision, pd.AudioTrackIndex, pd.AudioNeedsRecode, pd.AudioPassthrough, pd.TranscodeReason)
	}
	if pd.VideoCodecOut != "" {
		t.Errorf("native mkv ja: a remux must not carry a transcode output codec, got %q", pd.VideoCodecOut)
	}
	// Chromium, MP4, AAC English default + Opus Japanese. Chromium decodes
	// Opus natively but hls.js cannot carry it, so Japanese costs a recode.
	chromiumOpus := ParseClientCaps("h264,aac,ac3,opus,mp4_container,webm_container,hls_js")
	chromiumOpus.FMP4 = true
	aacEngThenOpusJpn := []models.AudioTrack{
		{Index: 0, Codec: "aac", Channels: 2, Language: "eng", IsDefault: true},
		{Index: 1, Codec: "opus", Channels: 2, Language: "jpn"},
	}
	if pd := decideIn("mp4", "", aacEngThenOpusJpn, chromiumOpus); pd.Decision != "direct_play" || pd.AudioTrackIndex != 0 {
		t.Errorf("chromium mp4 no pref: %s track %d, want direct_play track 0", pd.Decision, pd.AudioTrackIndex)
	}
	pd = decideIn("mp4", "ja", aacEngThenOpusJpn, chromiumOpus)
	if pd.Decision != "direct_stream" || pd.AudioTrackIndex != 1 || !pd.AudioNeedsRecode || pd.AudioPassthrough {
		t.Errorf("chromium mp4 ja: %s track %d recode=%v copy=%v (reason %q), want direct_stream track 1 re-encoded",
			pd.Decision, pd.AudioTrackIndex, pd.AudioNeedsRecode, pd.AudioPassthrough, pd.TranscodeReason)
	}
	if got := ReasonCode(pd); got != ReasonAudioCodec {
		t.Errorf("chromium mp4 ja bucket = %q, want %q", got, ReasonAudioCodec)
	}
	// And when the video itself must transcode, the preferred track still
	// rides along (re-encoded), instead of the wrong-language default.
	hevcChromium := ParseClientCaps("h264,aac,ac3,mp4_container,hls_js")
	hevcChromium.FMP4 = true
	pd = DecidePlaybackFor(DecisionInput{
		Container: "mkv", VideoCodec: "hevc", PixFmt: "yuv420p",
		AudioTracks: aacEngThenOpusJpn, Caps: hevcChromium, PreferredAudioLang: "ja",
	})
	if pd.Decision != "transcode" || pd.AudioTrackIndex != 1 || !pd.AudioNeedsRecode {
		t.Errorf("transcode ja: %s track %d recode=%v, want transcode track 1 re-encoded", pd.Decision, pd.AudioTrackIndex, pd.AudioNeedsRecode)
	}

	// Two compatible tracks in the preferred language: the default one wins,
	// so a file that already defaults to the viewer's language never loses
	// direct play to its own commentary track.
	engTwice := []models.AudioTrack{
		{Index: 0, Codec: "aac", Channels: 2, Language: "eng", Title: "Commentary"},
		{Index: 1, Codec: "ac3", Channels: 6, Language: "eng", IsDefault: true},
	}
	if pd := decide("en", engTwice, chromium); pd.Decision != "direct_play" || pd.AudioTrackIndex != 1 {
		t.Errorf("default among matches: %s track %d, want direct_play track 1", pd.Decision, pd.AudioTrackIndex)
	}
}

// TestDecidePlaybackFor_PreferredLanguageGatesDirectPlay pins the second
// review's finding. findBestAudioTrack ranks only tracks the CLIENT's caps can
// play, so when the preferred track's codec was outside them it reported the
// wrong-language default as the direct-play pick, and direct play won —
// whether the viewer's language was honoured depended on whether the client
// happened to claim the preferred track's codec, inverted from what the
// delivery path can do (it can re-encode either way). The direct-play gate is
// now codec-blind: a file with a track in the preferred language direct-plays
// only when that track is the one direct play would select.
func TestDecidePlaybackFor_PreferredLanguageGatesDirectPlay(t *testing.T) {
	decide := func(container, lang string, tracks []models.AudioTrack, caps *ClientCaps) PlaybackDecision {
		return DecidePlaybackFor(DecisionInput{
			Container: container, VideoCodec: "h264", PixFmt: "yuv420p",
			AudioTracks: tracks, Caps: caps, PreferredAudioLang: lang,
		})
	}
	chromium := ParseClientCaps("h264,aac,ac3,mp4_container,webm_container,hls_js")
	chromium.FMP4 = true
	nativeNoDTS := ParseClientCaps("h264,hevc,aac,ac3,eac3,mp4_container,mkv_container,hls_native")
	nativeNoDTS.FMP4 = true
	nativeDTSNoTrueHD := ParseClientCaps("h264,hevc,aac,ac3,dts,mp4_container,mkv_container,hls_native")
	nativeDTSNoTrueHD.FMP4 = true

	aacEngDefaultDtsJpn := []models.AudioTrack{
		{Index: 0, Codec: "aac", Channels: 2, Language: "eng", IsDefault: true},
		{Index: 1, Codec: "dts", Channels: 6, Language: "jpn"},
	}
	ac3EngDefaultTruehdJpn := []models.AudioTrack{
		{Index: 0, Codec: "ac3", Channels: 6, Language: "eng", IsDefault: true},
		{Index: 1, Codec: "truehd", Channels: 8, Language: "jpn"},
	}
	noFlags := []models.AudioTrack{ // mkvmerge style: nothing flagged, players take the first
		{Index: 0, Codec: "aac", Channels: 2, Language: "eng"},
		{Index: 1, Codec: "dts", Channels: 6, Language: "jpn"},
	}
	for _, tt := range []struct {
		name, container string
		tracks          []models.AudioTrack
		caps            *ClientCaps
	}{
		{"browser, MP4, AAC English default + DTS Japanese", "mp4", aacEngDefaultDtsJpn, chromium},
		{"native without dts, MKV", "mkv", aacEngDefaultDtsJpn, nativeNoDTS},
		{"native with dts but not truehd, MKV", "mkv", ac3EngDefaultTruehdJpn, nativeDTSNoTrueHD},
		{"native without dts, MKV, no default flags", "mkv", noFlags, nativeNoDTS},
	} {
		// No preference: the default direct-plays, exactly as before.
		if pd := decide(tt.container, "", tt.tracks, tt.caps); pd.Decision != "direct_play" || pd.AudioTrackIndex != 0 {
			t.Errorf("%s, no pref: %s track %d, want direct_play track 0", tt.name, pd.Decision, pd.AudioTrackIndex)
		}
		// Japanese: never direct play of the English default. The preferred
		// track is selected and re-encoded on the remux path.
		pd := decide(tt.container, "ja", tt.tracks, tt.caps)
		if pd.Decision != "direct_stream" || pd.AudioTrackIndex != 1 || !pd.AudioNeedsRecode || pd.AudioPassthrough || !pd.Remux {
			t.Errorf("%s, ja: %s track %d recode=%v copy=%v remux=%v (reason %q), want direct_stream track 1 re-encoded",
				tt.name, pd.Decision, pd.AudioTrackIndex, pd.AudioNeedsRecode, pd.AudioPassthrough, pd.Remux, pd.TranscodeReason)
		}
		if pd.VideoCodecOut != "" {
			t.Errorf("%s, ja: a remux must not carry a transcode output codec, got %q", tt.name, pd.VideoCodecOut)
		}
		if got := ReasonCode(pd); got != ReasonAudioCodec {
			t.Errorf("%s, ja: bucket = %q, want %q", tt.name, got, ReasonAudioCodec)
		}
		// A language the file lacks leaves direct play alone.
		if pd := decide(tt.container, "de", tt.tracks, tt.caps); pd.Decision != "direct_play" || pd.AudioTrackIndex != 0 {
			t.Errorf("%s, de: %s track %d, want direct_play track 0", tt.name, pd.Decision, pd.AudioTrackIndex)
		}
	}

	// The mirror image — the preferred track IS the default but the client
	// cannot decode it — was already a remux + recode; it must stay one.
	dtsJpnDefaultAacEng := []models.AudioTrack{
		{Index: 0, Codec: "dts", Channels: 6, Language: "jpn", IsDefault: true},
		{Index: 1, Codec: "aac", Channels: 2, Language: "eng"},
	}
	pd := decide("mp4", "ja", dtsJpnDefaultAacEng, chromium)
	if pd.Decision != "direct_stream" || pd.AudioTrackIndex != 0 || !pd.AudioNeedsRecode {
		t.Errorf("default-but-undecodable preferred track: %s track %d recode=%v, want direct_stream track 0 re-encoded",
			pd.Decision, pd.AudioTrackIndex, pd.AudioNeedsRecode)
	}
	// And a client that CAN decode the preferred default keeps direct play.
	if pd := decide("mp4", "ja", dtsJpnDefaultAacEng, nativeDTSNoTrueHD); pd.Decision != "direct_play" || pd.AudioTrackIndex != 0 {
		t.Errorf("decodable preferred default: %s track %d, want direct_play track 0", pd.Decision, pd.AudioTrackIndex)
	}
}

func TestEffectiveDefaultIndex(t *testing.T) {
	if got := effectiveDefaultIndex(nil); got != -1 {
		t.Errorf("no tracks: %d, want -1", got)
	}
	noFlags := []models.AudioTrack{{Index: 0}, {Index: 1}}
	if got := effectiveDefaultIndex(noFlags); got != 0 {
		t.Errorf("no flags: %d, want 0", got)
	}
	secondFlagged := []models.AudioTrack{{Index: 0}, {Index: 1, IsDefault: true}}
	if got := effectiveDefaultIndex(secondFlagged); got != 1 {
		t.Errorf("second flagged: %d, want 1", got)
	}
	bothFlagged := []models.AudioTrack{{Index: 0, IsDefault: true}, {Index: 1, IsDefault: true}}
	if got := effectiveDefaultIndex(bothFlagged); got != 0 {
		t.Errorf("both flagged: %d, want 0 (players start the first)", got)
	}
	if !effectiveDefaultTrack(bothFlagged, 0) || effectiveDefaultTrack(bothFlagged, 1) {
		t.Error("exactly one track is the effective default")
	}
	if effectiveDefaultTrack(bothFlagged, -1) || effectiveDefaultTrack(bothFlagged, 2) {
		t.Error("out-of-range indices are never the default")
	}
}

// TestDecidePlaybackFor_MultipleDefaultFlags: files with the default flag on
// several audio tracks are real (GPAC/MP4Box, Apple tooling, `ffmpeg -c copy`
// of either), and a player starts exactly one of them — the first. Treating
// every flagged track as "the default" direct-played a file for a track the
// browser would never start (third review).
func TestDecidePlaybackFor_MultipleDefaultFlags(t *testing.T) {
	chromium := ParseClientCaps("h264,aac,ac3,mp4_container,webm_container,hls_js")
	chromium.FMP4 = true
	decide := func(lang string, tracks []models.AudioTrack) PlaybackDecision {
		return DecidePlaybackFor(DecisionInput{
			Container: "mp4", VideoCodec: "h264", PixFmt: "yuv420p",
			AudioTracks: tracks, Caps: chromium, PreferredAudioLang: lang,
		})
	}

	bothDefault := []models.AudioTrack{
		{Index: 0, Codec: "aac", Channels: 2, Language: "eng", IsDefault: true},
		{Index: 1, Codec: "aac", Channels: 2, Language: "jpn", IsDefault: true},
	}
	// The browser would start track 0: Japanese needs a remux to select
	// track 1, copied. It used to direct-play — the English track.
	pd := decide("ja", bothDefault)
	if pd.Decision != "direct_stream" || pd.AudioTrackIndex != 1 || !pd.AudioPassthrough {
		t.Errorf("both flagged, ja: %s track %d copy=%v, want direct_stream track 1 copied", pd.Decision, pd.AudioTrackIndex, pd.AudioPassthrough)
	}
	if got := ReasonCode(pd); got != ReasonAudioTrack {
		t.Errorf("both flagged, ja: bucket %q, want %q (reason %q)", got, ReasonAudioTrack, pd.TranscodeReason)
	}
	for _, lang := range []string{"", "en"} {
		if pd := decide(lang, bothDefault); pd.Decision != "direct_play" || pd.AudioTrackIndex != 0 {
			t.Errorf("both flagged, %q: %s track %d, want direct_play track 0", lang, pd.Decision, pd.AudioTrackIndex)
		}
	}

	// DTS Japanese (first flagged) + AAC Japanese (also flagged) + AAC English.
	threeTracks := []models.AudioTrack{
		{Index: 0, Codec: "dts", Channels: 6, Language: "jpn", IsDefault: true},
		{Index: 1, Codec: "aac", Channels: 2, Language: "jpn", IsDefault: true},
		{Index: 2, Codec: "aac", Channels: 2, Language: "eng"},
	}
	// Japanese: the copyable AAC track, selected by remux — NOT a full video
	// transcode of a decodable file (the review's reproduction).
	pd = decide("ja", threeTracks)
	if pd.Decision != "direct_stream" || pd.AudioTrackIndex != 1 || !pd.AudioPassthrough || pd.VideoCodecOut != "" {
		t.Errorf("three tracks, ja: %s track %d copy=%v out=%q (reason %q), want direct_stream track 1 copied",
			pd.Decision, pd.AudioTrackIndex, pd.AudioPassthrough, pd.VideoCodecOut, pd.TranscodeReason)
	}
	// No preference: the browser would start the DTS track it cannot decode,
	// so this file is a remux of track 1 — it used to direct-play (silently).
	pd = decide("", threeTracks)
	if pd.Decision != "direct_stream" || pd.AudioTrackIndex != 1 || !pd.AudioPassthrough {
		t.Errorf("three tracks, no pref: %s track %d copy=%v, want direct_stream track 1 copied", pd.Decision, pd.AudioTrackIndex, pd.AudioPassthrough)
	}
	if pd := decide("en", threeTracks); pd.Decision != "direct_stream" || pd.AudioTrackIndex != 2 || !pd.AudioPassthrough {
		t.Errorf("three tracks, en: %s track %d copy=%v, want direct_stream track 2 copied", pd.Decision, pd.AudioTrackIndex, pd.AudioPassthrough)
	}
}

// TestDecidePlaybackFor_BitrateReasonOnlyWhenDecisive: the `bitrate` bucket is
// the one transcode reason an operator can address by changing a setting, so
// it must be named only when the ceiling is what closed direct play and remux.
// A file that transcodes for its codec anyway keeps the codec wording (second
// review finding).
func TestDecidePlaybackFor_BitrateReasonOnlyWhenDecisive(t *testing.T) {
	aac := []models.AudioTrack{{Index: 0, Codec: "aac", Channels: 2, IsDefault: true}}
	decide := func(capsStr, container, codec string, ceiling, source int64) PlaybackDecision {
		caps := ParseClientCaps(capsStr)
		caps.FMP4 = true
		caps.MaxBitrate = ceiling
		return DecidePlaybackFor(DecisionInput{
			Container: container, VideoCodec: codec, PixFmt: "yuv420p",
			AudioTracks: aac, Caps: caps, SourceBitrate: source,
		})
	}
	h264Only := "h264,aac,ac3,mp4_container,webm_container,hls_js"

	// HEVC on an H.264-only client: a transcode with or without the ceiling.
	pd := decide(h264Only, "mp4", "hevc", 8_000_000, 60_000_000)
	if pd.Decision != "transcode" {
		t.Fatalf("hevc over ceiling = %q, want transcode", pd.Decision)
	}
	if got := ReasonCode(pd); got != ReasonVideoCodec {
		t.Errorf("hevc over ceiling bucket = %q (reason %q), want %q", got, pd.TranscodeReason, ReasonVideoCodec)
	}
	// VP9 in an unclaimed container: the client decodes it, remux is closed
	// to it, the container is not direct-playable — a transcode regardless,
	// and the wording must still say "cannot be remuxed", not "not supported".
	vp9 := "h264,vp9,aac,ac3,mp4_container,webm_container,hls_js"
	pd = decide(vp9, "mkv", "vp9", 8_000_000, 60_000_000)
	if pd.Decision != "transcode" || !strings.Contains(pd.TranscodeReason, "cannot be remuxed") {
		t.Errorf("vp9 in mkv over ceiling = %q %q, want a transcode that says cannot be remuxed", pd.Decision, pd.TranscodeReason)
	}
	if got := ReasonCode(pd); got == ReasonBitrate {
		t.Errorf("vp9 in mkv over ceiling bucket = %q; the ceiling changed nothing", got)
	}
	// The same VP9 file in a claimed container direct-plays uncapped, so
	// there the ceiling IS decisive.
	pd = decide(vp9, "webm", "vp9", 8_000_000, 60_000_000)
	if pd.Decision != "transcode" || ReasonCode(pd) != ReasonBitrate {
		t.Errorf("vp9 in webm over ceiling = %q bucket %q (reason %q), want transcode/bitrate", pd.Decision, ReasonCode(pd), pd.TranscodeReason)
	}
	// H.264 in MKV: uncapped it remuxes, so the ceiling is decisive.
	pd = decide(h264Only, "mkv", "h264", 8_000_000, 60_000_000)
	if pd.Decision != "transcode" || ReasonCode(pd) != ReasonBitrate {
		t.Errorf("h264 in mkv over ceiling = %q bucket %q, want transcode/bitrate", pd.Decision, ReasonCode(pd))
	}
}

// --- ffmpeg-backed ---

// TestPlaybackMatrix_StereoDownmixPoliciesEncode runs every downmix policy
// through a real 5.1 and 7.1 source. The unit tests above pin the filter
// strings; this pins that the local ffmpeg accepts them (pan syntax, alimiter
// and dynaudnorm option names) and that stereo AAC actually comes out — a
// rejected option kills the launch at filter init, before any segment, which
// no argument test can see.
func TestPlaybackMatrix_StereoDownmixPoliciesEncode(t *testing.T) {
	requireFFmpeg(t)
	requireFFmpegEncoders(t, "libx264", "aac")

	for _, channels := range []int{6, 8} {
		fixture := mediaFixture{Container: "mkv", VideoCodec: "h264", AudioCodec: "aac", AudioChannels: channels}
		path := fixture.build(t)
		if got := firstAudioStream(t, probeStreams(t, path)).Channels; got != channels {
			t.Fatalf("fixture has %d audio channels, want %d", got, channels)
		}
		for _, policy := range []StereoDownmix{DownmixStandard, DownmixDialogue, DownmixNight, DownmixLegacy} {
			t.Run(string(policy)+"/"+map[int]string{6: "5.1", 8: "7.1"}[channels], func(t *testing.T) {
				cfg := matrixConfig()
				cfg.StereoDownmix = string(policy)
				tm, err := NewTranscodeManager(t.TempDir(), cfg)
				if err != nil {
					t.Fatalf("new transcode manager: %v", err)
				}
				t.Cleanup(tm.Close)
				if tm.stereoDownmix != policy {
					t.Fatalf("manager resolved downmix %q, want %q", tm.stereoDownmix, policy)
				}

				_, variant := startFirstVariant(t, tm, path,
					SessionOpts{SourceVideoCodec: "h264", AudioTrackIndex: -1, AudioChannels: channels})
				merged := mergeInitAndSegment(t, variant.OutputDir)
				audio := firstAudioStream(t, probeStreams(t, merged))
				if audio.CodecName != "aac" {
					t.Errorf("segment audio codec = %q, want aac", audio.CodecName)
				}
				if audio.Channels != 2 {
					t.Errorf("segment audio channels = %d, want 2", audio.Channels)
				}
			})
		}
	}
}

// TestPlaybackMatrix_InitialBurstIsAcceptedByFFmpeg pins that the burst flag
// the version gate admits is one this ffmpeg actually takes: on a >= 6.1
// build the manager must enable it AND the launch must produce a segment.
func TestPlaybackMatrix_InitialBurstIsAcceptedByFFmpeg(t *testing.T) {
	requireFFmpeg(t)
	requireFFmpegEncoders(t, "libx264", "aac")

	tm := newMatrixManager(t)
	major, minor := ffmpegProbeVersion()
	if want := readrateInitialBurstSupported(major, minor); tm.readrateBurstOK != want {
		t.Fatalf("readrateBurstOK = %v for ffmpeg %d.%d, want %v", tm.readrateBurstOK, major, minor, want)
	}
	if !tm.readrateBurstOK {
		t.Skipf("ffmpeg %d.%d predates -readrate_initial_burst; nothing to exercise", major, minor)
	}
	path := mediaFixture{Container: "mkv", VideoCodec: "h264", AudioCodec: "aac"}.build(t)
	_, variant := startFirstVariant(t, tm, path,
		SessionOpts{SourceVideoCodec: "h264", AudioTrackIndex: -1, AudioChannels: 2})
	if d := segmentDurationOf(t, mergeInitAndSegment(t, variant.OutputDir)); d <= 0 {
		t.Errorf("burst-paced launch produced a segment with no media (%v)", d)
	}
}

// TestPlaybackMatrix_CappedLadderCreatesOnlyKeptRungs pins the ceiling at the
// session layer: rungs above the ceiling get neither a profile entry nor a
// variant directory, so hls.js can never climb onto them.
func TestPlaybackMatrix_CappedLadderCreatesOnlyKeptRungs(t *testing.T) {
	requireFFmpeg(t) // CreateSession refuses to run without ffmpeg on PATH

	cfg := matrixConfig()
	cfg.Profiles = []string{"1080p", "720p", "480p", "360p"}
	tm, err := NewTranscodeManager(t.TempDir(), cfg)
	if err != nil {
		t.Fatalf("new transcode manager: %v", err)
	}
	t.Cleanup(tm.Close)

	s, err := tm.CreateSession(1, "u", "/library/x.mkv", 1920, 1080,
		SessionOpts{AudioTrackIndex: -1, AudioChannels: 2, MaxBitrate: 5_000_000})
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	t.Cleanup(func() { tm.StopSession(s.ID) })
	var names []string
	for _, p := range s.Profiles {
		names = append(names, p.Name)
	}
	if got := strings.Join(names, ","); got != "720p,480p,360p" {
		t.Errorf("capped ladder = %s, want 720p,480p,360p", got)
	}
	if _, ok := s.Variants["1080p"]; ok {
		t.Error("a dropped rung must not get a variant")
	}
	if len(s.Variants) != 3 {
		t.Errorf("variants = %d, want 3", len(s.Variants))
	}
}

// Keep config.TranscodeConfig's new knob reachable from the matrix config
// helper: a typo here would silently test the default policy four times.
var _ = config.TranscodeConfig{StereoDownmix: string(DownmixStandard)}
