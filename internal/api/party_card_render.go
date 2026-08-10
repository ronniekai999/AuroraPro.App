package api

import (
	"bytes"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"math"
	"strings"

	xdraw "golang.org/x/image/draw"
	"golang.org/x/image/font"
	"golang.org/x/image/math/fixed"
)

// ============================================================
// Watch-party share card — the compositor
// ============================================================
//
// Renders the card described by
// docs/proposals/watch-party-share-card/mockup-share-card.html. Every
// length below is copied out of a `.card-story` CSS block: the mockup
// builds the card at TRUE output pixels and scales it down for review, so
// the stylesheet doubles as this file's layout spec.
//
// Structure, so Phase 2 can bolt `square` and `og` on without touching
// the primitives:
//
//   CardVariant     — the enum. One value today.
//   cardLayout      — the per-variant geometry table (storyLayout below).
//   composeCard()   — the single entry point: (variant, data) → PNG bytes.
//                     Dispatches to a per-variant painter after laying
//                     down the shared scene (ground, curtain, stars).
//
// A new variant is a new cardLayout value, a new painter, and one case in
// composeCard. Nothing else here is story-specific.

// CardVariant names one crop of the share-card composition.
type CardVariant string

const (
	// CardVariantStory is the 1080×1920 Stories/TikTok crop — the one
	// people post, and the only variant Phase 1 renders.
	CardVariantStory CardVariant = "story"
)

// cardBand is one blurred, rotated gradient band of the aurora curtain.
// Fields mirror the CSS one-for-one: an absolutely-positioned element
// with border-radius:50% (hence an ellipse), a rotation about its own
// centre, and a `filter: blur(<Blur>px)` whose argument is the Gaussian
// standard deviation.
type cardBand struct {
	W, H       int
	Left, Top  int
	RotateDeg  float64
	BlurSigma  float64
	Opacity    float64
	GradientAt float64 // CSS gradient angle across the band's own box
}

// cardLayout is the per-variant geometry table. Everything a painter
// needs to place a pixel lives here so the numbers can be diffed against
// the mockup without reading the drawing code.
type cardLayout struct {
	Variant       CardVariant
	Width, Height int

	PadTop, PadX, PadBottom int

	Bands      []cardBand
	Stars      int
	StarLayerA float64
	GrainAlpha float64

	// Type scale. Track values are CSS `em` fractions; the painter
	// multiplies by the size in px.
	BrandSize, BrandTrack  float64
	BrandGap, BrandDiamond int
	BrandLineH             float64
	PosterW, PosterH       int
	PosterRadius           float64
	PosterMarginTop        int
	TitleSize, TitleTrack  float64
	TitleLineH             float64
	TitleMinSize           float64
	TitleMarginTop         int
	TitleMaxLines          int
	MetaSize, MetaTrack    float64
	MetaLineH              float64
	MetaMarginTop          int
	DividerW, DividerH     int
	DividerMarginTop       int
	DateSize, DateTrack    float64
	DateLineH              float64
	DateMarginTop          int
	TimeSize, TimeTrack    float64
	TimeLineH              float64
	TimeMarginTop          int
	HostGap, HostMarginTop int
	AvatarSize             int
	AvatarInitialSize      float64
	HostNameSize           float64
	HostNameLineH          float64
	TaglineSize            float64
	TaglineLineH           float64
	TaglineMarginTop       int
	TaglineShear           float64
	JoinH                  int
	JoinRadius             float64
	JoinPadX               int
	JoinLabelSize          float64
	JoinLabelTrack         float64
	JoinLabelLineH         float64
	JoinCodeSize           float64
	JoinCodeTrack          float64
	JoinCodeLineH          float64
	JoinCodeMarginTop      int
	QRSize                 int
	QRQuiet                int
	QRRadius               float64
	MinBottomPad           int
	CurtainScale           int
	CurtainPad             int
	PosterBloomBlur        float64
	PosterBloomDY          int
	PosterBloomSpread      int
	TimeShadowBlur         float64
	TimeShadowDY           int
	AvatarGlowBlur         float64
	AvatarGlowDY           int
	AvatarRing             int
}

// storyLayout is the 1080×1920 table, transcribed from `.card-story`.
var storyLayout = cardLayout{
	Variant: CardVariantStory,
	Width:   1080,
	Height:  1920,

	PadTop:    92,
	PadX:      80,
	PadBottom: 56,

	Bands: []cardBand{
		{W: 1780, H: 560, Left: -360, Top: 190, RotateDeg: -15, BlurSigma: 130, Opacity: 0.60, GradientAt: 100},
		{W: 1500, H: 420, Left: -180, Top: 880, RotateDeg: 9, BlurSigma: 150, Opacity: 0.34, GradientAt: 100},
		{W: 1200, H: 340, Left: 120, Top: 1520, RotateDeg: -6, BlurSigma: 160, Opacity: 0.26, GradientAt: 100},
	},
	Stars:      16,
	StarLayerA: 0.72,
	GrainAlpha: 0.16,

	BrandSize:    30,
	BrandTrack:   0.42,
	BrandGap:     18,
	BrandDiamond: 16,
	BrandLineH:   1.6,

	PosterW:         566,
	PosterH:         850,
	PosterRadius:    26,
	PosterMarginTop: 70,

	TitleSize:      74,
	TitleTrack:     -0.03,
	TitleLineH:     1.04,
	TitleMinSize:   50,
	TitleMarginTop: 56,
	TitleMaxLines:  2,

	MetaSize:      29,
	MetaTrack:     0.04,
	MetaLineH:     1.6,
	MetaMarginTop: 22,

	DividerW:         300,
	DividerH:         3,
	DividerMarginTop: 52,

	DateSize:      34,
	DateTrack:     0.24,
	DateLineH:     1.6,
	DateMarginTop: 38,

	TimeSize:      118,
	TimeTrack:     -0.028,
	TimeLineH:     0.94,
	TimeMarginTop: 20,

	HostGap:           22,
	HostMarginTop:     40,
	AvatarSize:        76,
	AvatarInitialSize: 34,
	HostNameSize:      34,
	HostNameLineH:     1.6,

	TaglineSize:      27,
	TaglineLineH:     1.6,
	TaglineMarginTop: 18,
	TaglineShear:     0.21, // ~12° oblique — Inter ships no italic in our static set

	JoinH:             168,
	JoinRadius:        30,
	JoinPadX:          36,
	JoinLabelSize:     22,
	JoinLabelTrack:    0.26,
	JoinLabelLineH:    1.6,
	JoinCodeSize:      62,
	JoinCodeTrack:     0.12,
	JoinCodeLineH:     1.6,
	JoinCodeMarginTop: 8,
	QRSize:            116,
	// QRQuiet is the light margin inside the plate. The QR standard wants
	// a 4-module quiet zone; at this symbol size 8px is ~2.5 modules,
	// which every scanner I could throw at it accepts and which keeps the
	// footprint at the spec's 116px.
	QRQuiet:  8,
	QRRadius: 8,

	// MinBottomPad is the floor the join bar may never cross. The flow
	// compresses its margins rather than push the CTA past this.
	MinBottomPad: 24,
	CurtainScale: 8,
	CurtainPad:   64,

	PosterBloomBlur:   70, // CSS box-shadow blur 140px = 2σ
	PosterBloomDY:     60,
	PosterBloomSpread: -30,

	TimeShadowBlur: 22, // drop-shadow blur 44px = 2σ
	TimeShadowDY:   10,

	AvatarGlowBlur: 14, // box-shadow blur 28px = 2σ
	AvatarGlowDY:   8,
	AvatarRing:     3,
}

// cardLayoutFor resolves a variant to its table. Unknown variants are a
// miss, not a default — the image route turns that into a 404 rather than
// silently serving the wrong crop.
func cardLayoutFor(v CardVariant) (*cardLayout, bool) {
	switch v {
	case CardVariantStory:
		return &storyLayout, true
	default:
		return nil, false
	}
}

// cardData is everything the painter draws, already resolved: no DB
// handles, no *http.Request, no clock. Building it is the handler's job
// (buildCardData), which keeps the compositor pure and unit-testable.
type cardData struct {
	Code        string
	MediaTitle  string
	MetaLine    string // "2022 · Action Adventure · 2h 27m" — may be empty
	DateCaps    string // "Saturday, August 15" — empty for an unscheduled party
	TimeText    string // "8:00 PM EDT" — empty for an unscheduled party
	HostName    string
	HostInitial string
	Tagline     string
	JoinLabel   string // "Join at aurorapro.app"
	JoinURL     string // QR payload — absolute https://host/join/CODE
	Poster      image.Image
	HostAvatar  image.Image
	Seed        uint32
}

// Gradient recipes, straight from the stylesheet.
var (
	// .aurora-ring sweep — the curtain bands.
	curtainStops = []gradStop{
		stopA(0, tokenViolet, 0.95),
		stopA(0.46, tokenIndigo, 0.60),
		stopA(1, tokenCyan, 0.85),
	}
	// .brandline .word
	brandStops = []gradStop{
		stop(0, tokenLilac),
		stop(0.42, tokenViolet),
		stop(1, tokenCyan),
	}
	// .time — the eye magnet.
	timeStops = []gradStop{
		stop(0, 0xFFFFFF),
		stop(0.30, tokenLilac),
		stop(0.62, tokenViolet),
		stop(1, tokenCyan),
	}
	// .divider — fades to transparent at both ends.
	dividerStops = []gradStop{
		stopA(0, tokenViolet, 0),
		stop(1.0/3.0, tokenViolet),
		stop(2.0/3.0, tokenCyan),
		stopA(1, tokenCyan, 0),
	}
	// .avatar background
	avatarStops = []gradStop{
		stop(0, tokenVioletDp),
		stop(0.45, tokenViolet),
		stop(1, tokenCyan),
	}
	// .joinbar background
	joinBarStops = []gradStop{
		gradStop{Offset: 0, R: 28, G: 25, B: 42, A: 0.78},
		gradStop{Offset: 1, R: 14, G: 12, B: 22, A: 0.92},
	}
	// .brandline .diamond
	diamondStops = []gradStop{
		stop(0, tokenLilac),
		stop(1, tokenCyan),
	}
)

// composeCard renders one card to PNG bytes. This is the entry point
// Phase 2 extends: add a CardVariant, a cardLayout, and a case here.
func composeCard(v CardVariant, d cardData) ([]byte, error) {
	layout, ok := cardLayoutFor(v)
	if !ok {
		return nil, fmt.Errorf("unknown card variant %q", v)
	}
	lib, err := cardFonts()
	if err != nil {
		return nil, fmt.Errorf("load card fonts: %w", err)
	}

	dst := image.NewRGBA(image.Rect(0, 0, layout.Width, layout.Height))
	// 1. Ground.
	draw.Draw(dst, dst.Bounds(), &image.Uniform{C: hexRGBA(tokenInk, 1)}, image.Point{}, draw.Src)
	// 2. Aurora curtain.
	drawCurtain(dst, layout)
	// 3. Starfield.
	drawStars(dst, layout, d.Seed)

	// 4-6. Variant content.
	switch layout.Variant {
	case CardVariantStory:
		if err := paintStory(dst, layout, lib, d); err != nil {
			return nil, err
		}
	default:
		return nil, fmt.Errorf("no painter for card variant %q", layout.Variant)
	}

	// 7. Grain, last, over everything.
	applyGrain(dst, layout.GrainAlpha, d.Seed^0x5EED)

	var buf bytes.Buffer
	if err := png.Encode(&buf, dst); err != nil {
		return nil, fmt.Errorf("encode png: %w", err)
	}
	return buf.Bytes(), nil
}

// ── Shared scene ────────────────────────────────────────────────────

// drawCurtain paints the three blurred bands. The whole layer is built at
// 1/8 scale and upsampled: a σ=130px blur at full resolution is ~30× the
// work for no visible difference once the result is a soft wash. The
// small canvas is padded so bands that start off-card (left:-360) still
// bleed inward correctly.
func drawCurtain(dst *image.RGBA, L *cardLayout) {
	s := L.CurtainScale
	pad := L.CurtainPad
	sw := L.Width/s + 2*pad
	sh := L.Height/s + 2*pad
	acc := image.NewRGBA(image.Rect(0, 0, sw, sh))

	for _, band := range L.Bands {
		layer := image.NewRGBA(image.Rect(0, 0, sw, sh))
		// Ellipse geometry in small-canvas coordinates.
		cx := float64(band.Left+band.W/2)/float64(s) + float64(pad)
		cy := float64(band.Top+band.H/2)/float64(s) + float64(pad)
		ax := float64(band.W) / float64(2*s)
		ay := float64(band.H) / float64(2*s)
		th := band.RotateDeg * math.Pi / 180
		cosT, sinT := math.Cos(th), math.Sin(th)

		// Gradient line across the band's own (unrotated) box.
		gth := band.GradientAt * math.Pi / 180
		gsin, gcos := math.Sin(gth), math.Cos(gth)
		glen := math.Abs(2*ax*gsin) + math.Abs(2*ay*gcos)
		if glen <= 0 {
			glen = 1
		}

		var ramp [256]color.RGBA
		for i := range ramp {
			c := sampleStops(curtainStops, float64(i)/255)
			// Fold the band's CSS opacity into the premultiplied colour.
			ramp[i] = color.RGBA{
				R: uint8(float64(c.R)*band.Opacity + 0.5),
				G: uint8(float64(c.G)*band.Opacity + 0.5),
				B: uint8(float64(c.B)*band.Opacity + 0.5),
				A: uint8(float64(c.A)*band.Opacity + 0.5),
			}
		}

		// Bound the scan to the rotated ellipse's AABB.
		rx := math.Abs(ax*cosT) + math.Abs(ay*sinT)
		ry := math.Abs(ax*sinT) + math.Abs(ay*cosT)
		x0 := clampInt(int(cx-rx)-1, 0, sw)
		x1 := clampInt(int(cx+rx)+2, 0, sw)
		y0 := clampInt(int(cy-ry)-1, 0, sh)
		y1 := clampInt(int(cy+ry)+2, 0, sh)

		for y := y0; y < y1; y++ {
			row := layer.Pix[y*layer.Stride:]
			dy := float64(y) + 0.5 - cy
			for x := x0; x < x1; x++ {
				dx := float64(x) + 0.5 - cx
				// Inverse-rotate into band-local space.
				lx := dx*cosT + dy*sinT
				ly := -dx*sinT + dy*cosT
				if (lx*lx)/(ax*ax)+(ly*ly)/(ay*ay) > 1 {
					continue
				}
				t := (lx*gsin-ly*gcos)/glen + 0.5
				idx := clampInt(int(t*255+0.5), 0, 255)
				c := ramp[idx]
				o := x * 4
				row[o], row[o+1], row[o+2], row[o+3] = c.R, c.G, c.B, c.A
			}
		}

		blurred := blurRGBA(layer, band.BlurSigma/float64(s))
		draw.Draw(acc, acc.Bounds(), blurred, image.Point{}, draw.Over)
	}

	// Upsample only the card's window of the padded canvas.
	src := image.Rect(pad, pad, pad+L.Width/s, pad+L.Height/s)
	xdraw.CatmullRom.Scale(dst, dst.Bounds(), acc, src, draw.Over, nil)
}

// starPalette matches the speck colours in `.stars`.
var starPalette = []uint32{0xFFFFFF, tokenStarViol, 0xFFFFFF, tokenStarCyan, 0xFFFFFF, tokenStarLilac}

// drawStars scatters specks from a PRNG seeded on the party code, so one
// party's card is byte-stable across re-renders while two parties differ.
func drawStars(dst *image.RGBA, L *cardLayout, seed uint32) {
	st := seed | 1
	next := func() uint32 {
		// xorshift32 — tiny, deterministic, good enough for confetti.
		st ^= st << 13
		st ^= st >> 17
		st ^= st << 5
		return st
	}
	for i := 0; i < L.Stars; i++ {
		x := int(next() % uint32(L.Width))
		y := int(next() % uint32(L.Height))
		hex := starPalette[int(next())%len(starPalette)]
		radius := 2.0
		if next()%2 == 0 {
			radius = 2.6
		}
		drawSpeck(dst, x, y, radius, hex, L.StarLayerA)
	}
}

// drawSpeck paints one soft dot: linear falloff to transparent, exactly
// what `radial-gradient(2px 2px at …, #fff, transparent)` produces.
func drawSpeck(dst *image.RGBA, cx, cy int, radius float64, hex uint32, layerAlpha float64) {
	r := int(math.Ceil(radius))
	for y := cy - r; y <= cy+r; y++ {
		if y < dst.Rect.Min.Y || y >= dst.Rect.Max.Y {
			continue
		}
		for x := cx - r; x <= cx+r; x++ {
			if x < dst.Rect.Min.X || x >= dst.Rect.Max.X {
				continue
			}
			d := math.Hypot(float64(x-cx), float64(y-cy))
			if d > radius {
				continue
			}
			a := (1 - d/radius) * layerAlpha
			draw.Draw(dst, image.Rect(x, y, x+1, y+1),
				&image.Uniform{C: hexRGBA(hex, a)}, image.Point{}, draw.Over)
		}
	}
}

// ── Text helpers ────────────────────────────────────────────────────

// em converts a CSS em-fraction of tracking into 26.6 fixed pixels.
func em(fraction, sizePx float64) fixed.Int26_6 {
	return fixed.Int26_6(math.Round(fraction * sizePx * 64))
}

// runW measures a run at the resolved face.
func runW(fs *faceSet, s string, track fixed.Int26_6) int {
	return runAdvance(fs.resolve(s), s, track).Ceil()
}

// baselineIn returns the offset from the top of a CSS line box of height
// lineH to the text baseline (half-leading + ascent).
func baselineIn(f font.Face, lineH float64) int {
	m := f.Metrics()
	asc := float64(m.Ascent) / 64
	desc := float64(m.Descent) / 64
	return int(math.Round((lineH-(asc+desc))/2 + asc))
}

// drawRun paints a flat-coloured run with its first glyph's pen at penX
// and its baseline on baseY.
func drawRun(dst draw.Image, fs *faceSet, s string, track fixed.Int26_6, penX, baseY int, c color.Color) {
	if s == "" {
		return
	}
	mask, padX, baseline, _ := textMask(fs.resolve(s), s, track)
	drawMaskUniform(dst, mask, c, penX-padX, baseY-baseline)
}

// drawRunGradient paints a run filled with a CSS linear-gradient, with an
// optional drop shadow underneath. The gradient's geometry is computed
// over the run's own box (advance × line height), not over the padded
// mask, so the stops land where the stylesheet puts them.
func drawRunGradient(dst draw.Image, fs *faceSet, s string, track fixed.Int26_6, penX, baseY int,
	angle float64, stops []gradStop, lineH float64, shadowSigma float64, shadowDY int, shadowColor color.Color) {
	if s == "" {
		return
	}
	face := fs.resolve(s)
	mask, padX, baseline, adv := textMask(face, s, track)
	x0, y0 := penX-padX, baseY-baseline

	if shadowSigma > 0 {
		sh, off := blurAlphaPadded(mask, shadowSigma)
		drawMaskUniform(dst, sh, shadowColor, x0-off, y0+shadowDY-off)
	}

	b := mask.Bounds()
	top := baseline - baselineIn(face, lineH)
	box := image.Rect(padX, top, padX+adv, top+int(math.Round(lineH)))
	grad := renderGradient(b.Dx(), b.Dy(), box, angle, stops)
	drawMaskAt(dst, mask, grad, x0, y0)
}

// truncateToWidth trims a run to fit maxW, appending an ellipsis. It
// iterates over RUNES: byte-slicing multi-byte UTF-8 leaves a partial
// codepoint at the boundary, which the rasteriser paints as a tofu box.
// Same contract as drawCenteredText in party_share.go.
func truncateToWidth(fs *faceSet, s string, track fixed.Int26_6, maxW int) string {
	if runW(fs, s, track) <= maxW {
		return s
	}
	runes := []rune(s)
	display := s
	for runW(fs, display, track) > maxW && len(runes) > 1 {
		runes = runes[:len(runes)-1]
		display = strings.TrimRight(string(runes), " ") + "…"
	}
	return display
}

// wrapTitle lays the media title out in at most maxLines, shrinking the
// face before it will truncate. Word-wrapped at the split that most
// evenly balances the two lines — a title breaking as "Jurassic World /
// Dominion" reads better than "Jurassic / World Dominion".
func wrapTitle(lib *cardFontLibrary, L *cardLayout, title string, maxW int) ([]string, *faceSet, float64, error) {
	size := L.TitleSize
	for {
		fs, err := lib.face(roleDisplayExtraBold, size)
		if err != nil {
			return nil, nil, 0, err
		}
		track := em(L.TitleTrack, size)
		if runW(fs, title, track) <= maxW {
			return []string{title}, fs, size, nil
		}
		if L.TitleMaxLines >= 2 {
			if a, b, ok := splitBalanced(fs, title, track, maxW); ok {
				return []string{a, b}, fs, size, nil
			}
		}
		if size-6 < L.TitleMinSize {
			// Out of room: set at the floor and truncate the tail.
			fs, err := lib.face(roleDisplayExtraBold, L.TitleMinSize)
			if err != nil {
				return nil, nil, 0, err
			}
			track := em(L.TitleTrack, L.TitleMinSize)
			if a, b, ok := splitBalanced(fs, title, track, maxW); ok {
				return []string{a, b}, fs, L.TitleMinSize, nil
			}
			return []string{truncateToWidth(fs, title, track, maxW)}, fs, L.TitleMinSize, nil
		}
		size -= 6
	}
}

// splitBalanced finds the word break that minimises the wider of the two
// resulting lines, rejecting the split if either line still overflows.
func splitBalanced(fs *faceSet, s string, track fixed.Int26_6, maxW int) (string, string, bool) {
	words := strings.Fields(s)
	if len(words) < 2 {
		return "", "", false
	}
	bestA, bestB, best := "", "", math.MaxInt32
	for i := 1; i < len(words); i++ {
		a := strings.Join(words[:i], " ")
		b := strings.Join(words[i:], " ")
		wa, wb := runW(fs, a, track), runW(fs, b, track)
		if wa > maxW || wb > maxW {
			continue
		}
		if m := maxInt(wa, wb); m < best {
			best, bestA, bestB = m, a, b
		}
	}
	if best == math.MaxInt32 {
		return "", "", false
	}
	return bestA, bestB, true
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// ── Story painter ───────────────────────────────────────────────────

// storyBlock is one row of the story's vertical flow: a top margin, a
// measured height, and the closure that paints it once the flow has
// resolved a final y.
type storyBlock struct {
	marginTop int
	height    int
	paint     func(y int)
}

// paintStory lays out the 1080×1920 composition.
//
// The flow follows the mockup's flex column: fixed top padding, blocks
// separated by their CSS margins, and the join bar pinned to the bottom
// (`margin-top: auto`). At the design's own numbers the stack runs ~21px
// past the join bar's pinned top, so rather than let the CTA drift off
// the bottom edge — or collide with the tagline when a title wraps to two
// lines — the inter-block margins compress proportionally to close the
// gap. Everything keeps its designed size; only the air between shrinks.
func paintStory(dst *image.RGBA, L *cardLayout, lib *cardFontLibrary, d cardData) error {
	contentX := L.PadX
	contentW := L.Width - 2*L.PadX
	centerX := L.Width / 2

	var blocks []storyBlock

	// ── Brandline: ◆ WATCH PARTY ◆ ────────────────────────────────
	brandFS, err := lib.face(roleDisplayBold, L.BrandSize)
	if err != nil {
		return err
	}
	brandText := strings.ToUpper("Watch Party")
	brandTrack := em(L.BrandTrack, L.BrandSize)
	brandTextW := runW(brandFS, brandText, brandTrack)
	brandLineH := int(math.Round(L.BrandSize * L.BrandLineH))
	brandTotalW := L.BrandDiamond + L.BrandGap + brandTextW + L.BrandGap + L.BrandDiamond
	blocks = append(blocks, storyBlock{
		marginTop: 0,
		height:    brandLineH,
		paint: func(y int) {
			x := centerX - brandTotalW/2
			dy := y + (brandLineH-L.BrandDiamond)/2
			drawDiamond(dst, x, dy, L.BrandDiamond)
			drawDiamond(dst, x+brandTotalW-L.BrandDiamond, dy, L.BrandDiamond)
			base := y + baselineIn(brandFS.resolve(brandText), float64(brandLineH))
			drawRunGradient(dst, brandFS, brandText, brandTrack,
				x+L.BrandDiamond+L.BrandGap, base,
				96, brandStops, float64(brandLineH), 0, 0, nil)
		},
	})

	// ── Poster ────────────────────────────────────────────────────
	blocks = append(blocks, storyBlock{
		marginTop: L.PosterMarginTop,
		height:    L.PosterH,
		paint: func(y int) {
			drawPoster(dst, L, image.Rect(centerX-L.PosterW/2, y, centerX+L.PosterW/2, y+L.PosterH), d.Poster)
		},
	})

	// ── Media title ───────────────────────────────────────────────
	titleLines, titleFS, titleSize, err := wrapTitle(lib, L, d.MediaTitle, contentW)
	if err != nil {
		return err
	}
	titleTrack := em(L.TitleTrack, titleSize)
	titleLineH := int(math.Round(titleSize * L.TitleLineH))
	blocks = append(blocks, storyBlock{
		marginTop: L.TitleMarginTop,
		height:    titleLineH * len(titleLines),
		paint: func(y int) {
			for i, line := range titleLines {
				top := y + i*titleLineH
				base := top + baselineIn(titleFS.resolve(line), float64(titleLineH))
				w := runW(titleFS, line, titleTrack)
				drawRun(dst, titleFS, line, titleTrack, centerX-w/2, base, hexRGBA(0xFFFFFF, 1))
			}
		},
	})

	// ── Meta line ─────────────────────────────────────────────────
	if d.MetaLine != "" {
		metaFS, err := lib.face(roleSansMedium, L.MetaSize)
		if err != nil {
			return err
		}
		metaTrack := em(L.MetaTrack, L.MetaSize)
		metaText := truncateToWidth(metaFS, d.MetaLine, metaTrack, contentW)
		metaLineH := int(math.Round(L.MetaSize * L.MetaLineH))
		blocks = append(blocks, storyBlock{
			marginTop: L.MetaMarginTop,
			height:    metaLineH,
			paint: func(y int) {
				base := y + baselineIn(metaFS.resolve(metaText), float64(metaLineH))
				w := runW(metaFS, metaText, metaTrack)
				drawRun(dst, metaFS, metaText, metaTrack, centerX-w/2, base, rgba(255, 255, 255, 0.48))
			},
		})
	}

	// ── Divider ───────────────────────────────────────────────────
	blocks = append(blocks, storyBlock{
		marginTop: L.DividerMarginTop,
		height:    L.DividerH,
		paint: func(y int) {
			r := image.Rect(centerX-L.DividerW/2, y, centerX+L.DividerW/2, y+L.DividerH)
			mask := roundedRectAlpha(L.DividerW, L.DividerH, float64(L.DividerH)/2)
			grad := renderGradient(L.DividerW, L.DividerH, image.Rect(0, 0, L.DividerW, L.DividerH), 90, dividerStops)
			// .divider carries opacity: .85 on top of the gradient's own alpha.
			scaleAlpha(mask, 0.85)
			drawMaskAt(dst, mask, grad, r.Min.X, r.Min.Y)
		},
	})

	// ── Date caps + time (the schedule block) ─────────────────────
	if d.DateCaps != "" {
		dateFS, err := lib.face(roleSansBold, L.DateSize)
		if err != nil {
			return err
		}
		dateTrack := em(L.DateTrack, L.DateSize)
		dateText := truncateToWidth(dateFS, strings.ToUpper(d.DateCaps), dateTrack, contentW)
		dateLineH := int(math.Round(L.DateSize * L.DateLineH))
		blocks = append(blocks, storyBlock{
			marginTop: L.DateMarginTop,
			height:    dateLineH,
			paint: func(y int) {
				base := y + baselineIn(dateFS.resolve(dateText), float64(dateLineH))
				w := runW(dateFS, dateText, dateTrack)
				drawRun(dst, dateFS, dateText, dateTrack, centerX-w/2, base, hexRGBA(tokenLilac, 1))
			},
		})
	}
	if d.TimeText != "" {
		timeFS, err := lib.face(roleDisplayExtraBold, L.TimeSize)
		if err != nil {
			return err
		}
		timeTrack := em(L.TimeTrack, L.TimeSize)
		timeText := truncateToWidth(timeFS, d.TimeText, timeTrack, contentW)
		timeLineH := int(math.Round(L.TimeSize * L.TimeLineH))
		blocks = append(blocks, storyBlock{
			marginTop: L.TimeMarginTop,
			height:    timeLineH,
			paint: func(y int) {
				base := y + baselineIn(timeFS.resolve(timeText), float64(timeLineH))
				w := runW(timeFS, timeText, timeTrack)
				drawRunGradient(dst, timeFS, timeText, timeTrack, centerX-w/2, base,
					96, timeStops, float64(timeLineH),
					L.TimeShadowBlur, L.TimeShadowDY, hexRGBA(tokenViolet, 0.45))
			},
		})
	}

	// ── Host row ──────────────────────────────────────────────────
	hostedFS, err := lib.face(roleSansMedium, L.HostNameSize)
	if err != nil {
		return err
	}
	hostBoldFS, err := lib.face(roleSansBold, L.HostNameSize)
	if err != nil {
		return err
	}
	hostedLabel := "Hosted by "
	hostName := d.HostName
	maxNameW := contentW - L.AvatarSize - L.HostGap - runW(hostedFS, hostedLabel, 0)
	hostName = truncateToWidth(hostBoldFS, hostName, 0, maxNameW)
	hostTextW := runW(hostedFS, hostedLabel, 0) + runW(hostBoldFS, hostName, 0)
	hostRowW := L.AvatarSize + L.HostGap + hostTextW
	hostNameLineH := int(math.Round(L.HostNameSize * L.HostNameLineH))
	blocks = append(blocks, storyBlock{
		marginTop: L.HostMarginTop,
		height:    L.AvatarSize,
		paint: func(y int) {
			x := centerX - hostRowW/2
			drawAvatar(dst, L, lib, x, y, d.HostInitial, d.HostAvatar)
			tx := x + L.AvatarSize + L.HostGap
			base := y + (L.AvatarSize-hostNameLineH)/2 + baselineIn(hostedFS.resolve(hostedLabel), float64(hostNameLineH))
			drawRun(dst, hostedFS, hostedLabel, 0, tx, base, rgba(255, 255, 255, 0.86))
			drawRun(dst, hostBoldFS, hostName, 0, tx+runW(hostedFS, hostedLabel, 0), base, hexRGBA(0xFFFFFF, 1))
		},
	})

	// ── Tagline ───────────────────────────────────────────────────
	if d.Tagline != "" {
		tagFS, err := lib.face(roleSansRegular, L.TaglineSize)
		if err != nil {
			return err
		}
		tagText := truncateToWidth(tagFS, d.Tagline, 0, contentW)
		tagLineH := int(math.Round(L.TaglineSize * L.TaglineLineH))
		blocks = append(blocks, storyBlock{
			marginTop: L.TaglineMarginTop,
			height:    tagLineH,
			paint: func(y int) {
				face := tagFS.resolve(tagText)
				mask, padX, baseline, adv := textMask(face, tagText, 0)
				sheared, shift := shearAlpha(mask, baseline, L.TaglineShear)
				base := y + baselineIn(face, float64(tagLineH))
				drawMaskUniform(dst, sheared, rgba(255, 255, 255, 0.40),
					centerX-adv/2-padX+shift, base-baseline)
			},
		})
	}

	// ── Resolve the flow ──────────────────────────────────────────
	//
	// `.joinbar { margin-top: auto }` in a fixed-height flex column: the
	// bar takes the FREE space, and when there is none the auto margin
	// resolves to zero and the stack simply runs on. Reproducing that
	// exactly is what makes the render match the mockup pixel-for-pixel
	// at the design's own content (which, at 1080×1920, overruns the
	// pinned position by ~21px — the bar sits 35px off the bottom, not
	// the nominal 56).
	//
	// A two-line title adds another ~77px, and at some point the bar
	// would slide off the card. Past that point the inter-block margins
	// compress proportionally: every element keeps its designed SIZE, and
	// only the air between them gives.
	natural := L.PadTop
	flexTotal := 0
	for _, b := range blocks {
		natural += b.marginTop + b.height
		flexTotal += b.marginTop
	}
	floorTop := L.Height - L.JoinH - L.MinBottomPad
	scale := 1.0
	if over := natural - floorTop; over > 0 && flexTotal > 0 {
		scale = math.Max(0, float64(flexTotal-over)/float64(flexTotal))
	}

	y := L.PadTop
	for _, b := range blocks {
		y += int(math.Round(float64(b.marginTop) * scale))
		b.paint(y)
		y += b.height
	}

	// ── Join bar ──────────────────────────────────────────────────
	joinTop := L.Height - L.PadBottom - L.JoinH
	if y > joinTop {
		joinTop = minInt(y, floorTop)
	}
	return drawJoinBar(dst, L, lib, image.Rect(contentX, joinTop, contentX+contentW, joinTop+L.JoinH), d)
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// scaleAlpha multiplies a mask's coverage by f, standing in for a CSS
// `opacity` on the element the mask represents.
func scaleAlpha(m *image.Alpha, f float64) {
	for i := range m.Pix {
		m.Pix[i] = uint8(float64(m.Pix[i])*f + 0.5)
	}
}

// drawDiamond paints the brandline's rotated gradient square with its
// violet glow (`.brandline .diamond`).
//
// CSS `transform: rotate(45deg)` rotates the PAINTED element, gradient
// and all — so the fill is sampled in the square's own local space and
// carried through the rotation, not laid over the rotated silhouette.
func drawDiamond(dst *image.RGBA, x, y, size int) {
	// A `size` square rotated 45° occupies a box of size·√2.
	diag := int(math.Ceil(float64(size) * math.Sqrt2))
	sq := roundedRectAlpha(size, size, 3)
	sqGrad := renderGradient(size, size, image.Rect(0, 0, size, size), 135, diamondStops)

	mask := image.NewAlpha(image.Rect(0, 0, diag, diag))
	body := image.NewRGBA(image.Rect(0, 0, diag, diag))
	c := float64(diag) / 2
	half := float64(size) / 2
	const cos45 = math.Sqrt2 / 2
	for py := 0; py < diag; py++ {
		for px := 0; px < diag; px++ {
			dx := float64(px) + 0.5 - c
			dy := float64(py) + 0.5 - c
			// Inverse-rotate by 45° into the square's local space.
			ix := int(dx*cos45 + dy*cos45 + half)
			iy := int(-dx*cos45 + dy*cos45 + half)
			if ix < 0 || iy < 0 || ix >= size || iy >= size {
				continue
			}
			cov := sq.Pix[iy*sq.Stride+ix]
			mask.Pix[py*mask.Stride+px] = cov
			g := sqGrad.Pix[iy*sqGrad.Stride+ix*4:]
			o := py*body.Stride + px*4
			f := float64(cov) / 255
			body.Pix[o] = uint8(float64(g[0])*f + 0.5)
			body.Pix[o+1] = uint8(float64(g[1])*f + 0.5)
			body.Pix[o+2] = uint8(float64(g[2])*f + 0.5)
			body.Pix[o+3] = uint8(float64(g[3])*f + 0.5)
		}
	}

	ox := x - (diag-size)/2
	oy := y - (diag-size)/2
	// box-shadow: 0 0 22px rgba(168,85,247,0.9)
	glow, goff := blurAlphaPadded(mask, 11)
	drawMaskUniform(dst, glow, hexRGBA(tokenViolet, 0.9), ox-goff, oy-goff)
	draw.Draw(dst, image.Rect(ox, oy, ox+diag, oy+diag), body, image.Point{}, draw.Over)
}

// drawPoster paints the key art with its violet bloom, faint spread halo
// and hairline lilac edge (`.poster`).
func drawPoster(dst *image.RGBA, L *cardLayout, r image.Rectangle, poster image.Image) {
	w, h := r.Dx(), r.Dy()

	// box-shadow: 0 60px 140px -30px rgba(168,85,247,0.55)
	sp := L.PosterBloomSpread
	bw, bh := w+2*sp, h+2*sp
	if bw > 0 && bh > 0 {
		bloom, off := blurAlphaPadded(
			roundedRectAlpha(bw, bh, math.Max(0, L.PosterRadius+float64(sp))), L.PosterBloomBlur)
		drawMaskUniform(dst, bloom, hexRGBA(tokenViolet, 0.55),
			r.Min.X-sp-off, r.Min.Y-sp+L.PosterBloomDY-off)
	}
	// box-shadow: 0 0 0 12px rgba(168,85,247,0.05)
	halo := roundedRectAlpha(w+24, h+24, L.PosterRadius+12)
	drawMaskUniform(dst, halo, hexRGBA(tokenViolet, 0.05), r.Min.X-12, r.Min.Y-12)
	// box-shadow: 0 0 0 1px rgba(216,180,254,0.26)
	edge := roundedRectAlpha(w+2, h+2, L.PosterRadius+1)
	drawMaskUniform(dst, edge, hexRGBA(tokenLilac, 0.26), r.Min.X-1, r.Min.Y-1)

	mask := roundedRectAlpha(w, h, L.PosterRadius)
	// background-color: #17131F shows through where art is missing.
	drawMaskUniform(dst, mask, hexRGBA(0x17131F, 1), r.Min.X, r.Min.Y)
	if poster == nil {
		return
	}
	art := image.NewRGBA(image.Rect(0, 0, w, h))
	coverScale(art, art.Bounds(), poster)
	drawMaskAt(dst, mask, art, r.Min.X, r.Min.Y)
}

// drawAvatar paints the host's circle: violet→cyan fill (or their TMDB
// avatar), a lilac ring, and a violet glow. Only the HOST ever appears on
// a card — invitees are other people's plans.
func drawAvatar(dst *image.RGBA, L *cardLayout, lib *cardFontLibrary, x, y int, initial string, img image.Image) {
	size := L.AvatarSize
	ring := L.AvatarRing

	body := ellipseAlpha(size, size)
	// box-shadow: 0 8px 28px rgba(168,85,247,0.5)
	glow, goff := blurAlphaPadded(body, L.AvatarGlowBlur)
	drawMaskUniform(dst, glow, hexRGBA(tokenViolet, 0.5), x-goff, y+L.AvatarGlowDY-goff)
	// box-shadow: 0 0 0 3px rgba(216,180,254,0.42)
	ringMask := ellipseAlpha(size+2*ring, size+2*ring)
	drawMaskUniform(dst, ringMask, hexRGBA(tokenLilac, 0.42), x-ring, y-ring)

	if img != nil {
		art := image.NewRGBA(image.Rect(0, 0, size, size))
		coverScale(art, art.Bounds(), img)
		drawMaskAt(dst, body, art, x, y)
		return
	}
	grad := renderGradient(size, size, image.Rect(0, 0, size, size), 150, avatarStops)
	drawMaskAt(dst, body, grad, x, y)

	if initial == "" {
		return
	}
	fs, err := lib.face(roleDisplayBold, L.AvatarInitialSize)
	if err != nil {
		return
	}
	face := fs.resolve(initial)
	m := face.Metrics()
	w := runAdvance(face, initial, 0).Ceil()
	// Optically centre on the cap height rather than the full em box.
	base := y + size/2 + m.CapHeight.Round()/2
	drawRun(dst, fs, initial, 0, x+(size-w)/2, base, hexRGBA(0xFFFFFF, 1))
}

// drawJoinBar paints the CTA: panel, hairline, label + code, and the QR.
func drawJoinBar(dst *image.RGBA, L *cardLayout, lib *cardFontLibrary, r image.Rectangle, d cardData) error {
	w, h := r.Dx(), r.Dy()

	// The panel is translucent, so the 1px border has to be a RING —
	// painting the border colour under the whole rect would tint the
	// entire surface (which it did, by ~40%, on the first pass).
	outer := roundedRectAlpha(w, h, L.JoinRadius)
	inner := roundedRectAlpha(w-2, h-2, L.JoinRadius-1)
	panel := renderGradient(w-2, h-2, image.Rect(0, 0, w-2, h-2), 180, joinBarStops)
	drawMaskAt(dst, inner, panel, r.Min.X+1, r.Min.Y+1)
	drawMaskUniform(dst, ringAlpha(outer, inner, 1, 1), hexRGBA(tokenLilac, 0.24), r.Min.X, r.Min.Y)

	labelFS, err := lib.face(roleSansBold, L.JoinLabelSize)
	if err != nil {
		return err
	}
	codeFS, err := lib.face(roleDisplayExtraBold, L.JoinCodeSize)
	if err != nil {
		return err
	}
	label := strings.ToUpper(d.JoinLabel)
	labelTrack := em(L.JoinLabelTrack, L.JoinLabelSize)
	codeTrack := em(L.JoinCodeTrack, L.JoinCodeSize)
	labelLineH := int(math.Round(L.JoinLabelSize * L.JoinLabelLineH))
	codeLineH := int(math.Round(L.JoinCodeSize * L.JoinCodeLineH))

	stackH := labelLineH + L.JoinCodeMarginTop + codeLineH
	top := r.Min.Y + (h-stackH)/2
	x := r.Min.X + L.JoinPadX

	drawRun(dst, labelFS, label, labelTrack, x,
		top+baselineIn(labelFS.resolve(label), float64(labelLineH)),
		hexRGBA(tokenLilac, 0.80))
	drawRun(dst, codeFS, d.Code, codeTrack, x,
		top+labelLineH+L.JoinCodeMarginTop+baselineIn(codeFS.resolve(d.Code), float64(codeLineH)),
		hexRGBA(0xFFFFFF, 1))

	if d.JoinURL != "" {
		qx := r.Max.X - L.JoinPadX - L.QRSize
		qy := r.Min.Y + (h-L.QRSize)/2
		if err := drawJoinQR(dst, L, d.JoinURL, qx, qy); err != nil {
			return err
		}
	}
	return nil
}

// drawJoinQR paints the join symbol at the spec's 116px footprint.
//
// DELIBERATE DEVIATION from the mockup's render spec, which asks for
// "white modules, transparent ground". Rendered that way the symbol is
// light-on-dark with no quiet zone, and a standard decoder (OpenCV's
// QRCodeDetector, i.e. the ZXing lineage most Android scanner apps use)
// simply will not read it — verified, it decodes only after inverting.
// iOS Vision copes; plenty of scanners do not. "A QR nobody has to type"
// is the whole point of the element, and party_qr.go already made this
// exact call for the same payload ("default black-on-white for maximum
// camera compatibility").
//
// So: same size, same position, same visual weight on the dark panel —
// a light plate — but with dark modules and a real quiet zone.
func drawJoinQR(dst *image.RGBA, L *cardLayout, joinURL string, x, y int) error {
	inner := L.QRSize - 2*L.QRQuiet
	if inner < 16 {
		inner = L.QRSize
	}
	qr, err := renderJoinQR(joinURL, inner)
	if err != nil {
		return err
	}
	plate := roundedRectAlpha(L.QRSize, L.QRSize, L.QRRadius)
	drawMaskUniform(dst, plate, hexRGBA(0xFFFFFF, 0.94), x, y)
	drawMaskUniform(dst, qr, hexRGBA(0x0B0A12, 1), x+L.QRQuiet, y+L.QRQuiet)
	return nil
}
