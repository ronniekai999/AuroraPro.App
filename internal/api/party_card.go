package api

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"image"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
)

// ============================================================
// Watch-party share card — HTTP surface
// ============================================================
//
//	GET /api/parties/{code}/card.png?v=story&t={token}   public, HMAC-gated
//	GET /api/parties/{code}/card-links                   authed, HOST-ONLY
//
// The image route has to stay unauthenticated — a crawler unfurling a
// pasted link cannot log in — but this card is a real increment over what
// the old share-image exposed: it carries a person's NAME and where
// they'll be at a specific time. Publishing that on a blind six-character
// guess is not a trade worth making silently, so:
//
//   - `t` is a stateless HMAC tag over the code, keyed on the JWT secret.
//     No migration, no new table, stable for the life of the code, and
//     mintable only by an authenticated host through card-links.
//   - A wrong or absent tag yields 404, never 403. A 403 would confirm
//     that the code names a real party, which is precisely the fact the
//     token exists to withhold. Every failure on this route is a 404 for
//     the same reason.
//   - The route is rate limited per IP (see router.go) so the tag can't
//     be brute-forced and the compositor can't be used as a CPU sink.
//
// Only the HOST appears on the card. Never an invitee — a party is other
// people's plans too, and the roster is already private at the API. The
// host's display name and a memberSafeAvatar-filtered avatar are the
// entire personal payload; no email, role, or auth fields.

const (
	// cardTokenPurpose namespaces the HMAC so a card tag can never be
	// replayed as some other signature over the same code.
	cardTokenPurpose = "partycard:v1:"
	// cardTokenLen is how much of the base64url digest we keep. 16 chars
	// of base64url is 96 bits — unguessable, and short enough to sit in a
	// URL a host pastes into a chat.
	cardTokenLen = 16

	// cardTagline is the card's one line of voice. Constant, not
	// user-supplied: the card is a public artifact and free text on it
	// would be a moderation surface.
	cardTagline = "We all press play at the same time."

	// partyCardCacheSubdir holds the fingerprinted PNGs.
	partyCardCacheSubdir = "party-card"
)

// cardTimeZone pins the card to the house timezone. Nothing else in
// Aurora calls LoadLocation, so cmd/aurora imports _ "time/tzdata" to
// carry the IANA tables in the binary rather than depending on the host
// having a zoneinfo database.
var cardTimeZone = loadCardTimeZone()

func loadCardTimeZone() *time.Location {
	loc, err := time.LoadLocation("America/New_York")
	if err != nil {
		// UTC is wrong, but it is wrong *visibly* (the abbreviation
		// prints "UTC"), which beats silently printing an Eastern-looking
		// time that is four hours off.
		slog.Error("party card: America/New_York unavailable, falling back to UTC", "error", err)
		return time.UTC
	}
	return loc
}

// formatCardWhen renders a start instant in Eastern.
//
// The abbreviation is whatever the zone ACTUALLY resolves to at that
// instant — EDT March–November, EST November–March. Hardcoding "EST" on
// an August party is an hour-wrong instruction to anyone who does the
// conversion, which is the one thing a share card must not be.
func formatCardWhen(t time.Time) (dateCaps string, clock string) {
	e := t.In(cardTimeZone)
	return e.Format("Monday, January 2"), e.Format("3:04 PM MST")
}

// cardToken derives the tag for a code. Not a secret in the "must never
// leak" sense — it rides in URLs the host hands out — but unguessable
// without the JWT secret.
func (h *PartyShareHandler) cardToken(code string) string {
	mac := hmac.New(sha256.New, []byte(h.jwtSecret))
	_, _ = mac.Write([]byte(cardTokenPurpose + code))
	full := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return full[:cardTokenLen]
}

// validCardToken compares in constant time. An unset JWT secret fails
// closed — config validation makes that unreachable in production, but a
// misconfigured build must not serve every card to the world.
func (h *PartyShareHandler) validCardToken(code, presented string) bool {
	if h.jwtSecret == "" || presented == "" {
		return false
	}
	want := h.cardToken(code)
	return hmac.Equal([]byte(presented), []byte(want))
}

// partyCardFingerprint hashes the inputs the card actually renders, so a
// reschedule (or a media swap, or a host rename) yields a different cache
// file instead of handing out a poster advertising last week's time. The
// old `<code>.png` key had exactly that bug.
func partyCardFingerprint(code, mediaTitle, mediaPoster, hostName string, scheduledStartAt *time.Time) string {
	sched := ""
	if scheduledStartAt != nil {
		sched = scheduledStartAt.UTC().Format(time.RFC3339Nano)
	}
	sum := sha256.Sum256([]byte(strings.Join([]string{
		sched, mediaTitle, mediaPoster, hostName, code,
	}, "\x00")))
	return hex.EncodeToString(sum[:4])
}

// hostCacheTag folds the serving origin into the cache key. Returns a
// short "-<hex>" suffix so the filename keeps the documented
// <code>-<variant>-<fp>.png shape (and stays inside InvalidateCache's
// `<code>-*` glob).
func hostCacheTag(base string) string {
	sum := sha256.Sum256([]byte(strings.ToLower(base)))
	return hex.EncodeToString(sum[:2])
}

// partyCardCachePath is the on-disk location for one rendered card.
func partyCardCachePath(cacheDir, code string, variant CardVariant, fingerprint string) string {
	return filepath.Join(cacheDir, partyCardCacheSubdir,
		fmt.Sprintf("%s-%s-%s.png", code, variant, fingerprint))
}

// cardLinksResponse is what the SPA's share modal consumes.
//
// Phase 1 mints the story URL only. Phase 2 adds `square` and `og` here
// as it adds those variants to the compositor — emitting URLs today for
// crops that 404 would be worse than omitting them.
type cardLinksResponse struct {
	Code  string `json:"code"`
	Story string `json:"story"`
	Page  string `json:"page"`
}

// CardLinks handles GET /api/parties/{code}/card-links.
//
// HOST-ONLY, and deliberately 403 (not 404) for a signed-in non-host:
// this route is behind auth, the caller already knows the code, and
// telling them plainly that they aren't the host is better UX than a lie.
// The public image route is the one that must never distinguish.
func (h *PartyShareHandler) CardLinks(w http.ResponseWriter, r *http.Request) {
	claims, ok := requireClaims(w, r)
	if !ok {
		return
	}
	code := strings.ToUpper(chi.URLParam(r, "code"))
	if !isValidPartyCode(code) {
		writeError(w, http.StatusBadRequest, "invalid party code")
		return
	}

	ps := h.manager.GetPartyState(code)
	if ps == nil {
		writeError(w, http.StatusNotFound, "party not found or has ended")
		return
	}
	ps.Lock()
	hostUserID := ps.HostUserID
	ps.Unlock()
	if hostUserID != claims.UserID {
		writeError(w, http.StatusForbidden, "only the host can share this party's card")
		return
	}

	base, ok := h.absoluteBase(w, r, code)
	if !ok {
		return
	}
	token := h.cardToken(code)
	writeJSON(w, http.StatusOK, cardLinksResponse{
		Code: code,
		Story: fmt.Sprintf("%s/api/parties/%s/card.png?v=%s&t=%s",
			base, code, CardVariantStory, token),
		Page: fmt.Sprintf("%s/p/%s", base, code),
	})
}

// absoluteBase builds "<scheme>://<host>" from the request. The Host
// header is attacker-controlled, so it goes through the same strict
// authority allowlist party_qr.go uses before it is embedded in anything
// — a forged `Host: evil.com/x?` or one carrying CRLF is rejected rather
// than smuggled into a URL we hand back (or into a QR payload). The
// scheme comes from the connection or the proxy hint, never a header.
func (h *PartyShareHandler) absoluteBase(w http.ResponseWriter, r *http.Request, code string) (string, bool) {
	host := r.Host
	if !isSafeRequestHost(host) {
		slog.Warn("party card: rejected unsafe Host header", "code", code, "host", host)
		writeError(w, http.StatusBadRequest, "invalid host")
		return "", false
	}
	scheme := "http"
	if cookieSecureFor(r, h.secureCookies) {
		scheme = "https"
	}
	return scheme + "://" + host, true
}

// ServeCardPNG handles GET /api/parties/{code}/card.png?v=…&t=….
//
// Public by necessity, token-gated by policy. EVERY rejection here is a
// 404 with the same body: a bad code, an unknown variant, a wrong tag and
// a party that never existed must be indistinguishable from outside.
func (h *PartyShareHandler) ServeCardPNG(w http.ResponseWriter, r *http.Request) {
	notFound := func() { writeError(w, http.StatusNotFound, "not found") }

	code := strings.ToUpper(chi.URLParam(r, "code"))
	if !isValidPartyCode(code) {
		notFound()
		return
	}
	variant := CardVariant(r.URL.Query().Get("v"))
	if variant == "" {
		variant = CardVariantStory
	}
	if _, ok := cardLayoutFor(variant); !ok {
		notFound()
		return
	}
	// Token first: a caller without a valid tag learns nothing about
	// whether the code resolves, and never reaches the compositor.
	if !h.validCardToken(code, r.URL.Query().Get("t")) {
		notFound()
		return
	}
	// Host next, BEFORE the party lookup, so a rejected Host answers the
	// same way for a real code as for a made-up one. (It also has to
	// happen before the cache key is built — see hostCacheTag.)
	base, ok := h.absoluteBase(w, r, code)
	if !ok {
		return
	}

	ps := h.manager.GetPartyState(code)
	if ps == nil {
		notFound()
		return
	}
	ps.Lock()
	hostUserID := ps.HostUserID
	mediaItemID := ps.MediaItemID
	episodeID := ps.EpisodeID
	mediaTitle := ps.MediaTitle
	mediaPoster := ps.MediaPoster
	var scheduled *time.Time
	if ps.ScheduledStartAt != nil {
		t := *ps.ScheduledStartAt
		scheduled = &t
	}
	ps.Unlock()

	hostName, hostAvatar := h.hostIdentity(r.Context(), hostUserID)

	// The rendered card embeds the request's authority (the QR payload and
	// the "Join at …" label), so the cache key has to carry it too.
	// Without that, anyone holding a valid tag could request the card once
	// under `Host: elsewhere.example` and poison the cached PNG the host
	// then hands out — a QR pointing somewhere they never chose. The
	// authority is already allowlist-validated above; hashing it keeps the
	// filename shape fixed.
	fp := partyCardFingerprint(code, mediaTitle, mediaPoster, hostName, scheduled) + hostCacheTag(base)
	cachePath := partyCardCachePath(h.cacheDir, code, variant, fp)
	if f, err := os.Open(cachePath); err == nil {
		defer f.Close()
		cardImageHeaders(w)
		if info, statErr := f.Stat(); statErr == nil {
			http.ServeContent(w, r, "party-card.png", info.ModTime(), f)
		} else {
			_, _ = io.Copy(w, f)
		}
		return
	}

	data := h.buildCardData(r.Context(), cardInputs{
		Code:        code,
		MediaItemID: mediaItemID,
		EpisodeID:   episodeID,
		MediaTitle:  mediaTitle,
		MediaPoster: mediaPoster,
		Scheduled:   scheduled,
		HostName:    hostName,
		HostAvatar:  hostAvatar,
		Base:        base,
	})

	png, err := composeCard(variant, data)
	if err != nil {
		slog.Warn("party card: compose failed", "code", code, "variant", variant, "error", err)
		writeError(w, http.StatusInternalServerError, "failed to generate card")
		return
	}
	if err := h.writeCache(cachePath, png); err != nil {
		slog.Debug("party card: cache write failed", "code", code, "error", err)
	}
	cardImageHeaders(w)
	_, _ = w.Write(png)
}

func cardImageHeaders(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "public, max-age=300")
	w.Header().Set("X-Content-Type-Options", "nosniff")
}

// cardInputs is the raw material buildCardData turns into cardData.
type cardInputs struct {
	Code        string
	MediaItemID int64
	EpisodeID   *int64
	MediaTitle  string
	MediaPoster string
	Scheduled   *time.Time
	HostName    string
	HostAvatar  string
	Base        string
}

// buildCardData resolves everything the compositor draws: the Eastern
// date/time strings, the meta line, the QR payload, and the two images.
// Image fetches are best-effort — a card without key art still tells you
// when the party is, and a 500 tells you nothing.
func (h *PartyShareHandler) buildCardData(ctx context.Context, in cardInputs) cardData {
	d := cardData{
		Code:        in.Code,
		MediaTitle:  in.MediaTitle,
		MetaLine:    h.buildMetaLine(ctx, in.MediaItemID, in.EpisodeID),
		HostName:    in.HostName,
		HostInitial: firstInitial(in.HostName),
		Tagline:     cardTagline,
		JoinLabel:   "Join at " + strings.TrimPrefix(strings.TrimPrefix(in.Base, "https://"), "http://"),
		JoinURL:     in.Base + joinPathPrefix + in.Code,
		Seed:        cardSeed(in.Code),
	}
	if in.Scheduled != nil {
		// A live/unscheduled party simply leaves the slot empty in Phase
		// 1; the LIVE NOW treatment that fills it is Phase 2.
		d.DateCaps, d.TimeText = formatCardWhen(*in.Scheduled)
	}
	if in.MediaPoster != "" {
		if img, err := h.fetchPosterImage(in.MediaPoster); err == nil {
			d.Poster = img
		} else {
			slog.Debug("party card: poster fetch failed", "poster", in.MediaPoster, "error", err)
		}
	}
	if img := h.fetchAvatarImage(in.HostAvatar); img != nil {
		d.HostAvatar = img
	}
	return d
}

// fetchAvatarImage retrieves the host's avatar, but ONLY when it is a
// TMDB URL. memberSafeAvatar also passes through built-in `nebula:` ids,
// which are SPA-side artwork with no server representation — those fall
// back to the gradient-and-initial treatment the mockup draws anyway.
// Everything else was already filtered to "" at the member boundary.
func (h *PartyShareHandler) fetchAvatarImage(avatar string) image.Image {
	if !strings.HasPrefix(avatar, "https://image.tmdb.org/") {
		return nil
	}
	img, err := h.fetchPosterImage(avatar)
	if err != nil {
		slog.Debug("party card: avatar fetch failed", "error", err)
		return nil
	}
	return img
}

// hostIdentity resolves the host's member-visible name and avatar. This
// is the ONLY personal data the card carries, and it goes through the
// same member boundary as every other surface: display name (falling back
// to username), avatar through memberSafeAvatar. Never email or role.
func (h *PartyShareHandler) hostIdentity(ctx context.Context, hostUserID int64) (name, avatar string) {
	if h.queries == nil || hostUserID == 0 {
		return "", ""
	}
	p, err := h.queries.GetMemberProfileByID(ctx, hostUserID)
	if err != nil || p == nil {
		if err != nil {
			slog.Debug("party card: host profile lookup failed", "user_id", hostUserID, "error", err)
		}
		return "", ""
	}
	name = p.DisplayName
	if strings.TrimSpace(name) == "" {
		name = p.Username
	}
	return name, memberSafeAvatar(p.AvatarURL)
}

// buildMetaLine assembles the line under the title:
// "2022 · Action Adventure · 2h 27m" for a film, "S1 E1 · Winter Is
// Coming · 62m" for an episode. Entirely cosmetic — every lookup is
// best-effort and an empty result just drops the row from the layout.
func (h *PartyShareHandler) buildMetaLine(ctx context.Context, mediaItemID int64, episodeID *int64) string {
	if h.queries == nil || mediaItemID == 0 {
		return ""
	}
	item, err := h.queries.GetMediaItem(ctx, mediaItemID)
	if err != nil || item == nil {
		return ""
	}

	var parts []string
	if episodeID != nil {
		_, season, epNum, epTitle, err := h.queries.GetEpisodeNowPlayingInfo(ctx, *episodeID)
		if err == nil {
			parts = append(parts, fmt.Sprintf("S%d E%d", season, epNum))
			if epTitle != "" {
				parts = append(parts, epTitle)
			}
		}
	} else {
		if item.Year > 0 {
			parts = append(parts, fmt.Sprintf("%d", item.Year))
		}
		if genres, err := h.queries.GetMediaGenres(ctx, mediaItemID); err == nil && len(genres) > 0 {
			if len(genres) > 2 {
				genres = genres[:2]
			}
			parts = append(parts, strings.Join(genres, " "))
		}
	}
	if item.RuntimeMin > 0 {
		parts = append(parts, formatRuntime(item.RuntimeMin))
	}
	return strings.Join(parts, " · ")
}

// formatRuntime renders minutes as "2h 27m" / "47m".
func formatRuntime(minutes int) string {
	if minutes >= 60 {
		h, m := minutes/60, minutes%60
		if m == 0 {
			return fmt.Sprintf("%dh", h)
		}
		return fmt.Sprintf("%dh %dm", h, m)
	}
	return fmt.Sprintf("%dm", minutes)
}

// firstInitial returns the uppercased first letter of a display name for
// the avatar fallback, rune-aware so "Émile" gives "É" rather than a
// broken half-codepoint.
func firstInitial(name string) string {
	for _, r := range strings.TrimSpace(name) {
		return strings.ToUpper(string(r))
	}
	return ""
}

// cardSeed derives the starfield/grain seed from the party code, so one
// party's card is byte-identical across re-renders (the disk cache can be
// dropped at any time) while two parties get different skies.
func cardSeed(code string) uint32 {
	var s uint32 = 2166136261
	for i := 0; i < len(code); i++ {
		s ^= uint32(code[i])
		s *= 16777619
	}
	return s
}
