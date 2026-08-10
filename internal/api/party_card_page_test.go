package api

import (
	"bytes"
	"context"
	"html"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/aurora-media/aurora/internal/config"
	"github.com/aurora-media/aurora/internal/models"
	"github.com/aurora-media/aurora/internal/watchparty"
	"github.com/go-chi/chi/v5"
)

// ============================================================
// Watch-party link unfurl — /p/{CODE}
// ============================================================
//
// The shell is Aurora's first crawlable surface, is unauthenticated, and
// renders two attacker-influenced strings (media title, host display
// name) into HTML attributes. These tests hold three lines:
//
//   - the unfurl actually works: the tags are there, well-formed, and the
//     og:image URL really returns a 1200×630 PNG;
//   - escaping holds: a hostile title round-trips through the attribute
//     instead of breaking out of it;
//   - the route is not an existence oracle: a code that names a party and
//     one that doesn't produce the same status, headers and tag set.

// ── helpers ─────────────────────────────────────────────────────────

// pageRequest builds a /p/{code} request with chi's route param bound,
// exactly as the router would. rawCode is forwarded verbatim (case and
// all) because the shell's SPA bounce must preserve it.
func pageRequest(method, rawCode, host string) *http.Request {
	r := httptest.NewRequest(method, "/p/"+url.PathEscape(rawCode), nil)
	r.Host = host
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("code", rawCode)
	return r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, rctx))
}

var metaTagRe = regexp.MustCompile(`(?s)<meta\s+([^>]*?)/?>`)
var attrRe = regexp.MustCompile(`([a-zA-Z][\w:.-]*)="([^"]*)"`)
var contentAttrRe = regexp.MustCompile(`content="[^"]*"`)

// parseMeta pulls every <meta> tag out of the shell and keys it by
// property=/name=. The `content="([^"]*)"` shape is only sound because
// html/template guarantees no raw quote survives inside an attribute —
// which is precisely what the escaping test relies on: if a hostile title
// broke out, the captured value would not round-trip.
func parseMeta(t *testing.T, body string) (map[string]string, []string) {
	t.Helper()
	out := map[string]string{}
	var order []string
	for _, m := range metaTagRe.FindAllStringSubmatch(body, -1) {
		attrs := map[string]string{}
		for _, a := range attrRe.FindAllStringSubmatch(m[1], -1) {
			attrs[a[1]] = a[2]
		}
		key := attrs["property"]
		if key == "" {
			key = attrs["name"]
		}
		if key == "" {
			continue // charset / viewport
		}
		out[key] = html.UnescapeString(attrs["content"])
		order = append(order, key)
	}
	return out, order
}

func pageTitle(t *testing.T, body string) string {
	t.Helper()
	i := strings.Index(body, "<title>")
	j := strings.Index(body, "</title>")
	if i < 0 || j < i {
		t.Fatalf("no <title> in shell")
	}
	return html.UnescapeString(body[i+len("<title>") : j])
}

// scheduledCardParty is the fixture the unfurl tests share: one party,
// scheduled, with a host the fake queries can resolve.
func unfurlHandler(t *testing.T, states map[string]*watchparty.PartyState) *PartyShareHandler {
	t.Helper()
	return newCardTestHandler(t, &fakeCardManager{states: states}, &fakeCardQueries{
		profile: &models.MemberProfile{UserID: 7, Username: "ronnie", DisplayName: "Ronnie"},
		item:    &models.MediaItem{ID: 42, Year: 2022, RuntimeMin: 147},
		genres:  []string{"Action", "Adventure"},
	})
}

func servePage(t *testing.T, h *PartyShareHandler, rawCode, host string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServePartyPage(rec, pageRequest(http.MethodGet, rawCode, host))
	return rec
}

// firstDiff reports the first byte where two documents diverge, with
// context — a "they differ" failure with no location is unactionable.
func firstDiff(a, b string) string {
	n := len(a)
	if len(b) < n {
		n = len(b)
	}
	for i := 0; i < n; i++ {
		if a[i] != b[i] {
			lo := i - 60
			if lo < 0 {
				lo = 0
			}
			return "at byte " + strconv.Itoa(i) + ":\n  a: …" + a[lo:min(i+60, len(a))] +
				"\n  b: …" + b[lo:min(i+60, len(b))]
		}
	}
	return "lengths differ: " + strconv.Itoa(len(a)) + " vs " + strconv.Itoa(len(b))
}

// ── The unfurl itself ───────────────────────────────────────────────

// Every tag a chat client reads, carrying the card's own contents and
// nothing else.
func TestServePartyPage_EmitsUnfurlMetaTags(t *testing.T) {
	if cardTimeZone == time.UTC {
		t.Skip("no IANA tzdata available in this environment")
	}
	sched := time.Date(2026, 8, 16, 0, 0, 0, 0, time.UTC) // 8:00 PM EDT, Aug 15
	h := unfurlHandler(t, map[string]*watchparty.PartyState{
		"7K2QD9": cardTestParty("7K2QD9", 7, &sched),
	})

	rec := servePage(t, h, "7K2QD9", "aurora.example.com")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "text/html; charset=utf-8" {
		t.Errorf("Content-Type = %q", ct)
	}
	body := rec.Body.String()
	meta, _ := parseMeta(t, body)

	const wantTitle = "Jurassic World Dominion — Aurora watch party"
	wantDesc := "Ronnie is hosting on Saturday, August 15 at 8:00 PM EDT. " + cardTagline
	wantImage := "http://aurora.example.com/p/7K2QD9/card.png?v=og&t=" + h.cardToken("7K2QD9")

	for k, want := range map[string]string{
		"og:site_name":        "Aurora",
		"og:type":             "website",
		"og:title":            wantTitle,
		"og:url":              "http://aurora.example.com/p/7K2QD9",
		"og:image":            wantImage,
		"og:image:width":      "1200",
		"og:image:height":     "630",
		"og:image:type":       "image/png",
		"og:description":      wantDesc,
		"twitter:card":        "summary_large_image",
		"twitter:title":       wantTitle,
		"twitter:description": wantDesc,
		"twitter:image":       wantImage,
	} {
		if got := meta[k]; got != want {
			t.Errorf("%s = %q, want %q", k, got, want)
		}
	}
	if got := pageTitle(t, body); got != wantTitle {
		t.Errorf("<title> = %q", got)
	}
	// The card is the source of truth for what may appear. The username
	// behind the display name is identity we don't publish.
	if strings.Contains(body, "ronnie") {
		t.Error("shell leaked the host's username; only the display name may appear")
	}
}

// The og:image has to be a URL that really answers with the OG crop —
// a tag pointing at a 404 unfurls as a bare link. Driven over real HTTP
// through the same route shape the router registers.
func TestServePartyPage_OGImageServesTheOGCropOverHTTP(t *testing.T) {
	sched := time.Date(2026, 8, 16, 0, 0, 0, 0, time.UTC)
	h := unfurlHandler(t, map[string]*watchparty.PartyState{
		"7K2QD9": cardTestParty("7K2QD9", 7, &sched),
	})

	mux := chi.NewRouter()
	mux.Get("/p/{code}", h.ServePartyPage)
	mux.Head("/p/{code}", h.ServePartyPage)
	mux.Get("/p/{code}/card.png", h.ServeCardPNG)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/p/7K2QD9")
	if err != nil {
		t.Fatalf("GET page: %v", err)
	}
	pageBody, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("page status = %d", resp.StatusCode)
	}
	meta, _ := parseMeta(t, string(pageBody))

	imgURL := meta["og:image"]
	if !strings.HasPrefix(imgURL, srv.URL+"/p/7K2QD9/card.png?") {
		t.Fatalf("og:image = %q, want the card under this origin's /p/ prefix", imgURL)
	}
	imgResp, err := http.Get(imgURL)
	if err != nil {
		t.Fatalf("GET og:image: %v", err)
	}
	defer imgResp.Body.Close()
	if imgResp.StatusCode != http.StatusOK {
		t.Fatalf("og:image status = %d, want 200", imgResp.StatusCode)
	}
	if ct := imgResp.Header.Get("Content-Type"); ct != "image/png" {
		t.Errorf("og:image Content-Type = %q, want image/png", ct)
	}
	raw, err := io.ReadAll(imgResp.Body)
	if err != nil {
		t.Fatalf("read image: %v", err)
	}
	img, err := png.Decode(bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("og:image is not a PNG: %v", err)
	}
	if b := img.Bounds(); b.Dx() != ogLayout.Width || b.Dy() != ogLayout.Height {
		t.Errorf("og:image is %dx%d, want %dx%d", b.Dx(), b.Dy(), ogLayout.Width, ogLayout.Height)
	}
	// The same token, and only that token, opens it — the alias inherits
	// the card route's gate, including 404-never-403.
	badResp, err := http.Get(srv.URL + "/p/7K2QD9/card.png?v=og&t=0000000000000000")
	if err != nil {
		t.Fatalf("GET with bad tag: %v", err)
	}
	defer badResp.Body.Close()
	if badResp.StatusCode != http.StatusNotFound {
		t.Errorf("bad tag on the alias = %d, want 404 (never 403)", badResp.StatusCode)
	}
}

// A live party has no date to print; the slot says so instead of
// inventing today's.
func TestServePartyPage_LiveNowWhenUnscheduled(t *testing.T) {
	h := unfurlHandler(t, map[string]*watchparty.PartyState{
		"7K2QD9": cardTestParty("7K2QD9", 7, nil),
	})
	meta, _ := parseMeta(t, servePage(t, h, "7K2QD9", "aurora.example.com").Body.String())
	if got := meta["og:description"]; got != "Ronnie is hosting — live now. "+cardTagline {
		t.Errorf("og:description = %q", got)
	}
}

// ── Escaping ────────────────────────────────────────────────────────

// Media titles come from TMDB and display names from members. Both land
// inside HTML attributes. html/template escapes per context; this proves
// the hostile string round-trips through the attribute instead of
// closing it.
func TestServePartyPage_HostileTitleAndHostAreEscaped(t *testing.T) {
	const evilTitle = `Evil" /><script>alert(1)</script><meta x="`
	const evilHost = `</title><img src=x onerror=alert(1)>`

	sched := time.Date(2026, 8, 16, 0, 0, 0, 0, time.UTC)
	ps := cardTestParty("7K2QD9", 7, &sched)
	ps.MediaTitle = evilTitle
	h := newCardTestHandler(t, &fakeCardManager{states: map[string]*watchparty.PartyState{"7K2QD9": ps}},
		&fakeCardQueries{profile: &models.MemberProfile{UserID: 7, Username: "x", DisplayName: evilHost}})

	body := servePage(t, h, "7K2QD9", "aurora.example.com").Body.String()

	// No tag the input tried to open exists, and neither hostile string
	// appears with its markup intact.
	for _, forbidden := range []string{"<script>alert", "<img", "<meta x=", evilTitle, evilHost} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("hostile input reached the document raw: %q", forbidden)
		}
	}
	// The one <script> in the page is our own bounce, the one </title> is
	// our own close, and the title attribute was never broken out of.
	if n := strings.Count(body, "<script"); n != 1 {
		t.Fatalf("document has %d <script> tags, want exactly 1 (the bounce)", n)
	}
	if n := strings.Count(body, "</title>"); n != 1 {
		t.Fatalf("document has %d </title> closes, want exactly 1", n)
	}
	if strings.Count(body, `<meta property="og:title" content="`) != 1 {
		t.Fatal("og:title tag did not survive intact")
	}
	// …and it round-trips: the attribute still CARRIES the title, escaped.
	meta, _ := parseMeta(t, body)
	if got := meta["og:title"]; got != evilTitle+" — "+partyPageGenericTitle {
		t.Errorf("og:title = %q, want the hostile title escaped-but-intact", got)
	}
	if got := meta["og:description"]; !strings.HasPrefix(got, evilHost+" is hosting ") {
		t.Errorf("og:description = %q, want the hostile display name escaped-but-intact", got)
	}
	if got := pageTitle(t, body); got != evilTitle+" — "+partyPageGenericTitle {
		t.Errorf("<title> = %q", got)
	}
	if !strings.Contains(body, "&lt;script&gt;") {
		t.Error("expected the title's angle brackets to appear escaped")
	}
}

// The path segment is reflected into the bounce (script + link). chi
// hands it over unvalidated, so it gets the same treatment.
func TestServePartyPage_HostileCodeSegmentIsEscaped(t *testing.T) {
	h := unfurlHandler(t, nil)
	body := servePage(t, h, `"><script>alert(1)</script>`, "aurora.example.com").Body.String()
	for _, forbidden := range []string{"<script>alert", `"><script`} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("hostile path segment reached the document raw: %q", forbidden)
		}
	}
	if n := strings.Count(body, "<script"); n != 1 {
		t.Fatalf("document has %d <script> tags, want exactly 1", n)
	}
}

// ── Not an existence oracle ─────────────────────────────────────────

// A code that names a party and one that doesn't must agree on status,
// headers, tag set and every structural byte. What differs is only what
// the party publishes about itself on its own card — which is the
// feature. Enumeration learns nothing from the SHAPE of the response.
func TestServePartyPage_UnknownCodeMatchesKnownCodeShape(t *testing.T) {
	sched := time.Date(2026, 8, 16, 0, 0, 0, 0, time.UTC)
	h := unfurlHandler(t, map[string]*watchparty.PartyState{
		"7K2QD9": cardTestParty("7K2QD9", 7, &sched),
	})

	known := servePage(t, h, "7K2QD9", "aurora.example.com")
	unknown := servePage(t, h, "QX48TM", "aurora.example.com")

	if known.Code != http.StatusOK || unknown.Code != http.StatusOK {
		t.Fatalf("statuses = %d/%d, want 200/200 — a 404 for the unknown code would confirm which codes exist",
			known.Code, unknown.Code)
	}
	for _, hdr := range []string{"Content-Type", "Cache-Control", "Content-Security-Policy",
		"X-Content-Type-Options", "Referrer-Policy"} {
		if a, b := known.Header().Get(hdr), unknown.Header().Get(hdr); a != b {
			t.Errorf("%s differs: %q vs %q", hdr, a, b)
		}
	}
	if unknown.Header().Get("Location") != "" {
		t.Error("unknown code redirected — a redirect is a distinguishable response")
	}

	kMeta, kOrder := parseMeta(t, known.Body.String())
	uMeta, uOrder := parseMeta(t, unknown.Body.String())
	if strings.Join(kOrder, ",") != strings.Join(uOrder, ",") {
		t.Errorf("tag sets differ:\n known=%v\n unknown=%v", kOrder, uOrder)
	}
	// Same image shape, same declared dimensions, and a real tag on both:
	// the unknown code must not fall back to a different kind of URL.
	if uMeta["og:image"] != cardPageImageURL("http://aurora.example.com", "QX48TM", h.cardToken("QX48TM")) {
		t.Errorf("unknown-code og:image = %q, want the same card URL shape a real party gets", uMeta["og:image"])
	}
	for _, k := range []string{"og:image:width", "og:image:height", "og:type", "twitter:card", "og:site_name"} {
		if kMeta[k] != uMeta[k] {
			t.Errorf("%s differs between known and unknown: %q vs %q", k, kMeta[k], uMeta[k])
		}
	}
	// The structural body — everything that isn't the party's own copy —
	// is byte-identical.
	strip := func(rec *httptest.ResponseRecorder, code string) string {
		// Blank every content="…" and the <title> text — that is exactly
		// the copy a party publishes about itself. Everything left is
		// structure, and structure must not vary.
		s := contentAttrRe.ReplaceAllString(rec.Body.String(), `content=""`)
		i, j := strings.Index(s, "<title>"), strings.Index(s, "</title>")
		s = s[:i+len("<title>")] + s[j:]
		return strings.ReplaceAll(s, code, "")
	}
	if a, b := strip(known, "7K2QD9"), strip(unknown, "QX48TM"); a != b {
		t.Errorf("the non-metadata body differs between a known and an unknown code:\n%s",
			firstDiff(a, b))
	}
	// And the intended difference is present: a real party says what it is.
	if kMeta["og:title"] == uMeta["og:title"] {
		t.Error("known party did not publish its own title (fixture broken)")
	}
	if uMeta["og:title"] != partyPageGenericTitle {
		t.Errorf("unknown code title = %q, want the generic page", uMeta["og:title"])
	}
}

// A malformed code renders the generic page too — 200, never a 404 — and
// never reflects the junk into a URL that claims to be a party.
func TestServePartyPage_MalformedCodeRendersGenericPage(t *testing.T) {
	h := unfurlHandler(t, map[string]*watchparty.PartyState{})
	for _, code := range []string{"abc", "TOOLONG1", "AB CD1", "7K2QD9X", "%2e%2e", "ünïcode", ""} {
		t.Run(code, func(t *testing.T) {
			rec := servePage(t, h, code, "aurora.example.com")
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200", rec.Code)
			}
			meta, _ := parseMeta(t, rec.Body.String())
			if meta["og:title"] != partyPageGenericTitle {
				t.Errorf("og:title = %q, want the generic page", meta["og:title"])
			}
			if meta["og:url"] != "http://aurora.example.com/" {
				t.Errorf("og:url = %q, want the site root", meta["og:url"])
			}
			if strings.Contains(meta["og:image"], "card.png") {
				t.Errorf("og:image = %q, want the brand image for a code that cannot name a party", meta["og:image"])
			}
			if strings.Contains(meta["og:image"], code) && code != "" {
				t.Errorf("malformed code reflected into og:image: %q", meta["og:image"])
			}
		})
	}
}

// A code that is well-formed but names nothing still gets a real token —
// the presence or absence of `t=` must not be the tell.
func TestServePartyPage_UnknownCodeStillCarriesAValidTag(t *testing.T) {
	h := unfurlHandler(t, map[string]*watchparty.PartyState{})
	meta, _ := parseMeta(t, servePage(t, h, "QX48TM", "aurora.example.com").Body.String())
	tag := meta["og:image"][strings.LastIndex(meta["og:image"], "t=")+2:]
	if !h.validCardToken("QX48TM", tag) {
		t.Errorf("unknown code minted tag %q, which does not validate", tag)
	}
}

// ── Only the host appears ───────────────────────────────────────────

// A party is other people's plans too. The roster is private at the API;
// it must not leak through the unfurl either.
func TestServePartyPage_CarriesNoRosterOrInviteeNames(t *testing.T) {
	sched := time.Date(2026, 8, 16, 0, 0, 0, 0, time.UTC)
	ps := cardTestParty("7K2QD9", 7, &sched)
	ps.Participants = map[int64]*watchparty.Participant{
		11: {UserID: 11, Username: "marguerite"},
		12: {UserID: 12, Username: "devendra"},
	}
	h := newCardTestHandler(t, &fakeCardManager{states: map[string]*watchparty.PartyState{"7K2QD9": ps}},
		&fakeCardQueries{profile: &models.MemberProfile{UserID: 7, Username: "ronnie", DisplayName: "Ronnie"}})

	body := servePage(t, h, "7K2QD9", "aurora.example.com").Body.String()
	for _, name := range []string{"marguerite", "devendra"} {
		if strings.Contains(strings.ToLower(body), name) {
			t.Errorf("shell leaked participant %q", name)
		}
	}
	// No participant count either — "3 people are in" is party state the
	// card never shows.
	if strings.Contains(body, "people") || strings.Contains(body, "watching") {
		t.Error("shell carries party state beyond the card's own contents")
	}
}

// ── Host header ─────────────────────────────────────────────────────

// absoluteBase carries the authority allowlist. A forged Host must never
// reach og:image or og:url — and must answer the same way whether or not
// the code names a party.
func TestServePartyPage_ForgedHostIsRejectedIdentically(t *testing.T) {
	sched := time.Date(2026, 8, 16, 0, 0, 0, 0, time.UTC)
	h := unfurlHandler(t, map[string]*watchparty.PartyState{
		"7K2QD9": cardTestParty("7K2QD9", 7, &sched),
	})
	var bodies []string
	for _, code := range []string{"7K2QD9", "QX48TM", "nope"} {
		rec := servePage(t, h, code, "evil.example.com/x?")
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%s: status = %d, want 400", code, rec.Code)
		}
		if strings.Contains(rec.Body.String(), "evil.example.com") {
			t.Errorf("%s: rejected host echoed into the body", code)
		}
		bodies = append(bodies, rec.Body.String())
	}
	for i := 1; i < len(bodies); i++ {
		if bodies[i] != bodies[0] {
			t.Error("host rejection distinguishes real codes from made-up ones")
		}
	}
}

// ── The human path ──────────────────────────────────────────────────

// /p/{CODE} used to 302 into the SPA. It now serves the shell to
// everyone and bounces browsers from inside it. The bounce must be JS —
// a <meta http-equiv="refresh"> is followed by several crawlers, which
// would land them on the SPA's tag-less index.html — and it must preserve
// the segment exactly as received, because the SPA's magic-link matcher
// reads it off the path.
func TestServePartyPage_BouncesIntoTheSPAWithoutMetaRefresh(t *testing.T) {
	h := unfurlHandler(t, map[string]*watchparty.PartyState{})
	for _, raw := range []string{"7K2QD9", "7k2qd9"} {
		body := servePage(t, h, raw, "aurora.example.com").Body.String()
		if strings.Contains(strings.ToLower(body), "http-equiv") {
			t.Error("shell carries a meta refresh; crawlers follow those to the SPA")
		}
		if !strings.Contains(body, "window.location.replace") {
			t.Error("shell does not bounce a browser into the SPA")
		}
		// Exact SPA path, case preserved, in both the script and the
		// no-JS link.
		if !strings.Contains(body, `\/v2\/p\/`+raw) && !strings.Contains(body, "/v2/p/"+raw) {
			t.Errorf("bounce target missing for %q", raw)
		}
		if !strings.Contains(body, `href="/v2/p/`+raw+`"`) {
			t.Errorf("no-JS link missing for %q", raw)
		}
		// location.replace, not assign: the shell must not become a
		// history entry the Back button lands on.
		if strings.Contains(body, "location.assign") || strings.Contains(body, "location.href=") {
			t.Error("bounce writes a history entry")
		}
	}
}

// Crawlers preflight with HEAD. It answers with the headers a GET would,
// including the exact length, and no body.
func TestServePartyPage_HEADIsHeadersOnly(t *testing.T) {
	h := unfurlHandler(t, map[string]*watchparty.PartyState{})
	rec := httptest.NewRecorder()
	h.ServePartyPage(rec, pageRequest(http.MethodHead, "7K2QD9", "aurora.example.com"))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if rec.Body.Len() != 0 {
		t.Errorf("HEAD wrote %d body bytes", rec.Body.Len())
	}
	if cl := rec.Header().Get("Content-Length"); cl == "" || cl == "0" {
		t.Errorf("Content-Length = %q, want the length a GET would send", cl)
	}
}

// The shell loads nothing, so its CSP says so — and it must not inherit
// a policy that would block its own bounce script.
func TestServePartyPage_TightCSP(t *testing.T) {
	h := unfurlHandler(t, map[string]*watchparty.PartyState{})
	rec := servePage(t, h, "7K2QD9", "aurora.example.com")
	csp := rec.Header().Get("Content-Security-Policy")
	for _, want := range []string{"default-src 'none'", "script-src 'unsafe-inline'", "frame-ancestors 'none'"} {
		if !strings.Contains(csp, want) {
			t.Errorf("CSP %q missing %q", csp, want)
		}
	}
}

// ── Copy helpers ────────────────────────────────────────────────────

// The abbreviation is whatever the zone actually resolves to. Never a
// hardcoded EST.
func TestPartyPageDescription_TrueAbbreviationAcrossDST(t *testing.T) {
	if cardTimeZone == time.UTC {
		t.Skip("no IANA tzdata available in this environment")
	}
	summer := time.Date(2026, 8, 16, 0, 0, 0, 0, time.UTC)  // Aug 15, 8:00 PM EDT
	winter := time.Date(2026, 1, 10, 1, 30, 0, 0, time.UTC) // Jan 9, 8:30 PM EST

	if got := partyPageDescription("Ronnie", &summer); got != "Ronnie is hosting on Saturday, August 15 at 8:00 PM EDT. "+cardTagline {
		t.Errorf("summer = %q", got)
	}
	if got := partyPageDescription("Ronnie", &winter); got != "Ronnie is hosting on Friday, January 9 at 8:30 PM EST. "+cardTagline {
		t.Errorf("winter = %q", got)
	}
	// No host resolved: the sentence stands on its own rather than
	// starting with a blank subject.
	if got := partyPageDescription("", &summer); got != "Starts Saturday, August 15 at 8:00 PM EDT. "+cardTagline {
		t.Errorf("hostless = %q", got)
	}
	if got := partyPageDescription("", nil); got != "Live now. "+cardTagline {
		t.Errorf("hostless live = %q", got)
	}
}

func TestMetaSafeText(t *testing.T) {
	cases := []struct{ name, in, want string }{
		{"plain", "Jurassic World Dominion", "Jurassic World Dominion"},
		{"collapses whitespace", "  The\n\tGrand   Budapest\r\nHotel ", "The Grand Budapest Hotel"},
		{"strips controls", "Du\x00ne\x07", "Dune"},
		{"strips bidi override", "Dune\u202Egnp.exe", "Dunegnp.exe"},
		{"strips isolates", "\u2066Dune\u2069", "Dune"},
		{"strips BOM", "\uFEFFDune", "Dune"},
		{"keeps emoji ZWJ", "Family \U0001F468\u200D\U0001F469\u200D\U0001F467", "Family \U0001F468\u200D\U0001F469\u200D\U0001F467"},
		{"keeps accents", "Amélie", "Amélie"},
		{"empty", "   ", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := metaSafeText(tc.in, 90); got != tc.want {
				t.Errorf("metaSafeText(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
	// Rune-safe clamp: a multi-byte title must not be sliced mid-rune.
	long := strings.Repeat("é", 200)
	got := metaSafeText(long, 90)
	if n := len([]rune(got)); n != 90 {
		t.Errorf("clamped to %d runes, want 90", n)
	}
	if !strings.HasPrefix(long, got) {
		t.Error("clamp produced a string that is not a prefix of the input (rune split?)")
	}
}

func TestCardPageImageURL(t *testing.T) {
	got := cardPageImageURL("https://aurora.example.com", "7K2QD9", "abc123")
	want := "https://aurora.example.com/p/7K2QD9/card.png?v=og&t=abc123"
	if got != want {
		t.Errorf("cardPageImageURL = %q, want %q", got, want)
	}
	// The canonical /api/ URL is unchanged — the alias is additive.
	if api := cardImageURL("https://aurora.example.com", "7K2QD9", CardVariantOG, "abc123"); api !=
		"https://aurora.example.com/api/parties/7K2QD9/card.png?v=og&t=abc123" {
		t.Errorf("card-links URL drifted: %q", api)
	}
}

// A nil manager must degrade to the generic page, not panic: this is the
// one card route with no token in front of it.
func TestServePartyPage_SurvivesNilManager(t *testing.T) {
	h := &PartyShareHandler{cacheDir: t.TempDir(), jwtSecret: testJWTSecret}
	rec := servePage(t, h, "7K2QD9", "aurora.example.com")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
}

// ── robots.txt ──────────────────────────────────────────────────────

// The carve-out is one path. Everything else stays uncrawlable, and the
// Allow sits above the blanket Disallow so first-match parsers honour it.
func TestRobotsTxt_AllowsThePartyPathAndNothingElse(t *testing.T) {
	r := NewRouter(RouterDeps{Cfg: &config.Config{}, StartTime: time.Now()})
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/robots.txt", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	const want = "User-agent: *\nAllow: /p/\nDisallow: /\n"
	if got := rec.Body.String(); got != want {
		t.Errorf("robots.txt =\n%q\nwant\n%q", got, want)
	}
}

// ── Wiring, through the real router ─────────────────────────────────

// The shell replaced a 302 that had lived in the static block, and the
// og:image lives on an alias route. Both facts are only true if
// NewRouter registers them, so this drives the real router: /p/{code}
// must serve HTML (not redirect, not 404), /p/{code}/card.png must reach
// the card handler, and /r/{code} must still bounce as it always did.
func TestRouter_UnfurlRoutesAreWired(t *testing.T) {
	r := NewRouter(RouterDeps{
		Cfg:       &config.Config{},
		StaticDir: t.TempDir(),
		StartTime: time.Now(),
	})

	// /p/{code} — the shell, served to everyone.
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/p/7K2QD9", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("/p/{code} status = %d, want 200 (never a redirect, never a 404)", rec.Code)
	}
	if loc := rec.Header().Get("Location"); loc != "" {
		t.Errorf("/p/{code} redirected to %q; the bounce belongs inside the page", loc)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "text/html; charset=utf-8" {
		t.Errorf("/p/{code} Content-Type = %q", ct)
	}
	// The handler's own cache policy must win over the frontend
	// middleware's no-cache: crawlers retry, and this page is cheap to
	// hand back from cache.
	if cc := rec.Header().Get("Cache-Control"); cc != "public, max-age=300" {
		t.Errorf("Cache-Control = %q, want the shell's own policy", cc)
	}
	meta, _ := parseMeta(t, rec.Body.String())
	for _, k := range []string{"og:title", "og:description", "og:image", "og:url", "og:type", "twitter:card", "twitter:image"} {
		if meta[k] == "" {
			t.Errorf("%s missing from the routed response", k)
		}
	}

	// /p/{code}/card.png — the alias reaches ServeCardPNG. With no party
	// manager wired it 404s, but with the card handler's JSON body, not
	// chi's "404 page not found" — that is how we know it routed.
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/p/7K2QD9/card.png?v=og&t=whatever", nil))
	if rec.Code != http.StatusNotFound {
		t.Errorf("alias status = %d, want 404 for an unopenable card", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `"error"`) {
		t.Errorf("alias body = %q, want the card handler's error shape (it did not route)", rec.Body.String())
	}

	// HEAD is registered on both.
	for _, path := range []string{"/p/7K2QD9", "/p/7K2QD9/card.png"} {
		rec = httptest.NewRecorder()
		r.ServeHTTP(rec, httptest.NewRequest(http.MethodHead, path, nil))
		if rec.Code == http.StatusMethodNotAllowed {
			t.Errorf("HEAD %s = 405; crawlers preflight", path)
		}
	}

	// The sibling magic link is untouched.
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/r/7K2QD9", nil))
	if rec.Code != http.StatusFound || rec.Header().Get("Location") != "/v2/r/7K2QD9" {
		t.Errorf("/r/{code} = %d %q, want the original 302", rec.Code, rec.Header().Get("Location"))
	}
}
