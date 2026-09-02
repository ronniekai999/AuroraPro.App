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
		{"ffmpeg version 2024-01-01", 0, 0},
		{"ffmpeg version 6.1", 6, 1},
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
	if !strings.HasPrefix(std, "pan=stereo|c0=c0+0.707*c2+0.707*c4|c1=c1+0.707*c2+0.707*c5") {
		t.Errorf("standard 5.1 must be the ITU Lo/Ro matrix: %q", std)
	}
	if !strings.HasSuffix(std, downmixLimiter) {
		t.Errorf("standard must end in the limiter: %q", std)
	}
	if strings.Contains(std, "c3") {
		t.Errorf("standard must discard the LFE, like swresample: %q", std)
	}
	std8 := stereoDownmixFilter(DownmixStandard, 8)
	if !strings.Contains(std8, "0.5*c4") || !strings.Contains(std8, "0.707*c6") {
		t.Errorf("standard 7.1 must mirror swresample (backs 0.5, sides 0.707): %q", std8)
	}

	dlg := stereoDownmixFilter(DownmixDialogue, 6)
	if !strings.Contains(dlg, "c0=0.707*c0+c2+0.5*c4") || !strings.HasSuffix(dlg, downmixLimiter) {
		t.Errorf("dialogue 5.1 = %q", dlg)
	}
	night := stereoDownmixFilter(DownmixNight, 6)
	if !strings.HasPrefix(night, "pan=stereo|c0=c2+0.3*c0+0.3*c4") || !strings.Contains(night, "dynaudnorm=") {
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
	if args[0] != "-af" || !strings.HasPrefix(args[1], "pan=stereo") {
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
		"fre": "fra", "fra": "fra", "chi": "zho", "zh-Hant": "zho",
		"ja": "jpn", "jpn": "jpn", "jp": "jpn",
		"xx": "xx", "tlh": "tlh", // unknown tags match themselves
	} {
		if got := normalizeLang(in); got != want {
			t.Errorf("normalizeLang(%q) = %q, want %q", in, got, want)
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
