// Package skipmarkers implements Smart Skip: offline detection of
// intro / recap / credits windows for the player's "Skip Intro" button
// and credits-triggered auto-advance.
//
// Detection is deterministic and fully local (no ML, no cloud calls):
//
//   - Intros/recaps: within one season the intro theme is (near-)
//     identical audio across episodes. Each episode's opening minutes
//     are decoded to a compact spectral fingerprint (signature.go) and
//     consecutive episodes are cross-correlated (align.go); the shared
//     window IS the intro. Validated across >=2 episode pairs before
//     any marker is stored (analyze.go).
//   - Credits: black-frame + audio-silence onset detection over the
//     file's tail via FFmpeg blackdetect/silencedetect (credits.go).
//
// The background worker (worker.go) mirrors the embedding backfill's
// posture: sequential, resumable, versioned via the Detector string,
// and never competing with live transcodes (one niced FFmpeg at a
// time).
package skipmarkers

import (
	"math"
	"math/bits"
	"sync"
)

// Fingerprint parameters. The signature is a Haitsma–Kalker-style
// robust audio hash: 32 bits per frame, each bit the sign of the
// band-energy difference along both the frequency and time axes. It is
// invariant to volume and codec noise — exactly the robustness needed
// to match the "same" intro audio across two differently-encoded
// episode files.
//
// Do not change these without bumping Detector (worker.go): stored
// markers stay valid, but signatures computed with different
// parameters are not comparable.
const (
	sigSampleRate = 16000 // mono PCM decode rate (Hz)
	sigFrameSize  = 4096  // FFT frame: 256 ms at 16 kHz
	sigHopSize    = 1024  // hop: 64 ms -> 15.625 signature frames/sec
	sigBands      = 33    // log-spaced energy bands -> 32 hash bits
	sigBandMinHz  = 300.0 // Haitsma–Kalker's perceptually relevant range
	sigBandMaxHz  = 2000.0
)

// sigFramesPerSec is the signature frame rate (frames per second).
const sigFramesPerSec = float64(sigSampleRate) / float64(sigHopSize)

// sigFrameToMs converts a signature frame index to source milliseconds.
func sigFrameToMs(frame int) int64 {
	return int64(math.Round(float64(frame) * 1000.0 / sigFramesPerSec))
}

// hannWindow / bandEdges are fixed for the package lifetime; computed
// once on first signature.
var (
	sigInitOnce sync.Once
	hannWindow  []float64
	bandEdges   []int // sigBands+1 FFT-bin boundaries
	twiddleCos  []float64
	twiddleSin  []float64
)

func sigInit() {
	sigInitOnce.Do(func() {
		hannWindow = make([]float64, sigFrameSize)
		for i := range hannWindow {
			hannWindow[i] = 0.5 - 0.5*math.Cos(2*math.Pi*float64(i)/float64(sigFrameSize-1))
		}

		// Geometrically spaced band boundaries between sigBandMinHz and
		// sigBandMaxHz, expressed as FFT bin indices. Strictly
		// increasing by construction for these constants (ratio per
		// band ≈ 1.059, > one bin width of ~3.9 Hz at 300 Hz).
		bandEdges = make([]int, sigBands+1)
		ratio := sigBandMaxHz / sigBandMinHz
		for i := 0; i <= sigBands; i++ {
			f := sigBandMinHz * math.Pow(ratio, float64(i)/float64(sigBands))
			bin := int(f * float64(sigFrameSize) / float64(sigSampleRate))
			if i > 0 && bin <= bandEdges[i-1] {
				bin = bandEdges[i-1] + 1
			}
			bandEdges[i] = bin
		}

		// Twiddle factors for the radix-2 FFT (half-size table).
		twiddleCos = make([]float64, sigFrameSize/2)
		twiddleSin = make([]float64, sigFrameSize/2)
		for i := 0; i < sigFrameSize/2; i++ {
			angle := -2 * math.Pi * float64(i) / float64(sigFrameSize)
			twiddleCos[i] = math.Cos(angle)
			twiddleSin[i] = math.Sin(angle)
		}
	})
}

// fftInPlace runs an iterative radix-2 Cooley–Tukey FFT over re/im.
// len(re) must equal sigFrameSize (a power of two); the twiddle table
// is sized for exactly that length.
func fftInPlace(re, im []float64) {
	n := len(re)
	// Bit-reversal permutation.
	for i, j := 1, 0; i < n; i++ {
		bit := n >> 1
		for ; j&bit != 0; bit >>= 1 {
			j ^= bit
		}
		j |= bit
		if i < j {
			re[i], re[j] = re[j], re[i]
			im[i], im[j] = im[j], im[i]
		}
	}
	for size := 2; size <= n; size <<= 1 {
		half := size >> 1
		step := n / size // twiddle stride
		for start := 0; start < n; start += size {
			k := 0
			for off := start; off < start+half; off++ {
				c, s := twiddleCos[k], twiddleSin[k]
				tr := re[off+half]*c - im[off+half]*s
				ti := re[off+half]*s + im[off+half]*c
				re[off+half] = re[off] - tr
				im[off+half] = im[off] - ti
				re[off] += tr
				im[off] += ti
				k += step
			}
		}
	}
}

// ComputeSignature converts mono 16 kHz PCM into the per-frame 32-bit
// fingerprint stream. Returns nil when the clip is too short to
// produce even one hash frame (needs two FFT frames).
func ComputeSignature(samples []int16) []uint32 {
	sigInit()
	if len(samples) < sigFrameSize+sigHopSize {
		return nil
	}
	nFrames := (len(samples)-sigFrameSize)/sigHopSize + 1

	re := make([]float64, sigFrameSize)
	im := make([]float64, sigFrameSize)
	prevE := make([]float64, sigBands)
	curE := make([]float64, sigBands)

	sig := make([]uint32, 0, nFrames-1)
	for f := 0; f < nFrames; f++ {
		off := f * sigHopSize
		for i := 0; i < sigFrameSize; i++ {
			re[i] = float64(samples[off+i]) * hannWindow[i]
			im[i] = 0
		}
		fftInPlace(re, im)
		for b := 0; b < sigBands; b++ {
			var e float64
			for bin := bandEdges[b]; bin < bandEdges[b+1]; bin++ {
				e += re[bin]*re[bin] + im[bin]*im[bin]
			}
			curE[b] = e
		}
		if f > 0 {
			var word uint32
			for b := 0; b < sigBands-1; b++ {
				// Sign of the energy difference along frequency AND
				// time: robust to overall loudness and gentle EQ.
				if (curE[b]-curE[b+1])-(prevE[b]-prevE[b+1]) > 0 {
					word |= 1 << uint(b)
				}
			}
			sig = append(sig, word)
		}
		prevE, curE = curE, prevE
	}
	return sig
}

// hammingDist32 is the bit distance between two signature frames.
func hammingDist32(a, b uint32) int {
	return bits.OnesCount32(a ^ b)
}
