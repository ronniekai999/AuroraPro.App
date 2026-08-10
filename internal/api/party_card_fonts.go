package api

import (
	"embed"
	"fmt"
	"log/slog"
	"strings"
	"sync"

	"golang.org/x/image/font"
	"golang.org/x/image/font/gofont/gobold"
	"golang.org/x/image/font/gofont/gomedium"
	"golang.org/x/image/font/gofont/goregular"
	"golang.org/x/image/font/opentype"
	"golang.org/x/image/font/sfnt"
)

// ============================================================
// Share-card typography — Bricolage Grotesque + Inter
// ============================================================
//
// The card must be set in the app's own faces (--font-display /
// --font-sans from static/redesign/app/src/index.css) or it isn't on
// brand. Two constraints rule out reusing the SPA's font files directly:
//
//   1. x/image/font/opentype reads TTF/OTF — not WOFF2, which is what
//      static/redesign/app/src/fonts/ ships.
//   2. Those are VARIABLE fonts, and opentype renders only a variable
//      font's default instance. Shipping the variable TTF would silently
//      set every 700/800 in the design at whatever the default weight
//      happens to be.
//
// So assets/fonts/ carries five STATIC instances — one binary per weight
// the design actually uses — generated from those same variable sources
// and redistributed under the SIL OFL 1.1 that both families ship with
// (see assets/fonts/OFL.txt). ~300 KB of binary, all told.
//
// Coverage: the vendored instances are Latin-subset (matching the SPA's
// own subsetting), so a title in Cyrillic or CJK has no glyphs here. A
// run containing any uncovered rune falls back to the Go project's
// gofont faces FOR THE WHOLE RUN rather than rendering a line of tofu
// with two readable words in it. gofont is also the whole-file fallback
// if the embedded TTFs ever fail to parse: a card set in the wrong
// typeface still communicates the party; a 500 does not.

//go:embed assets/fonts/*.ttf
var cardFontFS embed.FS

// cardFontRole names one vendored weight. The two families are addressed
// by role, not by file, so a Phase-2 variant asking for "display bold"
// can't accidentally reach for a face the design never specified.
type cardFontRole int

const (
	roleDisplayExtraBold cardFontRole = iota // Bricolage Grotesque 800 — title, time, code, avatar initial
	roleDisplayBold                          // Bricolage Grotesque 700 — brandline
	roleSansRegular                          // Inter 400 — tagline
	roleSansMedium                           // Inter 500 — meta line, "Hosted by"
	roleSansBold                             // Inter 700 — date caps, join label, host name
	cardFontRoleCount
)

// cardFontFiles maps each role to its embedded static instance.
var cardFontFiles = [cardFontRoleCount]string{
	roleDisplayExtraBold: "assets/fonts/BricolageGrotesque-ExtraBold.ttf",
	roleDisplayBold:      "assets/fonts/BricolageGrotesque-Bold.ttf",
	roleSansRegular:      "assets/fonts/Inter-Regular.ttf",
	roleSansMedium:       "assets/fonts/Inter-Medium.ttf",
	roleSansBold:         "assets/fonts/Inter-Bold.ttf",
}

// cardFallbackTTF maps each role onto the closest gofont weight, used
// when a run contains runes the brand face can't draw (and when the
// embedded TTFs fail to parse at all).
var cardFallbackTTF = [cardFontRoleCount][]byte{
	roleDisplayExtraBold: gobold.TTF,
	roleDisplayBold:      gobold.TTF,
	roleSansRegular:      goregular.TTF,
	roleSansMedium:       gomedium.TTF,
	roleSansBold:         gobold.TTF,
}

// faceSet is one role at one pixel size: the brand face, the gofont face
// at the same size, and a memoized rune-coverage test. Callers never pick
// between them — they hand a string to resolve() and draw with whatever
// comes back.
type faceSet struct {
	role    cardFontRole
	size    float64
	primary font.Face
	fallbck font.Face

	// brand is false when the embedded TTF failed to parse, in which case
	// primary IS the gofont face and coverage checks are pointless.
	brand bool

	sf  *sfnt.Font
	mu  sync.Mutex
	buf sfnt.Buffer
	cov map[rune]bool
}

// resolve returns the face that can actually draw s. Any single uncovered
// rune demotes the whole run — mixing two typefaces mid-title looks worse
// than setting the line in the fallback.
func (fs *faceSet) resolve(s string) font.Face {
	if !fs.brand || fs.sf == nil {
		return fs.primary
	}
	fs.mu.Lock()
	defer fs.mu.Unlock()
	for _, r := range s {
		if r == '\n' {
			continue
		}
		ok, seen := fs.cov[r]
		if !seen {
			idx, err := fs.sf.GlyphIndex(&fs.buf, r)
			ok = err == nil && idx != 0
			fs.cov[r] = ok
		}
		if !ok {
			return fs.fallbck
		}
	}
	return fs.primary
}

// cardFontLibrary owns the parsed fonts and a face cache keyed by
// (role, size). opentype.NewFace parses glyph tables on every call, and a
// single card asks for ~10 distinct faces; caching them across renders
// keeps a warm compose in the low tens of milliseconds.
type cardFontLibrary struct {
	brand    [cardFontRoleCount]*sfnt.Font
	fallback [cardFontRoleCount]*sfnt.Font
	// brandOK reports whether every vendored TTF parsed. False means the
	// whole card is set in gofont — worth a boot-time log, not a failure.
	brandOK bool

	mu    sync.Mutex
	faces map[faceKey]*faceSet
}

type faceKey struct {
	role cardFontRole
	// size in 1/64ths of a pixel so the key stays comparable without
	// float equality games.
	size64 int
}

var (
	cardFontsOnce sync.Once
	cardFontsInst *cardFontLibrary
	cardFontsErr  error
)

// cardFonts loads (once) the embedded brand faces plus the gofont
// fallbacks. An error here means even gofont failed to parse, which can
// only happen if the toolchain is broken.
func cardFonts() (*cardFontLibrary, error) {
	cardFontsOnce.Do(func() {
		lib := &cardFontLibrary{faces: make(map[faceKey]*faceSet), brandOK: true}
		var missing []string
		for role := cardFontRole(0); role < cardFontRoleCount; role++ {
			fb, err := opentype.Parse(cardFallbackTTF[role])
			if err != nil {
				cardFontsErr = fmt.Errorf("parse fallback font for role %d: %w", role, err)
				return
			}
			lib.fallback[role] = fb

			data, err := cardFontFS.ReadFile(cardFontFiles[role])
			if err == nil {
				var parsed *sfnt.Font
				if parsed, err = opentype.Parse(data); err == nil {
					lib.brand[role] = parsed
					continue
				}
			}
			lib.brandOK = false
			missing = append(missing, cardFontFiles[role])
		}
		if len(missing) > 0 {
			// Loud, once, at boot-ish time: a card silently set in the
			// wrong typeface is the kind of regression nobody files.
			slog.Warn("party card: brand fonts unavailable, falling back to gofont",
				"missing", strings.Join(missing, ","))
		}
		cardFontsInst = lib
	})
	return cardFontsInst, cardFontsErr
}

// face returns the cached faceSet for a role at a pixel size. DPI is 72 so
// opentype's "Size" is exactly the CSS em size in pixels — every number in
// the mockup's CSS can be passed through unscaled.
func (lib *cardFontLibrary) face(role cardFontRole, size float64) (*faceSet, error) {
	key := faceKey{role: role, size64: int(size*64 + 0.5)}
	lib.mu.Lock()
	defer lib.mu.Unlock()
	if fs, ok := lib.faces[key]; ok {
		return fs, nil
	}

	mk := func(f *sfnt.Font) (font.Face, error) {
		return opentype.NewFace(f, &opentype.FaceOptions{
			Size: size,
			DPI:  72,
			// Full hinting snaps stems to the pixel grid, which keeps the
			// 22px join label crisp. At 118px it is a no-op in practice.
			Hinting: font.HintingFull,
		})
	}

	fb, err := mk(lib.fallback[role])
	if err != nil {
		return nil, fmt.Errorf("build fallback face: %w", err)
	}
	fs := &faceSet{role: role, size: size, primary: fb, fallbck: fb, cov: map[rune]bool{}}
	if bf := lib.brand[role]; bf != nil {
		primary, err := mk(bf)
		if err != nil {
			return nil, fmt.Errorf("build brand face: %w", err)
		}
		fs.primary = primary
		fs.brand = true
		fs.sf = bf
	}
	lib.faces[key] = fs
	return fs, nil
}
