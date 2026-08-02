package streaming

import (
	"bytes"
	"log/slog"
	"strings"
	"testing"
)

// captureProbeLogs swaps the default slog handler for the duration of fn.
func captureProbeLogs(t *testing.T, fn func()) string {
	t.Helper()
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(prev) })
	fn()
	return buf.String()
}

// "Unknown encoder 'h264_amf'" reported as a failed test encode sends an
// operator after their driver or their device permissions, when the truth is
// that their FFmpeg was never built with the encoder and no amount of
// configuration will change it. Distro builds routinely omit AMF.
func TestTryProbe_MissingEncoderIsNotAFailedTestEncode(t *testing.T) {
	prev := encoderAvailable
	t.Cleanup(func() { encoderAvailable = prev })
	encoderAvailable = func(string) bool { return false }

	testEncodeRan := false
	p := hwProbe{
		accelType:   HWAccelAMF,
		encoder:     "h264_amf",
		displayName: "AMD AMF",
		detectFn:    func() bool { return true },
		testArgsFn: func() ([]string, string) {
			testEncodeRan = true
			return nil, ""
		},
	}

	out := captureProbeLogs(t, func() {
		if _, ok := tryProbe(p); ok {
			t.Fatal("probe reported success for an encoder this FFmpeg does not have")
		}
	})

	if testEncodeRan {
		t.Fatal("ran a test encode for an encoder FFmpeg does not have")
	}
	if !strings.Contains(out, "no encoder for it") {
		t.Fatalf("warning did not name the missing encoder as the cause:\n%s", out)
	}
	if strings.Contains(out, "test encode failed") {
		t.Fatalf("reported a failed test encode that never ran:\n%s", out)
	}
}

// The gate must not swallow probes that CAN run — it only separates two causes.
func TestTryProbe_PresentEncoderStillRunsTheTestEncode(t *testing.T) {
	prev := encoderAvailable
	t.Cleanup(func() { encoderAvailable = prev })
	encoderAvailable = func(string) bool { return true }

	testEncodeRan := false
	p := hwProbe{
		accelType:   HWAccelVAAPI,
		encoder:     "h264_vaapi",
		displayName: "VA-API",
		detectFn:    func() bool { return true },
		testArgsFn: func() ([]string, string) {
			testEncodeRan = true
			return []string{"-c:v", "h264_vaapi"}, "/dev/dri/renderD128"
		},
	}

	captureProbeLogs(t, func() { tryProbe(p) })

	if !testEncodeRan {
		t.Fatal("the encoder gate skipped a test encode it should have allowed")
	}
}

// If FFmpeg cannot be run at all we must not invent a verdict — the test
// encode is the real gate and will produce its own.
func TestFFmpegHasEncoder_UnrunnableFFmpegDefersToTheTestEncode(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	if !ffmpegHasEncoder("h264_vaapi") {
		t.Fatal("an unrunnable ffmpeg ruled out an encoder instead of deferring")
	}
}

// FFmpeg routes its listings through av_log, and which stream that lands on
// has varied across builds. Reading stdout alone would report every encoder
// missing on a build that logs to stderr — silently disabling working
// hardware acceleration and warning that the build has no encoder, on a box
// where it does. That failure is severe and silent, so both streams count.
func TestFFmpegHasEncoder_FindsTheListingOnEitherStream(t *testing.T) {
	const listing = ` V....D h264_vaapi           H.264/AVC (VAAPI) (codec h264)`

	t.Run("stdout", func(t *testing.T) {
		stubFFmpeg(t, "echo '"+listing+"'\nexit 0\n")
		if !ffmpegHasEncoder("h264_vaapi") {
			t.Fatal("missed an encoder listed on stdout")
		}
	})

	t.Run("stderr", func(t *testing.T) {
		stubFFmpeg(t, "echo '"+listing+"' >&2\nexit 0\n")
		if !ffmpegHasEncoder("h264_vaapi") {
			t.Fatal("a listing on stderr was read as 'encoder missing'")
		}
	})

	// Reading both streams must not turn every query into a yes.
	t.Run("genuinely absent stays absent", func(t *testing.T) {
		stubFFmpeg(t, "echo '"+listing+"'\nexit 0\n")
		if ffmpegHasEncoder("h264_amf") {
			t.Fatal("reported an encoder that is not in the listing")
		}
	})
}

// Fixtures taken from the 2026-08-02 production box: an AMD-CPU server whose
// only display device is an ASPEED BMC console chip. It reported "AMD AMF"
// hardware, ran a doomed test encode, and warned about a GPU that isn't there.
//
// The old detector searched the whole lspci output for "amd" and, separately,
// for "vga"/"display". Both matched — on different lines. Every Ryzen and EPYC
// board says "Advanced Micro Devices, Inc. [AMD]" on its host bridges, so the
// bug fired on any AMD-CPU machine with any display adapter at all.

const lspciAMDCPUWithBMCOnly = `00:00.0 Host bridge [0600]: Advanced Micro Devices, Inc. [AMD] Starship/Matisse Root Complex [1022:1480]
00:18.3 Host bridge [0600]: Advanced Micro Devices, Inc. [AMD] Matisse Device 24: Function 3 [1022:1443]
07:00.0 VGA compatible controller [0300]: ASPEED Technology, Inc. ASPEED Graphics Family [1a03:2000] (rev 41)`

const lspciAMDCPUWithRadeon = `00:00.0 Host bridge [0600]: Advanced Micro Devices, Inc. [AMD] Starship/Matisse Root Complex [1022:1480]
0a:00.0 VGA compatible controller [0300]: Advanced Micro Devices, Inc. [AMD/ATI] Navi 22 [Radeon RX 6700 XT] [1002:73df]`

const lspciIntelCPUWithNvidia = `00:00.0 Host bridge [0600]: Intel Corporation 8th Gen Core Processor Host Bridge [8086:3ec2]
01:00.0 VGA compatible controller [0300]: NVIDIA Corporation GA104 [GeForce RTX 3070] [10de:2484]`

const lspciAMDCPUHeadless = `00:00.0 Host bridge [0600]: Advanced Micro Devices, Inc. [AMD] Starship/Matisse Root Complex [1022:1480]
00:18.3 Host bridge [0600]: Advanced Micro Devices, Inc. [AMD] Matisse Device 24: Function 3 [1022:1443]`

func TestHasAMDDisplayDevice(t *testing.T) {
	cases := []struct {
		name  string
		lspci string
		want  bool
	}{
		{"AMD CPU, ASPEED BMC is the only display device", lspciAMDCPUWithBMCOnly, false},
		{"AMD CPU, headless, no display device at all", lspciAMDCPUHeadless, false},
		{"Intel CPU with an NVIDIA card", lspciIntelCPUWithNvidia, false},
		{"AMD CPU with a real Radeon", lspciAMDCPUWithRadeon, true},
		{"empty output", "", false},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := hasAMDDisplayDevice(c.lspci); got != c.want {
				t.Fatalf("hasAMDDisplayDevice = %v, want %v", got, c.want)
			}
		})
	}
}

// An AMD audio or host-bridge device must not stand in for a GPU. This is the
// specific confusion the old whole-output search could not avoid.
func TestHasAMDDisplayDevice_NonGraphicsAMDDevicesDoNotCount(t *testing.T) {
	lspci := `00:00.0 Host bridge [0600]: Advanced Micro Devices, Inc. [AMD] Starship/Matisse Root Complex [1022:1480]
0a:00.1 Audio device [0403]: Advanced Micro Devices, Inc. [AMD/ATI] Navi 21 HDMI Audio [1002:ab28]
07:00.0 VGA compatible controller [0300]: ASPEED Technology, Inc. ASPEED Graphics Family [1a03:2000]`

	if hasAMDDisplayDevice(lspci) {
		t.Fatal("an AMD audio device was counted as a display adapter")
	}
}

// Older lspci labels Radeon parts differently; long-lived installs still show
// these forms.
func TestHasAMDDisplayDevice_LegacyVendorSpellings(t *testing.T) {
	for _, line := range []string{
		"01:00.0 VGA compatible controller: ATI Technologies Inc RV770 [Radeon HD 4850]",
		"01:00.0 Display controller: Advanced Micro Devices, Inc. [AMD/ATI] Cezanne",
		"01:00.0 3D controller: Advanced Micro Devices, Inc. [AMD/ATI] Lexa PRO",
	} {
		if !hasAMDDisplayDevice(line) {
			t.Fatalf("missed an AMD display device: %q", line)
		}
	}
}

// `ffmpeg -encoders` lines are "<flags> <name> <description>", and the
// descriptions name other codecs freely. A substring search over the output
// would match almost anything — including the encoder we are trying to rule
// out, which is exactly the case that must not produce a false positive.
const ffmpegEncodersNoAMF = ` V....D av1_nvenc            NVIDIA NVENC av1 encoder (codec av1)
 V..... av1_qsv              AV1 (Intel Quick Sync Video acceleration) (codec av1)
 V....D h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)
 V....D h264_vaapi           H.264/AVC (VAAPI) (codec h264)
 V..... h264_qsv             H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (Intel Quick Sync Video acceleration) (codec h264)
 V....D hevc_vaapi           H.265/HEVC (VAAPI) (codec hevc)`

func TestEncoderListed(t *testing.T) {
	cases := []struct {
		name string
		want bool
	}{
		{"h264_vaapi", true},
		{"h264_nvenc", true},
		{"hevc_vaapi", true},
		// The box that started this: FFmpeg has no AMF encoder at all.
		{"h264_amf", false},
		{"hevc_amf", false},
		// A prefix of a listed name must not match.
		{"h264", false},
		{"", false},
	}

	for _, c := range cases {
		if got := encoderListed(ffmpegEncodersNoAMF, c.name); got != c.want {
			t.Fatalf("encoderListed(%q) = %v, want %v", c.name, got, c.want)
		}
	}
}

// A description mentioning an encoder's name must not be mistaken for the
// encoder being present.
func TestEncoderListed_DescriptionsDoNotCount(t *testing.T) {
	out := " V..... something_else    Wraps h264_amf when available (codec h264)"
	if encoderListed(out, "h264_amf") {
		t.Fatal("matched an encoder named only in another entry's description")
	}
	if !strings.Contains(out, "h264_amf") {
		t.Fatal("fixture no longer exercises the case it was written for")
	}
}
