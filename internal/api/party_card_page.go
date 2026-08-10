package api

import (
	"bytes"
	"fmt"
	"html/template"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/aurora-media/aurora/internal/watchparty"
	"github.com/go-chi/chi/v5"
)

// ============================================================
// Watch-party link unfurl — the shell served at /p/{CODE}
// ============================================================
//
// Phase 3 of the share card. A party link pasted into Discord, Slack, X,
// iMessage or WhatsApp should come back as artwork, which means /p/{CODE}
// has to answer a crawler with Open Graph tags instead of the SPA
// bootstrap (an empty <div id="root">, which unfurls as nothing).
//
// This is Aurora's FIRST crawlable surface — robots.txt disallows
// everything else and keeps doing so; the carve-out is `Allow: /p/`, that
// one prefix.
//
// ── Crawler vs. browser: one response for everybody ─────────────────
//
// The obvious implementation sniffs User-Agent and serves the shell only
// to known crawlers. This does NOT do that, for three reasons:
//
//  1. iMessage is the counter-example that settles it. Apple's link
//     preview fetches with a Safari-shaped User-Agent; there is no
//     reliable string that separates it from a person on a Mac. A sniff
//     that is safe for humans silently never unfurls in Messages — one
//     of the five clients this phase exists to serve.
//  2. UA lists rot. Every new chat client, every crawler rename, is a
//     silent regression nobody notices until someone pastes a link and
//     gets a bare URL back.
//  3. A sniff is spoofable, so it can't be a security boundary anyway —
//     which means the shell has to be safe to hand anyone regardless.
//     Once that's true, branching on UA buys only the redirect, and the
//     redirect is not worth a feature that fails silently.
//
// So every requester gets the same 200 with the same HTML, and the page
// bounces a browser into the SPA with `location.replace`. That is not a
// downgrade of the human path: /p/{CODE} was already a 302 to /v2/p/{CODE},
// so a person was always paying one extra round trip. They still pay
// exactly one — the shell is ~2 KB, paints Aurora's own background so
// there is no white flash, and `location.replace` leaves no history entry
// (Back goes where the user came from, not into a bounce loop). Anyone
// who can use Aurora at all runs JS: the whole UI is a React SPA. A
// browser with JS disabled — which could never have used the SPA it was
// being redirected into — gets a visible "Continue to Aurora" link.
//
// Deliberately NOT a <meta http-equiv="refresh">: several crawlers honour
// meta refresh and would follow it to the SPA's index.html, which carries
// no Open Graph tags. The unfurl would then fail for exactly the clients
// this phase is for. JS is the one bounce mechanism crawlers don't take.
// Known limit: a crawler that renders JS (headless-Chrome-based preview
// services) follows the bounce and sees the SPA instead. None of the five
// target clients does that; they parse the HTML they are handed.
//
// ── What the shell may say ──────────────────────────────────────────
//
// Exactly what the card itself already shows: media title, the Eastern
// start moment, the host's display name, and the OG image URL. No
// roster, no invitee names, no participant count, no playback state — a
// party is other people's plans too, and the roster is private at the API
// (party_invite_handlers.go filters `declined` rows server-side, not in
// the UI). Only the HOST appears, through the same member boundary the
// card uses.
//
// ── Unknown codes ───────────────────────────────────────────────────
//
// An unknown or malformed code renders the generic Aurora page with a
// 200, never a 404 and never a redirect: a status or shape that changed
// with the code would turn this route into an existence oracle for other
// people's parties. The tag SET, the status, the headers and the whole
// non-party body are byte-identical for every syntactically valid code —
// only the values a real party publishes on its own card differ, which is
// the disclosure the feature IS. See ServePartyPage for the full note.
//
// ── The token ───────────────────────────────────────────────────────
//
// The shell is unauthenticated (a crawler cannot log in), so it mints the
// card tag server-side with h.cardToken. It must never call CardLinks:
// that route is host-only and 403s, and 403-vs-200 on a public route is
// itself an existence oracle.
//
// Consequence worth naming: before Phase 3 a card URL could only be
// minted by an authenticated host; from here on, whoever holds the CODE
// can reach the card. That is inherent to unfurling — a crawler needs a
// fetchable image — and it is the same trade the plan locked. What still
// holds: the code space is 31^6 ≈ 887M, both routes are rate limited per
// IP (30/min), and a code on its own still gets nobody into the party.

const (
	// partyPageBrand is the site name and the tail of every title.
	partyPageBrand = "Aurora"
	// partyPageGenericTitle is what an unknown or malformed code shows,
	// and the suffix a real party's title carries.
	partyPageGenericTitle = "Aurora watch party"
	// partyPageGenericDesc is the generic page's description. It says
	// what Aurora watch parties are and nothing about any party.
	partyPageGenericDesc = "Watch together on Aurora. " + cardTagline

	// Clamps for the two attacker-influenced strings. Crawlers truncate
	// long values anyway (X around 70/200, Discord 256), and an unbounded
	// title would be an unbounded response body on a public route.
	partyPageMaxTitleRunes = 90
	partyPageMaxHostRunes  = 40

	// partyPageCSP is tighter than the frontend default because this page
	// loads nothing: no images, no fonts, no XHR. It needs only its own
	// inline <style> and the one-line bounce script. (og:image is metadata
	// for a crawler — the browser never fetches it, so img-src stays off.)
	partyPageCSP = "default-src 'none'; " +
		"style-src 'unsafe-inline'; " +
		"script-src 'unsafe-inline'; " +
		"base-uri 'none'; " +
		"form-action 'none'; " +
		"frame-ancestors 'none'"

	// v2PartyPath is where a browser actually ends up — the SPA's own
	// deep link, whose magic-link effect matches /(p|r)/([A-Za-z0-9]{6})
	// against the path. The raw path segment is forwarded unchanged (the
	// SPA upper-cases it itself) so the human path behaves exactly as the
	// 302 it replaces.
	v2PartyPath = "/v2/p/"
)

// cardPageImageURL is the og:image: the same Phase 2 `og` crop
// ServeCardPNG renders, addressed under /p/ instead of under /api/.
//
// Why the second address for one image: robots.txt's carve-out is a
// single line — `Allow: /p/` above the blanket `Disallow: /` — and
// crawlers that honour robots (X's card crawler documents this, and
// Slack's and Discord's fetchers read the file too) will not fetch an
// image the file disallows. Serving the crop from under the page's own
// prefix keeps the carve-out at exactly one path and still lets the
// unfurl load its artwork. /api/parties/{code}/card.png stays the
// canonical URL card-links mints for the SPA to copy and download; this
// is a pure alias onto the same handler, same HMAC gate, same rate limit,
// same all-rejections-are-404 behaviour.
func cardPageImageURL(base, code, token string) string {
	return fmt.Sprintf("%s/p/%s/card.png?v=%s&t=%s", base, code, CardVariantOG, token)
}

// partyPageData is everything the shell renders. Every field is a plain
// string placed by html/template in its own context — attribute for the
// meta tags, URL for the link, JS string for the bounce.
type partyPageData struct {
	Title       string
	Description string
	PageURL     string
	ImageURL    string
	ImageW      int
	ImageH      int
	ImageAlt    string
	// TwitterCard is "summary_large_image" when there is a card to show
	// and "summary" when there is not. A summary_large_image with no
	// fetchable image renders as a blank-topped card, so the generic page
	// downgrades rather than promising art it cannot supply.
	TwitterCard string
	SPAPath     string
}

// partyPageHTML is the shell.
//
// html/template — never text/template, never fmt.Sprintf — because
// MediaTitle and the host's display name are user/TMDB-controlled and
// land inside HTML attributes. html/template escapes per context: a title
// carrying `"` or `<script>` closes nothing.
const partyPageHTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{.Title}}</title>
<meta name="description" content="{{.Description}}">
<link rel="canonical" href="{{.PageURL}}">
<meta name="robots" content="noindex, nofollow">
<meta property="og:site_name" content="` + partyPageBrand + `">
<meta property="og:type" content="website">
<meta property="og:title" content="{{.Title}}">
<meta property="og:description" content="{{.Description}}">
<meta property="og:url" content="{{.PageURL}}">
{{if .ImageURL}}<meta property="og:image" content="{{.ImageURL}}">
<meta property="og:image:type" content="image/png">
<meta property="og:image:width" content="{{.ImageW}}">
<meta property="og:image:height" content="{{.ImageH}}">
<meta property="og:image:alt" content="{{.ImageAlt}}">
{{end}}<meta name="twitter:card" content="{{.TwitterCard}}">
<meta name="twitter:title" content="{{.Title}}">
<meta name="twitter:description" content="{{.Description}}">
{{if .ImageURL}}<meta name="twitter:image" content="{{.ImageURL}}">
<meta name="twitter:image:alt" content="{{.ImageAlt}}">
{{end}}
<meta name="theme-color" content="#050505">
<style>
:root{color-scheme:dark}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#050505;color:#f4f0ff;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;text-align:center}
main{padding:32px}
.brand{margin:0 0 14px;font-size:12px;letter-spacing:.3em;text-transform:uppercase;color:#a855f7}
.line{margin:0 0 22px;font-size:17px;color:rgba(244,240,255,.72)}
a{color:#22d3ee}
</style>
</head>
<body>
<main>
<p class="brand">` + partyPageBrand + `</p>
<p class="line">Opening this watch party&hellip;</p>
<p><a href="{{.SPAPath}}">Continue to Aurora</a></p>
</main>
<script>window.location.replace({{.SPAPath}} + window.location.search + window.location.hash)</script>
</body>
</html>
`

// partyPageTemplate is parsed once at init. A parse failure is a
// programming error in a const string, so Must is right: it fails the
// binary at boot rather than serving half a page under load.
var partyPageTemplate = template.Must(template.New("party-page").Parse(partyPageHTML))

// ServePartyPage handles GET/HEAD /p/{code}.
//
// Public, unauthenticated, and identical in shape for every caller. The
// order of operations is load-bearing:
//
//  1. Host allowlist FIRST, before anything looks at the code, so a
//     forged Host answers the same way whatever the code was — and so no
//     attacker-controlled authority reaches og:url or og:image.
//  2. Generic page as the DEFAULT, filled in only if the code is
//     well-formed AND names a live party. Every early exit is therefore
//     the generic page, not a 404.
//
// On indistinguishability, precisely: status, headers, tag set, image
// dimensions, the token's presence and every non-party byte of the body
// are identical for a code that names a party and one that doesn't. What
// differs is the title/description a real party publishes about itself —
// which is the entire point of an unfurl, and the same data the card has
// shown since Phase 1. Enumeration is bounded by the rate limiter and by
// 887M codes, not by hiding the title from someone who already has the
// code.
func (h *PartyShareHandler) ServePartyPage(w http.ResponseWriter, r *http.Request) {
	raw := chi.URLParam(r, "code")
	code := strings.ToUpper(raw)

	base, ok := h.absoluteBase(w, r, code)
	if !ok {
		return
	}

	d := partyPageData{
		Title:       partyPageGenericTitle,
		Description: partyPageGenericDesc,
		PageURL:     base + "/",
		// No og:image. The only brand asset available is the PWA icon
		// under /v2/, which the same robots.txt still disallows — the
		// crawlers that honour the file (X's most explicitly) would skip
		// it and render an image-less large card. Omitting the image and
		// downgrading to `summary` unfurls cleanly instead. Valid codes
		// that name no party are unaffected: they keep the card URL, so
		// a page for a code that exists and one that doesn't stay the
		// same shape.
		TwitterCard: "summary",
		// Forward the segment as received. The SPA's magic-link matcher
		// is case-insensitive and upper-cases the code itself, so this
		// reproduces the old 302 byte for byte — including for junk,
		// which used to reach the SPA and show its own not-found state.
		SPAPath: v2PartyPath + raw,
	}

	// A malformed code can't name a party, so it keeps the brand image
	// and the site root as its canonical URL rather than reflecting junk
	// into an image URL that could never resolve. This is the one branch
	// whose page differs from "valid code, no party" — and it confirms
	// nothing, because the caller already knows locally whether the
	// string it sent was a legal code.
	if isValidPartyCode(code) {
		d.PageURL = base + "/p/" + code
		d.ImageURL = cardPageImageURL(base, code, h.cardToken(code))
		d.ImageW, d.ImageH = ogLayout.Width, ogLayout.Height
		d.ImageAlt = partyPageGenericTitle
		d.TwitterCard = "summary_large_image"

		if ps := h.lookupParty(code); ps != nil {
			ps.Lock()
			hostUserID := ps.HostUserID
			mediaTitle := ps.MediaTitle
			var scheduled *time.Time
			if ps.ScheduledStartAt != nil {
				t := *ps.ScheduledStartAt
				scheduled = &t
			}
			ps.Unlock()

			// hostIdentity is the same member boundary the card uses:
			// display name (falling back to username), nothing else.
			hostName, _ := h.hostIdentity(r.Context(), hostUserID)
			host := metaSafeText(hostName, partyPageMaxHostRunes)
			title := metaSafeText(mediaTitle, partyPageMaxTitleRunes)

			if title != "" {
				d.Title = title + " — " + partyPageGenericTitle
				d.ImageAlt = title + " — Aurora watch party share card"
			}
			d.Description = partyPageDescription(host, scheduled)
		}
	}

	renderPartyPage(w, r, d)
}

// lookupParty is GetPartyState with a nil guard. ServePartyPage is the
// one card-surface route with no token in front of it, so it must not
// depend on a manager being wired to answer at all.
func (h *PartyShareHandler) lookupParty(code string) *watchparty.PartyState {
	if h.manager == nil {
		return nil
	}
	return h.manager.GetPartyState(code)
}

// partyPageDescription writes the one sentence under the title.
//
// The time is Eastern with the abbreviation the zone ACTUALLY resolves to
// at that instant (formatCardWhen) — EDT in August, EST in January. A
// hardcoded "EST" would be an hour-wrong instruction in an unfurl that
// gets forwarded, which is the one thing a share surface must not be.
func partyPageDescription(hostName string, scheduled *time.Time) string {
	// Two phrasings: one that takes the host as its subject, one that
	// stands alone when no display name resolved.
	when, standalone := "— live now", "Live now."
	if scheduled != nil {
		date, clock := formatCardWhen(*scheduled)
		when = "on " + date + " at " + clock
		standalone = "Starts " + date + " at " + clock + "."
	}
	if hostName != "" {
		return hostName + " is hosting " + when + ". " + cardTagline
	}
	return standalone + " " + cardTagline
}

// metaSafeText normalizes an attacker-influenced string for a meta tag.
// html/template does the ESCAPING; this does the cleanup escaping can't:
//
//   - Bidi controls come out. U+202E and friends reorder rendered text
//     without changing a single escaped byte, so a title could unfurl as
//     something other than the title we stored. Escaping is no defense
//     against that; deletion is. Zero-width joiners stay — they are how
//     family emoji are spelled.
//   - Whitespace runs collapse to a single space, so a title with a
//     newline in it doesn't wrap oddly in a chat client. Other control
//     characters are dropped rather than spaced: a NUL is not a word
//     break, and turning it into one would edit the title.
//   - The result is clamped rune-safely.
func metaSafeText(s string, maxRunes int) string {
	var b strings.Builder
	b.Grow(len(s))
	pendingSpace := false
	for _, r := range s {
		switch {
		case r == '\uFEFF' || r == '\u200E' || r == '\u200F' ||
			(r >= '\u202A' && r <= '\u202E') || (r >= '\u2066' && r <= '\u2069'):
			// Bidi embeddings/overrides/isolates and the BOM: dropped
			// outright, spelled as escapes so the rule is readable in a
			// diff (the characters themselves are invisible).
		case unicode.IsSpace(r):
			pendingSpace = b.Len() > 0
		case unicode.IsControl(r):
			// Dropped, and deliberately not turned into a space.
		default:
			if pendingSpace {
				b.WriteByte(' ')
				pendingSpace = false
			}
			b.WriteRune(r)
		}
	}
	return truncateRunes(b.String(), maxRunes)
}

// renderPartyPage writes the shell. Rendered into a buffer first so a
// template error can still become a clean error response instead of a
// half-written 200, and so Content-Length is exact — crawlers retry, and
// a length they can trust keeps the retry cheap.
func renderPartyPage(w http.ResponseWriter, r *http.Request, d partyPageData) {
	var buf bytes.Buffer
	if err := partyPageTemplate.Execute(&buf, d); err != nil {
		slog.Error("party page: template execute", "error", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Length", strconv.Itoa(buf.Len()))
	// Five minutes: long enough that a crawler retry storm or a link
	// pasted into a busy channel is nearly free, short enough that a
	// reschedule shows up in the next unfurl.
	w.Header().Set("Cache-Control", "public, max-age=300")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Content-Security-Policy", partyPageCSP)
	w.WriteHeader(http.StatusOK)
	if r.Method == http.MethodHead {
		return
	}
	_, _ = w.Write(buf.Bytes())
}
