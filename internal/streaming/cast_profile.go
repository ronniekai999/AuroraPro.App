package streaming

import (
	"context"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
)

// A conservative output for receivers that support H.264 up to 1080p30.
// SourceFPS remains a source fact; only a cast copy drops excess frames.
const castMaxFPS = 30.0

func castOutputFPS(sourceFPS float64) float64 {
	if sourceFPS <= 0 || math.IsNaN(sourceFPS) || math.IsInf(sourceFPS, 0) || sourceFPS > castMaxFPS {
		return castMaxFPS
	}
	return sourceFPS
}

// H.264 High-profile Annex A limits. Use width as well as height: a tall
// source or a wide crop can require a different level than its rung label.
func castH264Level(p QualityProfile, fps float64) (int, bool) {
	maxRate, rateOK := parseBitrateSpec(p.MaxRate)
	buffer, bufferOK := parseBitrateSpec(p.BufSize)
	if p.Width <= 0 || p.Height <= 0 || p.Width > 1920 || p.Height > 1080 ||
		fps <= 0 || fps > castMaxFPS || math.IsNaN(fps) || !rateOK || !bufferOK {
		return 0, false
	}
	frameMB := ((p.Width + 15) / 16) * ((p.Height + 15) / 16)
	for _, l := range []struct {
		idc, frameMB, mbPerSec, maxRate, buffer int
	}{
		{31, 3600, 108000, 17_500_000, 17_500_000},
		{32, 5120, 216000, 25_000_000, 25_000_000},
		{40, 8192, 245760, 25_000_000, 31_250_000},
		{41, 8192, 245760, 62_500_000, 78_125_000},
	} {
		if frameMB <= l.frameMB && float64(frameMB)*fps <= float64(l.mbPerSec) &&
			maxRate <= l.maxRate && buffer <= l.buffer {
			return l.idc, true
		}
	}
	return 0, false
}

func resolveCastProfile(profiles []QualityProfile, sourceWidth, sourceHeight int, fps float64) (QualityProfile, error) {
	if sourceWidth <= 0 || sourceHeight <= 0 {
		return QualityProfile{}, fmt.Errorf("source dimensions are required for casting")
	}
	// Prefer the highest enabled rung within the receiver's width limit. A
	// configuration that enables only 4K still needs a supported cast output.
	p := AllProfiles["1080p"]
	for _, candidate := range profiles {
		if candidate.Width <= 1920 {
			p = candidate
			break
		}
	}
	width := min(p.Width, sourceWidth, 1920)
	if float64(width)*float64(sourceHeight)/float64(sourceWidth) > 1080 {
		width = int(1080 * float64(sourceWidth) / float64(sourceHeight))
	}
	p.Width = max(2, width&^1)
	p.Height = max(2, AdjustProfileHeight(p.Width, sourceWidth, sourceHeight))
	level, ok := castH264Level(p, fps)
	if !ok {
		return QualityProfile{}, fmt.Errorf("no supported cast profile for source %dx%d", sourceWidth, sourceHeight)
	}
	p.CastH264LevelIDC = level
	return p, nil
}

// Override only the cast encoder's level, keeping the hardware backend's
// required representation. VAAPI and QSV consume level_idc; other encoders
// accept the dotted level. CODECS uses this same idc.
func castEncoderArgs(args []string, p QualityProfile, fps float64, accel HWAccelType) []string {
	if p.CastH264LevelIDC == 0 {
		return args
	}
	level := fmt.Sprintf("%d.%d", p.CastH264LevelIDC/10, p.CastH264LevelIDC%10)
	if accel == HWAccelVAAPI || accel == HWAccelQSV {
		level = strconv.Itoa(p.CastH264LevelIDC)
	}
	profileSet := false
	for i := 0; i+1 < len(args); i++ {
		if args[i] == "-level" || args[i] == "-level:v" {
			args[i+1] = level
		}
		if args[i] == "-profile:v" {
			args[i+1] = "high"
			profileSet = true
		}
	}
	for i, arg := range args {
		for _, scale := range []string{"scale=", "scale_cuda="} {
			args[i] = strings.ReplaceAll(args[i], fmt.Sprintf("%s%d:-2", scale, p.Width), fmt.Sprintf("%s%d:%d", scale, p.Width, p.Height))
		}
		if strings.Contains(arg, "scale_vaapi=") {
			args[i] = strings.ReplaceAll(args[i], fmt.Sprintf("scale_vaapi=w=%d:h=-2", p.Width), fmt.Sprintf("scale_vaapi=w=%d:h=%d", p.Width, p.Height))
		}
	}
	if !profileSet {
		args = append(args, "-profile:v", "high")
	}
	return append(args, "-r:v", strconv.FormatFloat(fps, 'f', -1, 64))
}

// WarmCastSession finishes the one startup before the sender can issue LOAD.
// Removing all-rung pre-warm without this wait would expose the receiver to
// the cold-start recovery loop seen in #355. No browser ladder is modified.
func (tm *TranscodeManager) WarmCastSession(ctx context.Context, s *TranscodeSession) error {
	if len(s.Profiles) != 1 {
		return fmt.Errorf("cast session must have one quality profile")
	}
	v, err := tm.EnsureVariant(s, s.Profiles[0].Name, s.StartSec)
	if err != nil {
		return err
	}
	s.variantMu.Lock()
	ready := v.Ready
	s.variantMu.Unlock()
	// Leave room to write a useful failure inside the server's 120s deadline.
	timer := time.NewTimer(min(tm.readinessTimeout(s), 90*time.Second))
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return fmt.Errorf("cast stream not ready")
	case <-ready:
	}
	s.variantMu.Lock()
	err = v.Err
	s.variantMu.Unlock()
	if err != nil {
		return err
	}
	if _, ok := tm.GetSession(s.ID); !ok {
		return fmt.Errorf("cast session ended during startup")
	}
	return nil
}
