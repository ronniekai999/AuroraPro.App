package streaming

import (
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"testing"
)

// TestPlaybackMatrix_DownmixFoldsIntegerSourcesInFloat pins downmixFloat, the
// `aformat=sample_fmts=fltp` that opens every non-legacy chain.
//
// `pan` folds in the SOURCE sample format with no auto-rescale, so on an
// integer-decoded source (PCM, FLAC, DTS-HD MA, TrueHD, ALAC) the summed overs
// of a hot passage saturate inside pan, and the limiter after it politely
// trims an already hard-clipped square wave to its ceiling (fourth review,
// measured). The peak alone cannot tell the two apart — both land at
// -0.175 dB — so this measures the CREST FACTOR (peak minus RMS): a limited
// sine keeps ~3 dB, a clipped one has ~1 dB. Measured on ffmpeg 7.0.2 with the
// exact chains: standard with the prefix -0.18 / -3.21 dB (crest 3.03), the
// same chain without it -0.18 / -1.17 dB (crest 0.99).
//
// The night policy ends in dynaudnorm rather than the limiter, whose gain
// smoothing already lowers the crest of a clean fold (2.1 dB against 1.8
// clipped — too close to pin); its prefix is pinned by the argument test.
func TestPlaybackMatrix_DownmixFoldsIntegerSourcesInFloat(t *testing.T) {
	requireFFmpeg(t)

	// FL, FC and BL at 0.9 in phase, LFE silent, on a 16-bit source: the
	// ITU fold sums to 2.17 (+6.7 dBFS), well past full scale.
	src := filepath.Join(t.TempDir(), "hot51.wav")
	gen := exec.Command("ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
		"-f", "lavfi", "-i", "aevalsrc=exprs='0.9*sin(2*PI*440*t)|0.9*sin(2*PI*440*t)|0.9*sin(2*PI*440*t)|0|0.9*sin(2*PI*440*t)|0.9*sin(2*PI*440*t)':channel_layout=5.1:sample_rate=48000:duration=1",
		"-c:a", "pcm_s16le", src)
	if out, err := gen.CombinedOutput(); err != nil {
		t.Fatalf("build hot 5.1 source: %v\n%s", err, out)
	}

	peakRe := regexp.MustCompile(`Peak level dB: (-?[0-9.]+)`)
	rmsRe := regexp.MustCompile(`RMS level dB: (-?[0-9.]+)`)
	measure := func(chain string) (peak, rms float64) {
		t.Helper()
		af := chain + ",astats=measure_perchannel=none:measure_overall=Peak_level+RMS_level"
		out, err := exec.Command("ffmpeg", "-hide_banner", "-nostats", "-i", src, "-af", af, "-f", "null", "-").CombinedOutput()
		if err != nil {
			t.Fatalf("ffmpeg -af %q: %v\n%s", af, err, out)
		}
		pm, rm := peakRe.FindSubmatch(out), rmsRe.FindSubmatch(out)
		if pm == nil || rm == nil {
			t.Fatalf("astats printed no overall peak/RMS for %q:\n%s", af, out)
		}
		peak, _ = strconv.ParseFloat(string(pm[1]), 64)
		rms, _ = strconv.ParseFloat(string(rm[1]), 64)
		return peak, rms
	}

	for _, policy := range []StereoDownmix{DownmixStandard, DownmixDialogue} {
		chain := stereoDownmixFilter(policy, 6)
		peak, rms := measure(chain)
		if peak > -0.1 {
			t.Errorf("%s: peak %.2f dB, want the limiter's ceiling (<= -0.1 dB) — chain %q", policy, peak, chain)
		}
		if crest := peak - rms; crest < 2.5 {
			t.Errorf("%s: crest factor %.2f dB (peak %.2f, RMS %.2f) — the fold clipped before the limiter; chain %q",
				policy, crest, peak, rms, chain)
		}
	}
}
