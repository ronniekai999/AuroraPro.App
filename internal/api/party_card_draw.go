package api

import (
	"image"
	"image/color"
	"image/draw"
	"math"

	xdraw "golang.org/x/image/draw"
	"golang.org/x/image/font"
	"golang.org/x/image/math/fixed"
	"golang.org/x/image/vector"
)

// ============================================================
// Share-card drawing primitives
// ============================================================
//
// Everything the compositor needs on top of image/draw, built only on
// golang.org/x/image (already a dependency): rounded-rect and circle
// alpha masks via vector.Rasterizer, CSS-angle linear gradients, a
// separable box blur standing in for Gaussian, and glyph-run drawing
// with letter-spacing (font.Drawer has no tracking, and the design leans
// on it hard — the brandline sets 0.42em).
//
// Colour convention: Go's color.RGBA is ALPHA-PREMULTIPLIED. Every helper
// here takes CSS-style straight (non-premultiplied) values and does the
// multiply itself, so the numbers in this package read exactly like the
// rgba() in the mockup's stylesheet.

// rgba builds a premultiplied color.RGBA from CSS-style straight
// components. alpha is 0..1.
func rgba(r, g, b uint8, alpha float64) color.RGBA {
	if alpha <= 0 {
		return color.RGBA{}
	}
	if alpha > 1 {
		alpha = 1
	}
	return color.RGBA{
		R: uint8(float64(r)*alpha + 0.5),
		G: uint8(float64(g)*alpha + 0.5),
		B: uint8(float64(b)*alpha + 0.5),
		A: uint8(255*alpha + 0.5),
	}
}

// hexRGBA builds a premultiplied color from a 0xRRGGBB literal, so the
// palette below can be transcribed straight out of index.css.
func hexRGBA(hex uint32, alpha float64) color.RGBA {
	return rgba(uint8(hex>>16), uint8(hex>>8), uint8(hex), alpha)
}

// Aurora tokens, lifted from static/redesign/app/src/index.css via the
// mockup's :root block. Nothing here is invented for the card.
const (
	tokenInk       = 0x050505 // --background
	tokenViolet    = 0xA855F7 // --stage-purple
	tokenVioletDp  = 0x7C3AED // --stage-purple-2
	tokenLilac     = 0xD8B4FE // --stage-purple-lt
	tokenIndigo    = 0x818CF8 // .aurora-ring mid stop
	tokenCyan      = 0x22D3EE // --stage-cyan
	tokenStarLilac = 0xC4B5FD
	tokenStarViol  = 0xE9D5FF
	tokenStarCyan  = 0xA5F3FC
)

// ── Gradients ───────────────────────────────────────────────────────

// gradStop is one CSS colour stop. Offset is 0..1 along the gradient
// line; the colour is STRAIGHT (non-premultiplied) with a separate alpha,
// matching how rgba() reads in the stylesheet.
type gradStop struct {
	Offset float64
	R      uint8
	G      uint8
	B      uint8
	A      float64
}

// stop is a terse constructor for a fully opaque hex stop.
func stop(offset float64, hex uint32) gradStop {
	return gradStop{Offset: offset, R: uint8(hex >> 16), G: uint8(hex >> 8), B: uint8(hex), A: 1}
}

// stopA is `stop` with an explicit alpha.
func stopA(offset float64, hex uint32, a float64) gradStop {
	s := stop(offset, hex)
	s.A = a
	return s
}

// sampleStops interpolates the stop list at t (clamped to 0..1) and
// returns a premultiplied colour. Interpolation happens in PREMULTIPLIED
// space, which is what CSS does and what keeps a fade to `transparent`
// from darkening through grey — the divider rule depends on it.
func sampleStops(stops []gradStop, t float64) color.RGBA {
	if len(stops) == 0 {
		return color.RGBA{}
	}
	if t <= stops[0].Offset {
		return rgba(stops[0].R, stops[0].G, stops[0].B, stops[0].A)
	}
	last := stops[len(stops)-1]
	if t >= last.Offset {
		return rgba(last.R, last.G, last.B, last.A)
	}
	for i := 1; i < len(stops); i++ {
		a, b := stops[i-1], stops[i]
		if t > b.Offset {
			continue
		}
		span := b.Offset - a.Offset
		f := 0.0
		if span > 0 {
			f = (t - a.Offset) / span
		}
		// Premultiply both ends, then lerp.
		ar, ag, ab, aa := float64(a.R)*a.A, float64(a.G)*a.A, float64(a.B)*a.A, a.A
		br, bg, bb, ba := float64(b.R)*b.A, float64(b.G)*b.A, float64(b.B)*b.A, b.A
		return color.RGBA{
			R: uint8(ar + (br-ar)*f + 0.5),
			G: uint8(ag + (bg-ag)*f + 0.5),
			B: uint8(ab + (bb-ab)*f + 0.5),
			A: uint8(255*(aa+(ba-aa)*f) + 0.5),
		}
	}
	return rgba(last.R, last.G, last.B, last.A)
}

// renderGradient materialises a CSS `linear-gradient(<angle>deg, …)` into
// an RGBA image of w×h. The gradient GEOMETRY is computed over `box` (the
// CSS element's border box) while the image may be larger — text masks
// carry padding for glyph overhang, and the gradient must not stretch to
// cover it. Pass image.Rect(0,0,w,h) when the two coincide.
//
// CSS angle semantics: 0deg points to the top and angles run clockwise,
// so the gradient direction is (sin θ, −cos θ) in screen coordinates.
// The gradient line's length is |W·sinθ| + |H·cosθ|.
func renderGradient(w, h int, box image.Rectangle, angleDeg float64, stops []gradStop) *image.RGBA {
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	if w <= 0 || h <= 0 {
		return dst
	}
	th := angleDeg * math.Pi / 180
	sin, cos := math.Sin(th), math.Cos(th)
	bw, bh := float64(box.Dx()), float64(box.Dy())
	length := math.Abs(bw*sin) + math.Abs(bh*cos)
	if length <= 0 {
		length = 1
	}
	cx := float64(box.Min.X) + bw/2
	cy := float64(box.Min.Y) + bh/2

	// Precompute a 256-entry ramp — sampleStops is a linear scan and the
	// gradient can cover a megapixel.
	var ramp [256]color.RGBA
	for i := range ramp {
		ramp[i] = sampleStops(stops, float64(i)/255)
	}

	for y := 0; y < h; y++ {
		py := float64(y) + 0.5 - cy
		row := dst.Pix[y*dst.Stride:]
		for x := 0; x < w; x++ {
			px := float64(x) + 0.5 - cx
			t := (px*sin-py*cos)/length + 0.5
			idx := int(t*255 + 0.5)
			if idx < 0 {
				idx = 0
			} else if idx > 255 {
				idx = 255
			}
			c := ramp[idx]
			o := x * 4
			row[o], row[o+1], row[o+2], row[o+3] = c.R, c.G, c.B, c.A
		}
	}
	return dst
}

// ── Masks ───────────────────────────────────────────────────────────

const kappa = 0.5522847498307936 // circle-from-cubics constant

// roundedRectAlpha rasterises a w×h rounded rectangle into an alpha mask.
// radius is clamped to half the shorter side, so passing a huge radius
// yields a stadium/circle (which is how the avatar and the code chip are
// drawn).
func roundedRectAlpha(w, h int, radius float64) *image.Alpha {
	dst := image.NewAlpha(image.Rect(0, 0, w, h))
	if w <= 0 || h <= 0 {
		return dst
	}
	fw, fh := float32(w), float32(h)
	r := float32(radius)
	if r > fw/2 {
		r = fw / 2
	}
	if r > fh/2 {
		r = fh / 2
	}
	if r < 0 {
		r = 0
	}
	k := r * float32(kappa)

	ras := vector.NewRasterizer(w, h)
	ras.MoveTo(r, 0)
	ras.LineTo(fw-r, 0)
	ras.CubeTo(fw-r+k, 0, fw, r-k, fw, r)
	ras.LineTo(fw, fh-r)
	ras.CubeTo(fw, fh-r+k, fw-r+k, fh, fw-r, fh)
	ras.LineTo(r, fh)
	ras.CubeTo(r-k, fh, 0, fh-r+k, 0, fh-r)
	ras.LineTo(0, r)
	ras.CubeTo(0, r-k, r-k, 0, r, 0)
	ras.ClosePath()
	ras.Draw(dst, dst.Bounds(), image.Opaque, image.Point{})
	return dst
}

// ellipseAlpha rasterises a w×h ellipse (CSS `border-radius: 50%`).
func ellipseAlpha(w, h int) *image.Alpha {
	return roundedRectAlpha(w, h, math.Max(float64(w), float64(h)))
}

// ringAlpha subtracts `inner` (placed at offset dx,dy) from `outer`,
// yielding the border band between them. A 1px CSS border has to be drawn
// as a ring, not as a filled rect with the panel painted over it: the
// panel is translucent, so an underlay tints the entire surface — which
// is exactly how the join bar came out 40% too bright the first time.
func ringAlpha(outer, inner *image.Alpha, dx, dy int) *image.Alpha {
	ob := outer.Bounds()
	ring := image.NewAlpha(image.Rect(0, 0, ob.Dx(), ob.Dy()))
	copy(ring.Pix, outer.Pix)
	ib := inner.Bounds()
	for y := 0; y < ib.Dy(); y++ {
		ry := y + dy
		if ry < 0 || ry >= ob.Dy() {
			continue
		}
		for x := 0; x < ib.Dx(); x++ {
			rx := x + dx
			if rx < 0 || rx >= ob.Dx() {
				continue
			}
			o := ry*ring.Stride + rx
			v := int(ring.Pix[o]) - int(inner.Pix[y*inner.Stride+x])
			if v < 0 {
				v = 0
			}
			ring.Pix[o] = uint8(v)
		}
	}
	return ring
}

// ── Blur ────────────────────────────────────────────────────────────

// boxRadiusForSigma converts a Gaussian standard deviation into the box
// radius whose THREE-pass box blur has the same variance. Three boxes of
// radius r give σ² = ((2r+1)²−1)/4, so r = (√(4σ²+1) − 1)/2. Three passes
// is the classic "close enough to Gaussian" trade and stays O(n) per pass.
func boxRadiusForSigma(sigma float64) int {
	if sigma <= 0 {
		return 0
	}
	r := (math.Sqrt(4*sigma*sigma+1) - 1) / 2
	if r < 1 {
		return 1
	}
	return int(r + 0.5)
}

// blurRGBA applies a 3-pass separable box blur in place-ish (returns a new
// image). Operating on image.RGBA means we are blurring PREMULTIPLIED
// channels, which is the correct space — blurring straight alpha would
// halo the colour out past the shape's edge.
func blurRGBA(src *image.RGBA, sigma float64) *image.RGBA {
	r := boxRadiusForSigma(sigma)
	if r <= 0 {
		return src
	}
	cur := src
	for i := 0; i < 3; i++ {
		cur = boxBlurRGBAOnce(cur, r)
	}
	return cur
}

func boxBlurRGBAOnce(src *image.RGBA, radius int) *image.RGBA {
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	tmp := image.NewRGBA(image.Rect(0, 0, w, h))
	out := image.NewRGBA(image.Rect(0, 0, w, h))
	if w == 0 || h == 0 {
		return out
	}
	win := float64(2*radius + 1)

	// Horizontal pass with a running sum.
	for y := 0; y < h; y++ {
		srow := src.Pix[(y+b.Min.Y-src.Rect.Min.Y)*src.Stride+(b.Min.X-src.Rect.Min.X)*4:]
		trow := tmp.Pix[y*tmp.Stride:]
		var s [4]int
		for i := -radius; i <= radius; i++ {
			x := clampInt(i, 0, w-1) * 4
			for c := 0; c < 4; c++ {
				s[c] += int(srow[x+c])
			}
		}
		for x := 0; x < w; x++ {
			o := x * 4
			for c := 0; c < 4; c++ {
				trow[o+c] = uint8(float64(s[c])/win + 0.5)
			}
			add := clampInt(x+radius+1, 0, w-1) * 4
			sub := clampInt(x-radius, 0, w-1) * 4
			for c := 0; c < 4; c++ {
				s[c] += int(srow[add+c]) - int(srow[sub+c])
			}
		}
	}

	// Vertical pass.
	for x := 0; x < w; x++ {
		var s [4]int
		for i := -radius; i <= radius; i++ {
			y := clampInt(i, 0, h-1)
			o := y*tmp.Stride + x*4
			for c := 0; c < 4; c++ {
				s[c] += int(tmp.Pix[o+c])
			}
		}
		for y := 0; y < h; y++ {
			o := y*out.Stride + x*4
			for c := 0; c < 4; c++ {
				out.Pix[o+c] = uint8(float64(s[c])/win + 0.5)
			}
			addY := clampInt(y+radius+1, 0, h-1)*tmp.Stride + x*4
			subY := clampInt(y-radius, 0, h-1)*tmp.Stride + x*4
			for c := 0; c < 4; c++ {
				s[c] += int(tmp.Pix[addY+c]) - int(tmp.Pix[subY+c])
			}
		}
	}
	return out
}

// blurAlphaPadded is what shadows actually want: the box blur clamps at
// the source's edge (replicating the border row), so blurring a filled
// rect inside its own bounds leaves the interior solid and the edges
// hard — no glow at all. Growing the canvas by 3σ first gives the blur
// somewhere to spread. The returned offset is how far the result's origin
// sits ABOVE-LEFT of the input's, so callers draw at (x-off, y-off).
func blurAlphaPadded(src *image.Alpha, sigma float64) (*image.Alpha, int) {
	if sigma <= 0 {
		return src, 0
	}
	pad := int(math.Ceil(3 * sigma))
	b := src.Bounds()
	grown := image.NewAlpha(image.Rect(0, 0, b.Dx()+2*pad, b.Dy()+2*pad))
	for y := 0; y < b.Dy(); y++ {
		copy(grown.Pix[(y+pad)*grown.Stride+pad:(y+pad)*grown.Stride+pad+b.Dx()],
			src.Pix[y*src.Stride:y*src.Stride+b.Dx()])
	}
	return blurAlpha(grown, sigma), pad
}

// blurAlpha is the single-channel twin of blurRGBA. Prefer
// blurAlphaPadded for anything that needs to glow OUTSIDE its own shape.
func blurAlpha(src *image.Alpha, sigma float64) *image.Alpha {
	r := boxRadiusForSigma(sigma)
	if r <= 0 {
		return src
	}
	cur := src
	for i := 0; i < 3; i++ {
		cur = boxBlurAlphaOnce(cur, r)
	}
	return cur
}

func boxBlurAlphaOnce(src *image.Alpha, radius int) *image.Alpha {
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	tmp := image.NewAlpha(image.Rect(0, 0, w, h))
	out := image.NewAlpha(image.Rect(0, 0, w, h))
	if w == 0 || h == 0 {
		return out
	}
	win := float64(2*radius + 1)
	for y := 0; y < h; y++ {
		srow := src.Pix[(y+b.Min.Y-src.Rect.Min.Y)*src.Stride+(b.Min.X-src.Rect.Min.X):]
		trow := tmp.Pix[y*tmp.Stride:]
		s := 0
		for i := -radius; i <= radius; i++ {
			s += int(srow[clampInt(i, 0, w-1)])
		}
		for x := 0; x < w; x++ {
			trow[x] = uint8(float64(s)/win + 0.5)
			s += int(srow[clampInt(x+radius+1, 0, w-1)]) - int(srow[clampInt(x-radius, 0, w-1)])
		}
	}
	for x := 0; x < w; x++ {
		s := 0
		for i := -radius; i <= radius; i++ {
			s += int(tmp.Pix[clampInt(i, 0, h-1)*tmp.Stride+x])
		}
		for y := 0; y < h; y++ {
			out.Pix[y*out.Stride+x] = uint8(float64(s)/win + 0.5)
			s += int(tmp.Pix[clampInt(y+radius+1, 0, h-1)*tmp.Stride+x]) -
				int(tmp.Pix[clampInt(y-radius, 0, h-1)*tmp.Stride+x])
		}
	}
	return out
}

// (clampInt lives in feedback_handlers.go — same package, same contract.)

// ── Text ────────────────────────────────────────────────────────────

// runAdvance measures a glyph run including kerning and letter-spacing.
// CSS adds tracking AFTER every character including the last; for
// centring we want the optical extent, so the trailing gap is excluded
// (a 0.42em brandline would otherwise sit 6px left of centre).
func runAdvance(face font.Face, s string, tracking fixed.Int26_6) fixed.Int26_6 {
	var total fixed.Int26_6
	prev := rune(-1)
	for i, r := range s {
		if i > 0 {
			total += face.Kern(prev, r) + tracking
		}
		adv, ok := face.GlyphAdvance(r)
		if !ok {
			adv, _ = face.GlyphAdvance(' ')
		}
		total += adv
		prev = r
	}
	return total
}

// textMask renders a glyph run into an alpha mask. The returned mask has
// the pen origin at (padX, baseline) — draw it at
// (penX-padX, baseY-baseline) to land the run's first glyph at penX with
// its baseline on baseY. advance is the run's optical width.
//
// The pad absorbs glyph overhang (left side bearings, descenders on the
// following line, the tail of an italic shear). 40% of the em is generous
// for Latin and costs a few hundred KB on the largest run.
func textMask(face font.Face, s string, tracking fixed.Int26_6) (mask *image.Alpha, padX, baseline, advance int) {
	m := face.Metrics()
	asc := m.Ascent.Ceil()
	desc := m.Descent.Ceil()
	pad := (asc + desc) * 4 / 10
	if pad < 4 {
		pad = 4
	}
	adv := runAdvance(face, s, tracking).Ceil()
	w := adv + 2*pad
	h := asc + desc + 2*pad
	mask = image.NewAlpha(image.Rect(0, 0, w, h))
	baseline = pad + asc
	padX = pad

	dot := fixed.P(pad, baseline)
	prev := rune(-1)
	for i, r := range s {
		if i > 0 {
			dot.X += face.Kern(prev, r) + tracking
		}
		dr, gmask, maskp, gadv, ok := face.Glyph(dot, r)
		if !ok {
			dr, gmask, maskp, gadv, ok = face.Glyph(dot, ' ')
		}
		if ok {
			draw.DrawMask(mask, dr, image.Opaque, image.Point{}, gmask, maskp, draw.Over)
		}
		dot.X += gadv
		prev = r
	}
	return mask, padX, baseline, adv
}

// shearAlpha slants a mask by `tan` around `baseline`, synthesising an
// oblique from an upright face. Inter ships no italic in our static set,
// and the tagline is the one place the design asks for one.
func shearAlpha(src *image.Alpha, baseline int, tan float64) (*image.Alpha, int) {
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	// Above the baseline the run leans right, below it leans left; widen
	// by the larger excursion and shift the origin by the lower one.
	maxShift := int(math.Ceil(tan * float64(baseline)))
	minShift := int(math.Floor(tan * float64(baseline-h)))
	out := image.NewAlpha(image.Rect(0, 0, w+maxShift-minShift, h))
	for y := 0; y < h; y++ {
		shift := int(math.Round(tan*float64(baseline-y))) - minShift
		srow := src.Pix[y*src.Stride:]
		orow := out.Pix[y*out.Stride:]
		for x := 0; x < w; x++ {
			ox := x + shift
			if ox < 0 || ox >= out.Rect.Dx() {
				continue
			}
			orow[ox] = srow[x]
		}
	}
	return out, -minShift
}

// drawMaskAt composites `src` through `mask` onto dst, positioning the
// mask's origin at (x, y) and aligning src's origin with it.
func drawMaskAt(dst draw.Image, mask *image.Alpha, src image.Image, x, y int) {
	b := mask.Bounds()
	r := image.Rect(x, y, x+b.Dx(), y+b.Dy())
	draw.DrawMask(dst, r, src, src.Bounds().Min, mask, b.Min, draw.Over)
}

// drawMaskUniform is drawMaskAt with a flat colour.
func drawMaskUniform(dst draw.Image, mask *image.Alpha, c color.Color, x, y int) {
	b := mask.Bounds()
	r := image.Rect(x, y, x+b.Dx(), y+b.Dy())
	draw.DrawMask(dst, r, &image.Uniform{C: c}, image.Point{}, mask, b.Min, draw.Over)
}

// ── Poster ──────────────────────────────────────────────────────────

// coverScale draws src into dst's rect the way CSS `background-size:
// cover` does: scale to fill, centre, crop the overflow. TMDB posters are
// 2:3 like the slot, so this is usually a straight resize — but a TVDB
// artwork of a different ratio must not letterbox inside the frame.
func coverScale(dst draw.Image, r image.Rectangle, src image.Image) {
	sb := src.Bounds()
	if sb.Dx() <= 0 || sb.Dy() <= 0 || r.Dx() <= 0 || r.Dy() <= 0 {
		return
	}
	dstAR := float64(r.Dx()) / float64(r.Dy())
	srcAR := float64(sb.Dx()) / float64(sb.Dy())
	crop := sb
	if srcAR > dstAR {
		// Source too wide — trim the sides.
		nw := int(float64(sb.Dy())*dstAR + 0.5)
		off := (sb.Dx() - nw) / 2
		crop = image.Rect(sb.Min.X+off, sb.Min.Y, sb.Min.X+off+nw, sb.Max.Y)
	} else if srcAR < dstAR {
		nh := int(float64(sb.Dx())/dstAR + 0.5)
		off := (sb.Dy() - nh) / 2
		crop = image.Rect(sb.Min.X, sb.Min.Y+off, sb.Max.X, sb.Min.Y+off+nh)
	}
	xdraw.CatmullRom.Scale(dst, r, src, crop, draw.Src, nil)
}

// ── Noise ───────────────────────────────────────────────────────────

// hashNoise is a deterministic per-pixel value in [0,256) derived from
// (x, y, seed). Same card, same grain, every render — which matters
// because the disk cache can be regenerated at any time and a shifting
// grain field would make two "identical" cards differ byte-for-byte.
func hashNoise(x, y int, seed uint32) uint32 {
	h := seed
	h ^= uint32(x) * 0x9E3779B1
	h = h*0x85EBCA6B ^ (h >> 13)
	h ^= uint32(y) * 0xC2B2AE35
	h = h*0x27D4EB2F ^ (h >> 16)
	return h >> 24
}

// applyGrain overlays deterministic film grain. CSS uses
// `mix-blend-mode: overlay` at 16%, and overlay is what keeps the grain
// from washing out the near-black ground: on dark pixels it barely
// moves them, on the bright poster and the gradient time it adds tooth.
func applyGrain(dst *image.RGBA, strength float64, seed uint32) {
	if strength <= 0 {
		return
	}
	b := dst.Bounds()
	for y := b.Min.Y; y < b.Max.Y; y++ {
		row := dst.Pix[(y-dst.Rect.Min.Y)*dst.Stride:]
		for x := b.Min.X; x < b.Max.X; x++ {
			n := float64(hashNoise(x, y, seed)) / 255
			o := (x - dst.Rect.Min.X) * 4
			for c := 0; c < 3; c++ {
				base := float64(row[o+c]) / 255
				var blended float64
				if base < 0.5 {
					blended = 2 * base * n
				} else {
					blended = 1 - 2*(1-base)*(1-n)
				}
				v := base + (blended-base)*strength
				row[o+c] = uint8(clampF(v, 0, 1)*255 + 0.5)
			}
		}
	}
}

func clampF(v, lo, hi float64) float64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}
