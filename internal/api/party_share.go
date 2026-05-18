package api

import (
	"bytes"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/jpeg"
	"image/png"
	"io"
	"log/slog"
	"net/http"
	neturl "net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/aurora-media/aurora/internal/watchparty"
	"github.com/go-chi/chi/v5"
	"golang.org/x/image/font"
	"golang.org/x/image/font/gofont/gobold"
	"golang.org/x/image/font/gofont/goregular"
	"golang.org/x/image/font/opentype"
	xdraw "golang.org/x/image/draw"
	"golang.org/x/image/math/fixed"
)

// shareAllowedImageHosts mirrors internal/metadata/imageproxy.go's
// allowedImageHosts. Duplicated here (not imported) to keep the security
// boundary intentional — if metadata changes its allowlist, the share
// endpoint shouldn't silently inherit. If we add a new image source for
// posters, BOTH lists need updating, and grep'ing for the allowlist
// surfaces both call sites.
//
// Security note: this defends against SSRF if `MediaPoster` is ever set
// from a non-trusted source (TVDB enrichment, scanner fallback, manual DB
// edit). The original posterFallback paths can populate this field with
// full URLs, so we MUST validate before fetch — the prefix check on its
// own is not sufficient (an attacker could craft a URL beginning with
// "https://image.tmdb.org" that 302s to internal infrastructure).
var shareAllowedImageHosts = map[string]bool{
	"image.tmdb.org":       true,
	"artworks.thetvdb.com": true,
	"www.thetvdb.com":      true,
	"thetvdb.com":          true,
}

// isShareImageHostAllowed returns true if the URL's host is in the
// allowlist. URL must be a fully-formed http(s) URL. Lowercase comparison.
func isShareImageHostAllowed(rawURL string) bool {
	parsed, err := neturl.Parse(rawURL)
	if err != nil {
		return false
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return false
	}
	return shareAllowedImageHosts[strings.ToLower(parsed.Hostname())]
}

// Party share image generation — Phase 2 of the watch-party "social" feature.
//
// This endpoint produces a 1080×1920 PNG suitable for posting to social media
// stories (Instagram Story, Snapchat, etc — all of which use that aspect
// ratio). The image composites:
//   - The movie/show poster, scaled to fit
//   - A dark gradient overlay for legibility
//   - The party name + media title in white text
//   - The 6-character party code in large monospace text at the bottom
//   - "Aurora" branding
//
// The endpoint is UNAUTHENTICATED by design. Per the user's "tease-only"
// model: strangers seeing the share post on social media see only an image
// — they still need an Aurora account to actually join. Knowing the party
// code alone gives no access. This means we can serve the image publicly
// without leaking sensitive state.
//
// Generated images are cached on disk per-party-code to avoid re-rendering
// the same image on every social-media crawler hit. Cache lifetime equals
// the party's lifetime; we clean up the cache file when the party ends
// (best-effort).

const (
	shareImgWidth  = 1080
	shareImgHeight = 1920

	// posterMaxHeight is how much vertical space the poster gets in the
	// composition. The poster is scaled to fit within this height while
	// preserving its 2:3 aspect ratio (TMDB posters are always 2:3).
	posterMaxHeight = 1280
	posterTopMargin = 120
)

// PartyShareHandler exposes a single endpoint for generating shareable
// images of watch parties. Depends on the watch party manager (for live
// party lookup) and a cache directory for disk-cached output PNGs.
type PartyShareHandler struct {
	manager  *watchparty.Manager
	cacheDir string

	// Font faces are lazily initialized once on first use and reused
	// across all renders. opentype.NewFace is non-trivially expensive
	// (parses TTF, builds glyph tables) so caching matters even on a
	// per-request basis. Sync'd because the first concurrent renders
	// after boot would otherwise race on initialization.
	fontOnce      sync.Once
	fontInitErr   error
	codeFace      font.Face // huge, bold — for the 6-char party code
	titleFace     font.Face // medium — for the media title
	subtitleFace  font.Face // small — for "Aurora" branding
	partyNameFace font.Face // medium — for the party name
}

// NewPartyShareHandler creates the handler. cacheDir should be a writable
// directory; rendered PNGs are stored as `<cacheDir>/party-share/<code>.png`.
//
// Side effect: kicks off a background reaper goroutine that walks the
// cache directory and deletes PNGs older than partyShareCacheMaxAge.
// InvalidateCache is the primary cleanup path (called when a party
// ends) but if a party crashes or InvalidateCache is somehow missed,
// the reaper bounds long-tail disk growth. Bug-bash May 14 L13 fix.
// Runs once on startup then every partyShareReaperInterval.
func NewPartyShareHandler(manager *watchparty.Manager, cacheDir string) *PartyShareHandler {
	h := &PartyShareHandler{
		manager:  manager,
		cacheDir: cacheDir,
	}
	go h.runReaper()
	return h
}

// partyShareCacheMaxAge bounds how long a cached share image lives if
// InvalidateCache never fires for it. 30 days is generous — a party
// poster shared to a story is usually consumed within hours, but the
// long tail accommodates "link forwarded a week later" while still
// reclaiming disk eventually. Tunable via env if operators ever need
// to crank it tighter or looser.
const partyShareCacheMaxAge = 30 * 24 * time.Hour

// partyShareReaperInterval is how often the reaper sweeps. Cache writes
// are infrequent (handful per day on a personal server) so daily is
// more than enough — the goal is preventing a runaway, not real-time
// eviction. Daily also matches our 24h hero/discover TTLs, keeping
// background-task cadence aligned across the system.
const partyShareReaperInterval = 24 * time.Hour

// runReaper periodically scans cacheDir/party-share/ and deletes PNGs
// older than partyShareCacheMaxAge. Runs forever in a goroutine
// launched from NewPartyShareHandler. Best-effort — any filesystem
// error is logged at Warn and the next tick retries.
//
// Sweep cost: O(N files), bounded by catalog size of historical party
// codes. Even at 10k parties, walking is sub-second on any reasonable
// disk. No mutex needed — files we read here are independent of
// InvalidateCache's deletes (sync.Map of read-write file paths is
// fine because reads and deletes both go through the FS layer's own
// concurrency).
func (h *PartyShareHandler) runReaper() {
	// First sweep on startup so a long-running process that's been
	// down for weeks reclaims immediately rather than waiting a full
	// interval. Same shape as a cron `@reboot` job + daily run.
	h.reapOnce()
	ticker := time.NewTicker(partyShareReaperInterval)
	defer ticker.Stop()
	for range ticker.C {
		h.reapOnce()
	}
}

// reapOnce performs a single sweep. Extracted so tests can call it
// directly without waiting for the ticker.
func (h *PartyShareHandler) reapOnce() {
	dir := filepath.Join(h.cacheDir, "party-share")
	entries, err := os.ReadDir(dir)
	if err != nil {
		// Missing directory is not an error — it just means no
		// images have been cached yet. Other errors (permissions,
		// I/O) are worth logging at Debug since they're persistent
		// and the operator's logs already get noisy.
		if !os.IsNotExist(err) {
			slog.Debug("party share reaper: read dir failed", "dir", dir, "error", err)
		}
		return
	}
	now := time.Now()
	reaped := 0
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		if now.Sub(info.ModTime()) <= partyShareCacheMaxAge {
			continue
		}
		path := filepath.Join(dir, e.Name())
		if err := os.Remove(path); err != nil {
			slog.Debug("party share reaper: remove failed", "path", path, "error", err)
			continue
		}
		reaped++
	}
	if reaped > 0 {
		slog.Info("party share reaper: swept stale cache files", "count", reaped, "older_than", partyShareCacheMaxAge)
	}
}

// initFonts lazily parses the embedded gofont TTF data and builds Face
// instances at the sizes we need. Idempotent via sync.Once.
//
// gofont is the Go project's official typeface — it ships embedded as []byte
// in golang.org/x/image/font/gofont/..., so no font files need to live in
// the repo and no new dependencies are needed.
func (h *PartyShareHandler) initFonts() error {
	h.fontOnce.Do(func() {
		boldFont, err := opentype.Parse(gobold.TTF)
		if err != nil {
			h.fontInitErr = fmt.Errorf("parse bold font: %w", err)
			return
		}
		regularFont, err := opentype.Parse(goregular.TTF)
		if err != nil {
			h.fontInitErr = fmt.Errorf("parse regular font: %w", err)
			return
		}

		// Helper to build a Face at a given size. DPI=72 is the standard
		// 1 unit per pixel; hinting=full makes glyphs sharp at small sizes
		// (we use it across the board for consistency, even on the huge
		// party-code face — overhead is negligible).
		mkFace := func(f *opentype.Font, size float64) (font.Face, error) {
			return opentype.NewFace(f, &opentype.FaceOptions{
				Size:    size,
				DPI:     72,
				Hinting: font.HintingFull,
			})
		}

		// Party code: 140pt bold. Dropped from 160pt because 6 of the
		// widest glyph in the alphabet (W) measured ~980px at 160pt —
		// over the 920px max-width. 140pt gives ~860px worst-case for
		// all-W, leaving comfortable margin. Mid-character codes like
		// "ABCDEF" render at ~540px regardless.
		h.codeFace, h.fontInitErr = mkFace(boldFont, 140)
		if h.fontInitErr != nil {
			return
		}
		// Media title: 56pt regular. Big enough to be the visual anchor
		// after the poster.
		h.titleFace, h.fontInitErr = mkFace(regularFont, 56)
		if h.fontInitErr != nil {
			return
		}
		// "Aurora" branding: 36pt regular.
		h.subtitleFace, h.fontInitErr = mkFace(regularFont, 36)
		if h.fontInitErr != nil {
			return
		}
		// Party name: 44pt bold. Sized between title and subtitle.
		h.partyNameFace, h.fontInitErr = mkFace(boldFont, 44)
	})
	return h.fontInitErr
}

// ServeShareImage handles GET /api/parties/{code}/share-image.png.
// Unauthenticated by design (see file-level comment).
func (h *PartyShareHandler) ServeShareImage(w http.ResponseWriter, r *http.Request) {
	code := strings.ToUpper(chi.URLParam(r, "code"))
	if len(code) != 6 {
		writeError(w, http.StatusBadRequest, "invalid party code")
		return
	}

	// Hit the disk cache first. The party-code namespace is small (10s of
	// active parties typically) and individual images are <500KB so disk
	// pressure is negligible. Even a cache hit re-serves the bytes through
	// http.ServeContent for proper If-Modified-Since handling.
	cachePath := h.cachePath(code)
	if f, err := os.Open(cachePath); err == nil {
		defer f.Close()
		info, _ := f.Stat()
		w.Header().Set("Content-Type", "image/png")
		w.Header().Set("Cache-Control", "public, max-age=300")
		if info != nil {
			http.ServeContent(w, r, "party-share.png", info.ModTime(), f)
		} else {
			_, _ = io.Copy(w, f)
		}
		return
	}

	// Cache miss — look up the party in live state. If not active, 404.
	// We don't fall back to the DB for ended parties; sharing a closed
	// party is a non-goal and would create stale-image confusion.
	ps := h.manager.GetPartyState(code)
	if ps == nil {
		writeError(w, http.StatusNotFound, "party not found or has ended")
		return
	}

	ps.Lock()
	partyName := ps.PartyName
	mediaTitle := ps.MediaTitle
	mediaPoster := ps.MediaPoster
	ps.Unlock()

	// Build the image. Failures are logged + return 500; we don't try
	// half-measures because a half-broken image posted to Instagram is
	// worse than a missing image (people just don't share again).
	imgBytes, err := h.composeShareImage(code, partyName, mediaTitle, mediaPoster)
	if err != nil {
		slog.Warn("party share image compose failed", "code", code, "error", err)
		writeError(w, http.StatusInternalServerError, "failed to generate share image")
		return
	}

	// Write to disk cache best-effort, then serve. If the cache write
	// fails we still serve the response — cache is an optimization, not
	// a correctness requirement.
	if err := h.writeCache(cachePath, imgBytes); err != nil {
		slog.Debug("party share image cache write failed", "code", code, "error", err)
	}

	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "public, max-age=300")
	_, _ = w.Write(imgBytes)
}

// cachePath returns the on-disk path for a party's cached share image.
func (h *PartyShareHandler) cachePath(code string) string {
	return filepath.Join(h.cacheDir, "party-share", code+".png")
}

// writeCache writes the PNG bytes to disk. Creates the directory if missing.
func (h *PartyShareHandler) writeCache(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	// Write atomically via tmp + rename so concurrent reads can't see a
	// half-written file.
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// composeShareImage builds the PNG bytes. Returns the encoded data ready
// to write to disk or the response.
//
// Layout (1080×1920):
//   - Background: solid dark
//   - y=120-1400: poster centered, scaled to fit 1280px height (preserve 2:3)
//   - y=1480: party name (bold, 44pt)
//   - y=1560: media title (regular, 56pt)
//   - y=1720: party code (huge, 160pt bold)
//   - y=1860: "Watch on Aurora" branding (regular, 36pt)
func (h *PartyShareHandler) composeShareImage(code, partyName, mediaTitle, mediaPoster string) ([]byte, error) {
	if err := h.initFonts(); err != nil {
		return nil, fmt.Errorf("init fonts: %w", err)
	}

	bgColor := color.RGBA{R: 12, G: 10, B: 24, A: 255}    // deep navy/purple, matches Aurora palette
	textColor := color.RGBA{R: 244, G: 240, B: 255, A: 255} // near-white with a hint of purple
	accentColor := color.RGBA{R: 167, G: 139, B: 250, A: 255} // Aurora accent (matches the frontend --accent)

	rgba := image.NewRGBA(image.Rect(0, 0, shareImgWidth, shareImgHeight))
	draw.Draw(rgba, rgba.Bounds(), &image.Uniform{C: bgColor}, image.Point{}, draw.Src)

	// 1. Composite the poster if we can fetch one. Failure is non-fatal:
	// the rest of the image still renders without a poster (just text on
	// the bg color), which is acceptable for a party with no poster
	// metadata.
	if mediaPoster != "" {
		if posterImg, err := h.fetchPosterImage(mediaPoster); err == nil {
			h.drawScaledPoster(rgba, posterImg)
		} else {
			slog.Debug("party share: poster fetch failed", "poster", mediaPoster, "error", err)
		}
	}

	// 2. Party name (above title, bold).
	if partyName != "" {
		h.drawCenteredText(rgba, partyName, 1480, h.partyNameFace, accentColor)
	}

	// 3. Media title.
	h.drawCenteredText(rgba, mediaTitle, 1560, h.titleFace, textColor)

	// 4. Party code (huge, monospace effect via wide spacing).
	h.drawCenteredText(rgba, code, 1720, h.codeFace, textColor)

	// 5. Branding.
	h.drawCenteredText(rgba, "WATCH ON AURORA", 1860, h.subtitleFace, accentColor)

	var buf bytes.Buffer
	if err := png.Encode(&buf, rgba); err != nil {
		return nil, fmt.Errorf("encode png: %w", err)
	}
	return buf.Bytes(), nil
}

// fetchPosterImage retrieves the poster from a trusted image source.
// Aurora's MediaPoster field stores either a TMDB-style path (e.g.
// /abc123.jpg) or a full URL from TVDB/scanner enrichment; this function
// handles both. Returns a decoded image.Image.
//
// SSRF defense: full URLs are validated against shareAllowedImageHosts
// BEFORE the request, and the http.Client's CheckRedirect re-validates
// every hop. Without CheckRedirect, an attacker could publish a poster
// URL at an allowed host that 302s to internal infrastructure (e.g.
// http://169.254.169.254/latest/meta-data/ on EC2). Mirrors the defense
// pattern in internal/metadata/imageproxy.go.
func (h *PartyShareHandler) fetchPosterImage(mediaPoster string) (image.Image, error) {
	url := mediaPoster
	isExternal := strings.HasPrefix(url, "http://") || strings.HasPrefix(url, "https://")
	if !isExternal {
		// TMDB path — use the w780 size for quality/bandwidth balance.
		// The composition scales it down to ~720×1080 anyway, so going
		// larger than w780 just wastes bytes. Path-style media_poster is
		// always TMDB by convention (TVDB enrichment writes full URLs).
		url = "https://image.tmdb.org/t/p/w780" + url
	} else {
		// External URL — validate against allowlist before issuing the
		// request. Rejecting here prevents the SSRF gadget where an
		// attacker writes a non-TMDB URL into a media item's poster
		// field via TVDB enrichment or direct DB edit.
		if !isShareImageHostAllowed(url) {
			return nil, fmt.Errorf("poster host not in allowlist")
		}
	}

	client := &http.Client{
		Timeout: 10 * time.Second,
		// Re-validate the host on every redirect. An allowlisted host
		// could otherwise 302 to internal infrastructure. Matches the
		// pattern in internal/metadata/imageproxy.go.
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return fmt.Errorf("too many redirects")
			}
			host := strings.ToLower(req.URL.Hostname())
			if !shareAllowedImageHosts[host] {
				return fmt.Errorf("redirect to disallowed host: %s", host)
			}
			return nil
		},
	}
	resp, err := client.Get(url)
	if err != nil {
		return nil, fmt.Errorf("fetch poster: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("poster fetch returned status %d", resp.StatusCode)
	}

	// Read up to 5MB. TMDB w780 posters are typically 100-300KB; cap
	// guards against pathological responses.
	limited := io.LimitReader(resp.Body, 5*1024*1024)
	contentType := resp.Header.Get("Content-Type")
	switch {
	case strings.Contains(contentType, "jpeg"), strings.Contains(contentType, "jpg"):
		return jpeg.Decode(limited)
	case strings.Contains(contentType, "png"):
		return png.Decode(limited)
	default:
		// Fall back to JPEG decoder — TMDB CDN almost always serves
		// JPEG even when Content-Type is missing.
		return jpeg.Decode(limited)
	}
}

// drawScaledPoster fits the poster into the top-section bounding box,
// preserving 2:3 aspect ratio, and centers it horizontally.
func (h *PartyShareHandler) drawScaledPoster(dst *image.RGBA, src image.Image) {
	srcBounds := src.Bounds()
	srcW := srcBounds.Dx()
	srcH := srcBounds.Dy()

	// Compute the target rectangle. Poster aspect is preserved by
	// fitting within (shareImgWidth, posterMaxHeight) and centering.
	targetH := posterMaxHeight
	targetW := srcW * targetH / srcH
	if targetW > shareImgWidth-160 {
		// Cap to width-with-margin; recompute height.
		targetW = shareImgWidth - 160
		targetH = srcH * targetW / srcW
	}
	x0 := (shareImgWidth - targetW) / 2
	y0 := posterTopMargin
	dstRect := image.Rect(x0, y0, x0+targetW, y0+targetH)

	// Use CatmullRom for high-quality scaling. ApproxBiLinear would be
	// ~4x faster but noticeably softer; share images are generated once
	// per party (cached), so the quality trade is worth it.
	xdraw.CatmullRom.Scale(dst, dstRect, src, srcBounds, draw.Over, nil)
}

// drawCenteredText draws s horizontally centered at y, using the given
// font face and color. Truncates with ellipsis if the text would overflow
// (shareImgWidth - 80px margin on each side).
//
// Truncation iterates over RUNES, not bytes — a naive `s[:len(s)-2]`
// would slice mid-codepoint for multi-byte UTF-8 (e.g. "Frédéric")
// producing an invalid rune at the truncation boundary, which the font
// renderer paints as a missing-glyph box. The rune-aware path correctly
// drops one whole codepoint per iteration.
func (h *PartyShareHandler) drawCenteredText(dst *image.RGBA, s string, y int, face font.Face, c color.Color) {
	maxWidth := shareImgWidth - 160 // 80px margin each side

	// Measure with the chosen face. If too wide, truncate with ellipsis.
	// Convert to []rune so each iteration drops one codepoint, not one byte.
	runes := []rune(s)
	display := s
	for measureTextWidth(face, display) > maxWidth && len(runes) > 4 {
		runes = runes[:len(runes)-1]
		display = string(runes) + "…"
	}

	width := measureTextWidth(face, display)
	x := (shareImgWidth - width) / 2

	d := &font.Drawer{
		Dst:  dst,
		Src:  &image.Uniform{C: c},
		Face: face,
		Dot:  fixed.P(x, y),
	}
	d.DrawString(display)
}

// measureTextWidth returns the rendered pixel width of s with the given
// face. Uses font.Drawer.MeasureString-equivalent math.
func measureTextWidth(face font.Face, s string) int {
	d := &font.Drawer{Face: face}
	w := d.MeasureString(s)
	return w.Round()
}

// InvalidateCache removes the cached share image for a party. Called from
// the party manager when a party ends (best-effort hook). Silently ignores
// "file not found" — the file may never have been generated if no one
// requested a share.
func (h *PartyShareHandler) InvalidateCache(code string) {
	path := h.cachePath(code)
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		slog.Debug("party share cache invalidate failed", "code", code, "error", err)
	}
}
