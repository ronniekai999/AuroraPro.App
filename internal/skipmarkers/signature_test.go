package skipmarkers

import (
	"math"
	"math/cmplx"
	"math/rand"
	"testing"
)

// naiveDFT is the textbook O(n²) reference the FFT must agree with.
func naiveDFT(in []complex128) []complex128 {
	n := len(in)
	out := make([]complex128, n)
	for k := 0; k < n; k++ {
		var sum complex128
		for t := 0; t < n; t++ {
			angle := -2 * math.Pi * float64(k) * float64(t) / float64(n)
			sum += in[t] * cmplx.Exp(complex(0, angle))
		}
		out[k] = sum
	}
	return out
}

func TestFFTMatchesNaiveDFT(t *testing.T) {
	sigInit()
	rng := rand.New(rand.NewSource(1))
	re := make([]float64, sigFrameSize)
	im := make([]float64, sigFrameSize)
	in := make([]complex128, sigFrameSize)
	for i := range re {
		re[i] = rng.Float64()*2 - 1
		in[i] = complex(re[i], 0)
	}
	fftInPlace(re, im)
	want := naiveDFT(in)

	// Compare a spread of bins (full comparison is fine too, but the
	// naive DFT already dominates the test's runtime).
	for _, k := range []int{0, 1, 7, 64, 1000, 2048, 4095} {
		if math.Abs(re[k]-real(want[k])) > 1e-6 || math.Abs(im[k]-imag(want[k])) > 1e-6 {
			t.Fatalf("bin %d: fft=(%g,%g) dft=(%g,%g)", k, re[k], im[k], real(want[k]), imag(want[k]))
		}
	}
}

func TestFFTImpulse(t *testing.T) {
	sigInit()
	re := make([]float64, sigFrameSize)
	im := make([]float64, sigFrameSize)
	re[0] = 1
	fftInPlace(re, im)
	// An impulse at t=0 transforms to a flat all-ones spectrum.
	for k := 0; k < sigFrameSize; k += 257 {
		if math.Abs(re[k]-1) > 1e-9 || math.Abs(im[k]) > 1e-9 {
			t.Fatalf("bin %d: got (%g,%g), want (1,0)", k, re[k], im[k])
		}
	}
}

// noisePCM produces deterministic full-band pseudo-noise — a stand-in
// for "music" with energy across all signature bands.
func noisePCM(rng *rand.Rand, n int) []int16 {
	out := make([]int16, n)
	for i := range out {
		out[i] = int16(rng.Intn(20000) - 10000)
	}
	return out
}

func TestComputeSignatureBasics(t *testing.T) {
	if got := ComputeSignature(make([]int16, sigFrameSize)); got != nil {
		t.Fatalf("too-short input should yield nil, got %d frames", len(got))
	}

	pcm := noisePCM(rand.New(rand.NewSource(2)), 30*sigSampleRate)
	sig1 := ComputeSignature(pcm)
	sig2 := ComputeSignature(pcm)
	wantFrames := (len(pcm)-sigFrameSize)/sigHopSize + 1 - 1
	if len(sig1) != wantFrames {
		t.Fatalf("signature length = %d, want %d", len(sig1), wantFrames)
	}
	for i := range sig1 {
		if sig1[i] != sig2[i] {
			t.Fatalf("signature not deterministic at frame %d", i)
		}
	}
}

// The end-to-end DSP property the whole feature rests on: the same
// audio embedded at different (hop-aligned) positions in two different
// streams produces signatures whose shared stretch cross-correlates at
// the correct lag.
func TestSignatureAlignmentEndToEnd(t *testing.T) {
	rng := rand.New(rand.NewSource(3))
	const (
		clipFrames = 320 // ~20.5 s shared "intro"
		offAFrames = 150 // ~9.6 s into stream A
		offBFrames = 400 // ~25.6 s into stream B
		totalSec   = 60
	)
	clip := noisePCM(rng, clipFrames*sigHopSize)
	a := noisePCM(rng, totalSec*sigSampleRate)
	b := noisePCM(rng, totalSec*sigSampleRate)
	copy(a[offAFrames*sigHopSize:], clip)
	copy(b[offBFrames*sigHopSize:], clip)

	wins := matchWindows(ComputeSignature(a), ComputeSignature(b))
	if len(wins) == 0 {
		t.Fatal("expected a shared window, found none")
	}
	w := wins[0]
	const tol = 8 // frames touching the splice boundary may mismatch
	if abs(w.aStart-offAFrames) > tol || abs(w.bStart-offBFrames) > tol {
		t.Fatalf("window at aStart=%d bStart=%d, want ~%d/~%d", w.aStart, w.bStart, offAFrames, offBFrames)
	}
	if abs(w.frames()-clipFrames) > 2*tol {
		t.Fatalf("window length %d frames, want ~%d", w.frames(), clipFrames)
	}

	// Unrelated streams must NOT correlate.
	c := noisePCM(rng, totalSec*sigSampleRate)
	if wins := matchWindows(ComputeSignature(a[:30*sigSampleRate]), ComputeSignature(c[:30*sigSampleRate])); len(wins) != 0 {
		t.Fatalf("unrelated audio produced %d phantom windows: %+v", len(wins), wins[0])
	}
}
