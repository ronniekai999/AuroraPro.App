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
// Structure:
//
//   CardVariant     — the enum. Three crops.
//   cardLayout      — the per-variant geometry table.
//   composeCard()   — the single entry point: (variant, data) → PNG bytes.
//                     Dispatches to a per-variant painter after laying
//                     down the shared scene (ground, curtain, stars).
//   cardColumn      — the vertical flow. All three variants stack the same
//                     rows; they differ in the column's width, whether the
//                     rows centre or set flush left, and which rows appear.
//
// A new variant is a new cardLayout value, a painter that composes
// cardColumn rows, and one case in composeCard.

// CardVariant names one crop of the share-card composition.
type CardVariant string

const (
	// CardVariantStory is the 1080×1920 Stories/TikTok crop — the one
	// people post.
	CardVariantStory CardVariant = "story"
	// CardVariantSquare is the 1080×1080 feed/Discord crop: poster left,
	// the whole stack right.
	CardVariantSquare CardVariant = "square"
	// CardVariantOG is the 1200×630 link-unfurl crop. Same composition,
	// tighter: a code CHIP rather than the full join bar, and no divider
	// or tagline — at the size a chat client renders an unfurl, those rows
	// are noise. Phase 3 points og:image at this variant.
	CardVariantOG CardVariant = "og"
)

// cardLiveLabel fills the schedule slot for a party with no scheduled
// start. It is set in the TIME's face and gradient, in the schedule
// block's own position — an unscheduled party is not a card with a hole
// in it, it is a card that says the room is open now.
const cardLiveLabel = "LIVE NOW"

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

	// ContentGap is the flex `gap` between the poster and the text column
	// on the side-by-side crops. Zero on story, which stacks.
	ContentGap int

	Bands      []cardBand
	Stars      int
	StarLayerA float64
	GrainAlpha float64

	// Type scale. Track values are CSS `em` fractions; the painter
	// multiplies by the size in px.
	BrandText              string // "Watch Party" / "Aurora Watch Party"
	BrandDiamonds          int    // 1 = leading only, 2 = flanking
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
	DateMinSize            float64
	DateMarginTop          int
	TimeSize, TimeTrack    float64
	TimeLineH              float64
	TimeMinSize            float64
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

	// Join bar. JoinMarginTop is zero on story, where `.joinbar` keeps its
	// `margin-top: auto` and pins to the bottom edge; the square's own rule
	// overrides that auto with a real 38px margin, so there the bar simply
	// flows with the rest of the column.
	JoinMarginTop     int
	JoinH             int
	JoinRadius        float64
	JoinPadX          int
	JoinTextGap       int // minimum air between the label/code stack and the QR
	JoinLabelSize     float64
	JoinLabelTrack    float64
	JoinLabelLineH    float64
	JoinCodeSize      float64
	JoinCodeTrack     float64
	JoinCodeLineH     float64
	JoinCodeMarginTop int
	QRSize            int
	QRQuiet           int
	QRRadius          float64

	// Code chip — the OG crop's CTA (`.og-codechip`), a stadium pill
	// reading "Code 7K2QD9". Zero-valued on the crops that use a join bar.
	ChipMarginTop  int
	ChipPadX       int
	ChipPadY       int
	ChipGap        int
	ChipLineH      float64
	ChipLabelSize  float64
	ChipLabelTrack float64
	ChipCodeSize   float64
	ChipCodeTrack  float64

	MinBottomPad      int
	CurtainScale      int
	CurtainPad        int
	PosterBloomBlur   float64
	PosterBloomDY     int
	PosterBloomSpread int
	TimeShadowBlur    float64
	TimeShadowDY      int
	AvatarGlowBlur    float64
	AvatarGlowDY      int
	AvatarRing        int
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

	BrandText:     "Watch Party",
	BrandDiamonds: 2,
	BrandSize:     30,
	BrandTrack:    0.42,
	BrandGap:      18,
	BrandDiamond:  16,
	BrandLineH:    1.6,

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
	DateMinSize:   24,
	DateMarginTop: 38,

	TimeSize:      118,
	TimeTrack:     -0.028,
	TimeLineH:     0.94,
	TimeMinSize:   80,
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
	JoinTextGap:       20,
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

// squareLayout is the 1080×1080 table, transcribed from `.card-square`:
// poster left, the whole stack right.
//
// Two flex readings worth recording, because they are not obvious from
// the numbers alone:
//
//   - `.card-square .joinbar` sets `margin-top: 38px`, which OVERRIDES the
//     shared `.joinbar { margin-top: auto }`. With no auto margin left to
//     absorb the free space, `.sq-col { justify-content: center }` takes
//     effect and the whole column — join bar included — is centred in the
//     content box. That is the opposite of story, where the bar pins to
//     the bottom edge.
//   - `.card-square .poster { align-self: center }` centres the art on the
//     column's cross axis independently of the text.
var squareLayout = cardLayout{
	Variant: CardVariantSquare,
	Width:   1080,
	Height:  1080,

	PadTop:     72,
	PadX:       72,
	PadBottom:  72,
	ContentGap: 56,

	Bands: []cardBand{
		{W: 1600, H: 460, Left: -320, Top: 120, RotateDeg: -13, BlurSigma: 125, Opacity: 0.58, GradientAt: 100},
		{W: 1400, H: 360, Left: -120, Top: 660, RotateDeg: 8, BlurSigma: 145, Opacity: 0.30, GradientAt: 100},
	},
	// `.stars` paints the same 16 specks at the same PERCENTAGE positions
	// on every crop, so the count is shared and the density rises with the
	// smaller canvas exactly as it does in the mockup.
	Stars:      16,
	StarLayerA: 0.72,
	GrainAlpha: 0.16,

	BrandText:     "Watch Party",
	BrandDiamonds: 1,
	BrandSize:     22,
	BrandTrack:    0.34,
	BrandGap:      18,
	BrandDiamond:  12,
	BrandLineH:    1.6,

	PosterW:      384,
	PosterH:      576,
	PosterRadius: 20,

	TitleSize:  62,
	TitleTrack: -0.03,
	TitleLineH: 1.04,
	// The column is 496px wide — less than half the story's measure — so
	// the title is allowed a third line before it starts shrinking. A
	// three-line title at the designed 62px reads better on a feed card
	// than two lines set at 38.
	TitleMinSize:   40,
	TitleMarginTop: 30,
	TitleMaxLines:  3,

	MetaSize:      24,
	MetaTrack:     0.04,
	MetaLineH:     1.6,
	MetaMarginTop: 16,

	DividerW:         200,
	DividerH:         3,
	DividerMarginTop: 34,

	DateSize:      26,
	DateTrack:     0.22,
	DateLineH:     1.6,
	DateMinSize:   19,
	DateMarginTop: 30,

	TimeSize:      84,
	TimeTrack:     -0.028,
	TimeLineH:     0.94,
	TimeMinSize:   54,
	TimeMarginTop: 12,

	HostGap:           16,
	HostMarginTop:     34,
	AvatarSize:        58,
	AvatarInitialSize: 26,
	HostNameSize:      27,
	HostNameLineH:     1.6,

	JoinMarginTop:     38,
	JoinH:             108,
	JoinRadius:        22,
	JoinPadX:          26,
	JoinTextGap:       18,
	JoinLabelSize:     17,
	JoinLabelTrack:    0.24,
	JoinLabelLineH:    1.6,
	JoinCodeSize:      42,
	JoinCodeTrack:     0.11,
	JoinCodeLineH:     1.6,
	JoinCodeMarginTop: 4,
	QRSize:            74,
	// 6px of plate at this footprint is ~2.5 modules of quiet zone, the
	// same ratio Phase 1 settled on for the story's 116px symbol.
	QRQuiet:  6,
	QRRadius: 6,

	MinBottomPad: 24,
	CurtainScale: 8,
	CurtainPad:   64,

	PosterBloomBlur:   70,
	PosterBloomDY:     60,
	PosterBloomSpread: -30,

	TimeShadowBlur: 22,
	TimeShadowDY:   10,

	AvatarGlowBlur: 14,
	AvatarGlowDY:   8,
	AvatarRing:     3,
}

// ogLayout is the 1200×630 table, transcribed from `.card-og`.
//
// `.card-og .content` centres both children on the cross axis, so the
// poster and the text column each sit vertically centred in the content
// box. The stylesheet defines no `.card-og .divider` and the crop carries
// no tagline: the CTA is the `.og-codechip` pill, because an unfurl is
// already a link — nobody scans a QR out of a Discord embed.
var ogLayout = cardLayout{
	Variant: CardVariantOG,
	Width:   1200,
	Height:  630,

	PadTop:     56,
	PadX:       64,
	PadBottom:  56,
	ContentGap: 48,

	Bands: []cardBand{
		{W: 1500, H: 380, Left: -260, Top: 60, RotateDeg: -11, BlurSigma: 110, Opacity: 0.55, GradientAt: 100},
		{W: 1200, H: 300, Left: 60, Top: 380, RotateDeg: 7, BlurSigma: 130, Opacity: 0.28, GradientAt: 100},
	},
	Stars:      16,
	StarLayerA: 0.72,
	GrainAlpha: 0.16,

	BrandText:     "Aurora Watch Party",
	BrandDiamonds: 1,
	BrandSize:     19,
	BrandTrack:    0.32,
	BrandGap:      18,
	BrandDiamond:  11,
	BrandLineH:    1.6,

	PosterW:      292,
	PosterH:      438,
	PosterRadius: 16,

	TitleSize:      56,
	TitleTrack:     -0.03,
	TitleLineH:     1.04,
	TitleMinSize:   36,
	TitleMarginTop: 22,
	TitleMaxLines:  2,

	MetaSize:      21,
	MetaTrack:     0.04,
	MetaLineH:     1.6,
	MetaMarginTop: 12,

	// No `.card-og .divider` rule and no divider in the comp's markup:
	// a zero width drops the row from the flow.

	DateSize:      22,
	DateTrack:     0.20,
	DateLineH:     1.6,
	DateMinSize:   16,
	DateMarginTop: 28,

	TimeSize:      68,
	TimeTrack:     -0.028,
	TimeLineH:     0.94,
	TimeMinSize:   46,
	TimeMarginTop: 8,

	HostGap:           14,
	HostMarginTop:     26,
	AvatarSize:        48,
	AvatarInitialSize: 21,
	HostNameSize:      23,
	HostNameLineH:     1.6,

	ChipMarginTop:  26,
	ChipPadX:       22,
	ChipPadY:       12,
	ChipGap:        14,
	ChipLineH:      1.6,
	ChipLabelSize:  22,
	ChipLabelTrack: 0.04,
	ChipCodeSize:   22,
	ChipCodeTrack:  0.10,

	MinBottomPad: 20,
	CurtainScale: 8,
	CurtainPad:   64,

	PosterBloomBlur:   70,
	PosterBloomDY:     60,
	PosterBloomSpread: -30,

	TimeShadowBlur: 22,
	TimeShadowDY:   10,

	AvatarGlowBlur: 14,
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
	case CardVariantSquare:
		return &squareLayout, true
	case CardVariantOG:
		return &ogLayout, true
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
	Live        bool   // no scheduled start: the slot reads LIVE NOW instead
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
	// .og-codechip — a flat violet wash, not a gradient.
	chipFill = hexRGBA(tokenViolet, 0.14)
	// .brandline .diamond
	diamondStops = []gradStop{
		stop(0, tokenLilac),
		stop(1, tokenCyan),
	}
)

// composeCard renders one card to PNG bytes. A new crop is a CardVariant,
// a cardLayout, a painter, and a case here.
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
	case CardVariantSquare, CardVariantOG:
		// One painter: the two crops are the same reflow, and every
		// difference between them is a value in the layout table.
		if err := paintSideBySide(dst, layout, lib, d); err != nil {
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

// fitRun sets a run at the largest size at or below `size` (stepping down
// toward `minSize`) at which it fits maxW, truncating only if even the
// floor overflows.
//
// The schedule rows use this rather than plain truncation because an
// elided time is not a time: "8:00 PM E…" misinforms a reader, and
// getting the start moment across is the card's one job. The story's
// 920px measure never triggers it; the square's 496px column does, on
// every zone abbreviation.
func fitRun(lib *cardFontLibrary, role cardFontRole, text string,
	size, minSize, trackEm float64, maxW int) (*faceSet, string, float64, error) {
	if minSize <= 0 || minSize > size {
		minSize = size
	}
	for {
		fs, err := lib.face(role, size)
		if err != nil {
			return nil, "", 0, err
		}
		track := em(trackEm, size)
		if size <= minSize || runW(fs, text, track) <= maxW {
			// truncateToWidth is a no-op on a run that already fits.
			return fs, truncateToWidth(fs, text, track, maxW), size, nil
		}
		if size -= 4; size < minSize {
			size = minSize
		}
	}
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

// wrapTitle lays the media title out in at most L.TitleMaxLines, shrinking
// the face before it will truncate.
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
		if lines, ok := wrapToLines(fs, title, track, maxW, L.TitleMaxLines); ok {
			return lines, fs, size, nil
		}
		if size-6 < L.TitleMinSize {
			// Out of room: set at the floor and truncate the tail.
			fs, err := lib.face(roleDisplayExtraBold, L.TitleMinSize)
			if err != nil {
				return nil, nil, 0, err
			}
			track := em(L.TitleTrack, L.TitleMinSize)
			if lines, ok := wrapToLines(fs, title, track, maxW, L.TitleMaxLines); ok {
				return lines, fs, L.TitleMinSize, nil
			}
			return []string{truncateToWidth(fs, title, track, maxW)}, fs, L.TitleMinSize, nil
		}
		size -= 6
	}
}

// wrapToLines breaks a title across up to maxLines, preferring the split
// that most evenly BALANCES two lines — "Jurassic World / Dominion" reads
// better than "Jurassic / World Dominion" — and only falling back to a
// greedy fill when two lines cannot hold the string. The story crop is
// capped at two, so it never reaches the greedy path; the square's 496px
// column routinely does.
func wrapToLines(fs *faceSet, s string, track fixed.Int26_6, maxW, maxLines int) ([]string, bool) {
	if maxLines < 2 {
		return nil, false
	}
	if a, b, ok := splitBalanced(fs, s, track, maxW); ok {
		return []string{a, b}, true
	}
	if maxLines < 3 {
		return nil, false
	}
	return greedyWrap(fs, s, track, maxW, maxLines)
}

// greedyWrap fills lines left to right at word boundaries. It reports
// failure — rather than overflowing — when the result needs more than
// maxLines or when a single word is wider than the measure, so the caller
// shrinks the face and tries again.
func greedyWrap(fs *faceSet, s string, track fixed.Int26_6, maxW, maxLines int) ([]string, bool) {
	words := strings.Fields(s)
	if len(words) < 2 {
		return nil, false
	}
	var lines []string
	cur := ""
	for _, w := range words {
		if runW(fs, w, track) > maxW {
			return nil, false
		}
		cand := w
		if cur != "" {
			cand = cur + " " + w
		}
		if runW(fs, cand, track) <= maxW {
			cur = cand
			continue
		}
		lines = append(lines, cur)
		if len(lines) >= maxLines {
			return nil, false
		}
		cur = w
	}
	return append(lines, cur), true
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

// ── Vertical flow ───────────────────────────────────────────────────

// cardBlock is one row of a card's vertical flow: a top margin, a
// measured height, and the closure that paints it once the flow has
// resolved a final y.
type cardBlock struct {
	marginTop int
	height    int
	paint     func(y int)
}

// stackHeight is a flow's natural height and the total of its
// compressible inter-block margins.
func stackHeight(blocks []cardBlock) (natural, flex int) {
	for _, b := range blocks {
		natural += b.marginTop + b.height
		flex += b.marginTop
	}
	return natural, flex
}

// paintStack draws a flow from `top` and returns the y just past the last
// block.
//
// A stack can overrun the room it is given — the story's does, by ~21px,
// at the design's own content — and a title that wraps makes it worse.
// Rather than let the CTA slide off the card, the inter-block margins
// compress PROPORTIONALLY once the natural height passes `limit`: every
// element keeps its designed size and only the air between them gives.
func paintStack(blocks []cardBlock, top, limit int) int {
	natural, flex := stackHeight(blocks)
	scale := 1.0
	if over := top + natural - limit; over > 0 && flex > 0 {
		scale = math.Max(0, float64(flex-over)/float64(flex))
	}
	y := top
	for _, b := range blocks {
		y += int(math.Round(float64(b.marginTop) * scale))
		b.paint(y)
		y += b.height
	}
	return y
}

// ── The shared column ───────────────────────────────────────────────

// cardColumn accumulates the rows every crop shares — brandline, title,
// meta, divider, schedule, host, tagline, and whichever CTA the variant
// carries — inside one content column. The story centres each row on the
// column's axis; the side-by-side crops set them flush left. Beyond that
// flag, the differences between the three cards live entirely in the
// layout table.
type cardColumn struct {
	dst      *image.RGBA
	L        *cardLayout
	lib      *cardFontLibrary
	d        cardData
	x, w     int
	centered bool
	blocks   []cardBlock
	// err carries a failure out of a paint closure, which cannot return
	// one. First error wins; the caller checks after the flow resolves.
	err error
}

func newCardColumn(dst *image.RGBA, L *cardLayout, lib *cardFontLibrary, d cardData, x, w int, centered bool) *cardColumn {
	return &cardColumn{dst: dst, L: L, lib: lib, d: d, x: x, w: w, centered: centered}
}

func (c *cardColumn) add(marginTop, height int, paint func(y int)) {
	c.blocks = append(c.blocks, cardBlock{marginTop: marginTop, height: height, paint: paint})
}

func (c *cardColumn) fail(err error) {
	if err != nil && c.err == nil {
		c.err = err
	}
}

// rowX is the left edge of a row `width` wide. The centred form is written
// as (midpoint − width/2) rather than (x + (w − width)/2): the two
// disagree by a pixel on odd widths, and the story crop was drawn — and
// reviewed — with the former.
func (c *cardColumn) rowX(width int) int {
	if c.centered {
		return c.x + c.w/2 - width/2
	}
	return c.x
}

// addBrandline paints `◆ WATCH PARTY ◆` (story) or `◆ Watch Party`
// (the side-by-side crops, whose rules drop the trailing diamond).
func (c *cardColumn) addBrandline() error {
	L := c.L
	fs, err := c.lib.face(roleDisplayBold, L.BrandSize)
	if err != nil {
		return err
	}
	text := strings.ToUpper(L.BrandText)
	track := em(L.BrandTrack, L.BrandSize)
	lineH := int(math.Round(L.BrandSize * L.BrandLineH))
	totalW := L.BrandDiamond + L.BrandGap + runW(fs, text, track)
	if L.BrandDiamonds >= 2 {
		totalW += L.BrandGap + L.BrandDiamond
	}
	c.add(0, lineH, func(y int) {
		x := c.rowX(totalW)
		dy := y + (lineH-L.BrandDiamond)/2
		drawDiamond(c.dst, x, dy, L.BrandDiamond)
		if L.BrandDiamonds >= 2 {
			drawDiamond(c.dst, x+totalW-L.BrandDiamond, dy, L.BrandDiamond)
		}
		base := y + baselineIn(fs.resolve(text), float64(lineH))
		drawRunGradient(c.dst, fs, text, track, x+L.BrandDiamond+L.BrandGap, base,
			96, brandStops, float64(lineH), 0, 0, nil)
	})
	return nil
}

// addPoster places the key art as a row of the flow. Only the story does
// this — the side-by-side crops draw it beside the column, not in it.
func (c *cardColumn) addPoster() {
	L := c.L
	c.add(L.PosterMarginTop, L.PosterH, func(y int) {
		x := c.rowX(L.PosterW)
		drawPoster(c.dst, L, image.Rect(x, y, x+L.PosterW, y+L.PosterH), c.d.Poster)
	})
}

func (c *cardColumn) addTitle() error {
	L := c.L
	lines, fs, size, err := wrapTitle(c.lib, L, c.d.MediaTitle, c.w)
	if err != nil {
		return err
	}
	track := em(L.TitleTrack, size)
	lineH := int(math.Round(size * L.TitleLineH))
	c.add(L.TitleMarginTop, lineH*len(lines), func(y int) {
		for i, line := range lines {
			top := y + i*lineH
			base := top + baselineIn(fs.resolve(line), float64(lineH))
			drawRun(c.dst, fs, line, track, c.rowX(runW(fs, line, track)), base, hexRGBA(0xFFFFFF, 1))
		}
	})
	return nil
}

func (c *cardColumn) addMeta() error {
	L := c.L
	if c.d.MetaLine == "" {
		return nil
	}
	fs, err := c.lib.face(roleSansMedium, L.MetaSize)
	if err != nil {
		return err
	}
	track := em(L.MetaTrack, L.MetaSize)
	text := truncateToWidth(fs, c.d.MetaLine, track, c.w)
	lineH := int(math.Round(L.MetaSize * L.MetaLineH))
	c.add(L.MetaMarginTop, lineH, func(y int) {
		base := y + baselineIn(fs.resolve(text), float64(lineH))
		drawRun(c.dst, fs, text, track, c.rowX(runW(fs, text, track)), base, rgba(255, 255, 255, 0.48))
	})
	return nil
}

// addDivider paints the violet→cyan hairline. The OG crop declares no
// `.divider` rule, and a zero width drops the row from the flow.
func (c *cardColumn) addDivider() {
	L := c.L
	if L.DividerW <= 0 || L.DividerH <= 0 {
		return
	}
	c.add(L.DividerMarginTop, L.DividerH, func(y int) {
		mask := roundedRectAlpha(L.DividerW, L.DividerH, float64(L.DividerH)/2)
		grad := renderGradient(L.DividerW, L.DividerH, image.Rect(0, 0, L.DividerW, L.DividerH), 90, dividerStops)
		// .divider carries opacity: .85 on top of the gradient's own alpha.
		scaleAlpha(mask, 0.85)
		drawMaskAt(c.dst, mask, grad, c.rowX(L.DividerW), y)
	})
}

// addSchedule fills the date/time slot.
//
// A scheduled party gets the date in caps and the start time in the
// display gradient. A party with no scheduled start gets LIVE NOW in that
// same slot — same face, same gradient, same drop shadow, sitting where
// the date caps would have started, so the composition keeps its shape
// instead of collapsing around a hole.
func (c *cardColumn) addSchedule() error {
	L, d := c.L, c.d
	if d.Live {
		return c.addTimeRow(cardLiveLabel, L.DateMarginTop)
	}
	if d.DateCaps != "" {
		fs, text, size, err := fitRun(c.lib, roleSansBold, strings.ToUpper(d.DateCaps),
			L.DateSize, L.DateMinSize, L.DateTrack, c.w)
		if err != nil {
			return err
		}
		track := em(L.DateTrack, size)
		lineH := int(math.Round(size * L.DateLineH))
		c.add(L.DateMarginTop, lineH, func(y int) {
			base := y + baselineIn(fs.resolve(text), float64(lineH))
			drawRun(c.dst, fs, text, track, c.rowX(runW(fs, text, track)), base, hexRGBA(tokenLilac, 1))
		})
	}
	if d.TimeText != "" {
		return c.addTimeRow(d.TimeText, L.TimeMarginTop)
	}
	return nil
}

// addTimeRow is the eye magnet: display type filled with the
// white→lilac→violet→cyan sweep, over a violet drop shadow.
func (c *cardColumn) addTimeRow(text string, marginTop int) error {
	L := c.L
	fs, text, size, err := fitRun(c.lib, roleDisplayExtraBold, text,
		L.TimeSize, L.TimeMinSize, L.TimeTrack, c.w)
	if err != nil {
		return err
	}
	track := em(L.TimeTrack, size)
	lineH := int(math.Round(size * L.TimeLineH))
	c.add(marginTop, lineH, func(y int) {
		base := y + baselineIn(fs.resolve(text), float64(lineH))
		drawRunGradient(c.dst, fs, text, track, c.rowX(runW(fs, text, track)), base,
			96, timeStops, float64(lineH),
			L.TimeShadowBlur, L.TimeShadowDY, hexRGBA(tokenViolet, 0.45))
	})
	return nil
}

// addHostRow paints the avatar and "Hosted by <name>". Only the HOST ever
// appears on a card — invitees are other people's plans.
func (c *cardColumn) addHostRow() error {
	L := c.L
	hostedFS, err := c.lib.face(roleSansMedium, L.HostNameSize)
	if err != nil {
		return err
	}
	boldFS, err := c.lib.face(roleSansBold, L.HostNameSize)
	if err != nil {
		return err
	}
	label := "Hosted by "
	labelW := runW(hostedFS, label, 0)
	name := truncateToWidth(boldFS, c.d.HostName, 0, c.w-L.AvatarSize-L.HostGap-labelW)
	rowW := L.AvatarSize + L.HostGap + labelW + runW(boldFS, name, 0)
	lineH := int(math.Round(L.HostNameSize * L.HostNameLineH))
	c.add(L.HostMarginTop, L.AvatarSize, func(y int) {
		x := c.rowX(rowW)
		drawAvatar(c.dst, L, c.lib, x, y, c.d.HostInitial, c.d.HostAvatar)
		tx := x + L.AvatarSize + L.HostGap
		base := y + (L.AvatarSize-lineH)/2 + baselineIn(hostedFS.resolve(label), float64(lineH))
		drawRun(c.dst, hostedFS, label, 0, tx, base, rgba(255, 255, 255, 0.86))
		drawRun(c.dst, boldFS, name, 0, tx+labelW, base, hexRGBA(0xFFFFFF, 1))
	})
	return nil
}

// addTagline paints the story's one line of voice, synthesised oblique.
// The crops that declare no `.tagline` rule skip it.
func (c *cardColumn) addTagline() error {
	L := c.L
	if L.TaglineSize <= 0 || c.d.Tagline == "" {
		return nil
	}
	fs, err := c.lib.face(roleSansRegular, L.TaglineSize)
	if err != nil {
		return err
	}
	text := truncateToWidth(fs, c.d.Tagline, 0, c.w)
	lineH := int(math.Round(L.TaglineSize * L.TaglineLineH))
	c.add(L.TaglineMarginTop, lineH, func(y int) {
		face := fs.resolve(text)
		mask, padX, baseline, adv := textMask(face, text, 0)
		sheared, shift := shearAlpha(mask, baseline, L.TaglineShear)
		base := y + baselineIn(face, float64(lineH))
		drawMaskUniform(c.dst, sheared, rgba(255, 255, 255, 0.40),
			c.rowX(adv)-padX+shift, base-baseline)
	})
	return nil
}

// addJoinBar puts the CTA in the flow. The story does NOT use this — its
// `.joinbar` keeps `margin-top: auto` and is pinned to the bottom edge
// after the flow resolves.
func (c *cardColumn) addJoinBar() {
	L := c.L
	if L.JoinH <= 0 {
		return
	}
	c.add(L.JoinMarginTop, L.JoinH, func(y int) {
		c.fail(drawJoinBar(c.dst, L, c.lib, image.Rect(c.x, y, c.x+c.w, y+L.JoinH), c.d))
	})
}

// addCodeChip paints `.og-codechip` — a stadium pill reading "Code
// 7K2QD9". This is the unfurl crop's CTA: the reader already has the
// link, so what they need is the six characters, not a QR to point a
// second phone at.
func (c *cardColumn) addCodeChip() error {
	L := c.L
	if L.ChipLabelSize <= 0 || c.d.Code == "" {
		return nil
	}
	// CSS asks for weight 600; the vendored set has 400/500/700, and the
	// font-matching rules resolve 600 upward to the 700 instance.
	labelFS, err := c.lib.face(roleSansBold, L.ChipLabelSize)
	if err != nil {
		return err
	}
	codeFS, err := c.lib.face(roleDisplayExtraBold, L.ChipCodeSize)
	if err != nil {
		return err
	}
	const label = "Code"
	labelTrack := em(L.ChipLabelTrack, L.ChipLabelSize)
	codeTrack := em(L.ChipCodeTrack, L.ChipCodeSize)
	lineH := int(math.Round(math.Max(L.ChipLabelSize, L.ChipCodeSize) * L.ChipLineH))
	labelW := runW(labelFS, label, labelTrack)
	codeW := runW(codeFS, c.d.Code, codeTrack)
	// The chip declares no height, so its box is content + padding + the
	// 1px border on each side — box-sizing only ever affects a SPECIFIED
	// length, which is why the join bar's 108px swallows its border and
	// this pill's auto height does not. Measured in the comp: 61.2px tall
	// for a 22px/1.6 line box, which is 35.2 + 24 + 2.
	const chipBorder = 1
	chipW := 2*(L.ChipPadX+chipBorder) + labelW + L.ChipGap + codeW
	chipH := 2*(L.ChipPadY+chipBorder) + lineH
	c.add(L.ChipMarginTop, chipH, func(y int) {
		x := c.rowX(chipW)
		// border-radius: 999px — clamped to a stadium by roundedRectAlpha.
		outer := roundedRectAlpha(chipW, chipH, float64(chipH)/2)
		inner := roundedRectAlpha(chipW-2*chipBorder, chipH-2*chipBorder, float64(chipH)/2-chipBorder)
		// The wash is translucent, so the 1px border has to be a RING;
		// an underlay would tint the whole pill (see drawJoinBar).
		drawMaskUniform(c.dst, inner, chipFill, x+chipBorder, y+chipBorder)
		drawMaskUniform(c.dst, ringAlpha(outer, inner, chipBorder, chipBorder),
			hexRGBA(tokenLilac, 0.32), x, y)
		tx := x + chipBorder + L.ChipPadX
		ty := y + chipBorder + L.ChipPadY
		drawRun(c.dst, labelFS, label, labelTrack, tx,
			ty+baselineIn(labelFS.resolve(label), float64(lineH)),
			rgba(255, 255, 255, 0.72))
		drawRun(c.dst, codeFS, c.d.Code, codeTrack, tx+labelW+L.ChipGap,
			ty+baselineIn(codeFS.resolve(c.d.Code), float64(lineH)),
			hexRGBA(0xFFFFFF, 1))
	})
	return nil
}

// ── Painters ────────────────────────────────────────────────────────

// paintStory lays out the 1080×1920 composition: one centred column with
// the poster in the middle of the stack, and the join bar pinned to the
// bottom edge.
//
// `.joinbar { margin-top: auto }` in a fixed-height flex column: the bar
// takes the FREE space, and when there is none the auto margin resolves to
// zero and the stack simply runs on. Reproducing that is what makes the
// render match the mockup at the design's own content — which, at
// 1080×1920, overruns the pinned position by ~21px, so the bar sits 35px
// off the bottom rather than the nominal 56.
func paintStory(dst *image.RGBA, L *cardLayout, lib *cardFontLibrary, d cardData) error {
	contentW := L.Width - 2*L.PadX
	c := newCardColumn(dst, L, lib, d, L.PadX, contentW, true)
	if err := c.addBrandline(); err != nil {
		return err
	}
	c.addPoster()
	if err := c.addTitle(); err != nil {
		return err
	}
	if err := c.addMeta(); err != nil {
		return err
	}
	c.addDivider()
	if err := c.addSchedule(); err != nil {
		return err
	}
	if err := c.addHostRow(); err != nil {
		return err
	}
	if err := c.addTagline(); err != nil {
		return err
	}

	floorTop := L.Height - L.JoinH - L.MinBottomPad
	y := paintStack(c.blocks, L.PadTop, floorTop)
	if c.err != nil {
		return c.err
	}

	joinTop := L.Height - L.PadBottom - L.JoinH
	if y > joinTop {
		joinTop = minInt(y, floorTop)
	}
	return drawJoinBar(dst, L, lib, image.Rect(L.PadX, joinTop, L.PadX+contentW, joinTop+L.JoinH), d)
}

// paintSideBySide lays out both reflowed crops — `square` (1080×1080) and
// `og` (1200×630). They are the same composition: `.content` turns into a
// row, the poster takes the left, and the whole stack sets flush left in
// the remaining column, vertically centred. Everything that distinguishes
// them — the type scale, the brand wording, whether a divider or a join
// bar or a code chip appears — is a value in the layout table, so one
// painter serves both rather than two near-copies drifting apart.
func paintSideBySide(dst *image.RGBA, L *cardLayout, lib *cardFontLibrary, d cardData) error {
	contentTop := L.PadTop
	contentH := L.Height - L.PadTop - L.PadBottom
	colX := L.PadX + L.PosterW + L.ContentGap
	colW := L.Width - 2*L.PadX - L.PosterW - L.ContentGap
	if colW <= 0 {
		return fmt.Errorf("card layout %q leaves no room for the text column", L.Variant)
	}

	// The poster is centred on the cross axis independently of the text
	// (`align-self: center` on square, `align-items: center` on og).
	posterY := contentTop + (contentH-L.PosterH)/2
	drawPoster(dst, L, image.Rect(L.PadX, posterY, L.PadX+L.PosterW, posterY+L.PosterH), d.Poster)

	c := newCardColumn(dst, L, lib, d, colX, colW, false)
	if err := c.addBrandline(); err != nil {
		return err
	}
	if err := c.addTitle(); err != nil {
		return err
	}
	if err := c.addMeta(); err != nil {
		return err
	}
	c.addDivider()
	if err := c.addSchedule(); err != nil {
		return err
	}
	if err := c.addHostRow(); err != nil {
		return err
	}
	if err := c.addTagline(); err != nil {
		return err
	}
	c.addJoinBar()
	if err := c.addCodeChip(); err != nil {
		return err
	}

	// Neither crop pins its CTA: the square's own `.joinbar` rule
	// overrides `margin-top: auto` with a real 38px margin, and the og
	// crop has no join bar at all. With no auto margin to absorb it, the
	// free space goes to centring the column.
	natural, _ := stackHeight(c.blocks)
	top := contentTop
	if slack := contentH - natural; slack > 0 {
		top += slack / 2
	}
	paintStack(c.blocks, top, L.Height-L.PadBottom)
	return c.err
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
	labelTrack := em(L.JoinLabelTrack, L.JoinLabelSize)
	codeTrack := em(L.JoinCodeTrack, L.JoinCodeSize)
	labelLineH := int(math.Round(L.JoinLabelSize * L.JoinLabelLineH))
	codeLineH := int(math.Round(L.JoinCodeSize * L.JoinCodeLineH))

	// Measure the text against the room actually left beside the QR. The
	// square's bar is 496px — barely half the story's — and an origin
	// longer than "aurorapro.app" would otherwise set straight under the
	// symbol. At the story's width nothing plausible reaches this.
	textW := r.Dx() - 2*L.JoinPadX
	if d.JoinURL != "" {
		textW -= L.QRSize + L.JoinTextGap
	}
	if textW < 0 {
		textW = 0
	}
	label := truncateToWidth(labelFS, strings.ToUpper(d.JoinLabel), labelTrack, textW)
	code := truncateToWidth(codeFS, d.Code, codeTrack, textW)

	stackH := labelLineH + L.JoinCodeMarginTop + codeLineH
	top := r.Min.Y + (h-stackH)/2
	x := r.Min.X + L.JoinPadX

	drawRun(dst, labelFS, label, labelTrack, x,
		top+baselineIn(labelFS.resolve(label), float64(labelLineH)),
		hexRGBA(tokenLilac, 0.80))
	drawRun(dst, codeFS, code, codeTrack, x,
		top+labelLineH+L.JoinCodeMarginTop+baselineIn(codeFS.resolve(code), float64(codeLineH)),
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
