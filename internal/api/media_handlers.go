package api

import (
	"context"
	"errors"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/aurora-media/aurora/internal/auth"
	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/library"
	"github.com/aurora-media/aurora/internal/models"
	"github.com/aurora-media/aurora/internal/notify"
	ws "github.com/aurora-media/aurora/internal/websocket"
	"github.com/go-chi/chi/v5"
)

type LibraryHandler struct {
	queries    *db.Queries
	scanner    *library.Scanner
	hub        *ws.Hub
	watcher    *library.Watcher
	activity   *ActivityLogger
	dispatcher *notify.Dispatcher
	// rootCtx is the server-lifecycle context. Background scans parent off it
	// so a shutdown stops them; using context.Background() meant a scan kept
	// writing after main closed the DB pool ("closed pool" errors, 2026-07-30).
	// Optional — nil falls back to Background, which is the pre-existing
	// behaviour and keeps tests that build the handler directly working.
	rootCtx context.Context

	// onRescanProgressForTest fires in the retype's rescan goroutine, after the
	// watcher re-point and immediately before ScanLibrary. Nil in production.
	//
	// It exists because the ORDERING is the property, and polling for the final
	// state cannot see it: the rescan of an empty tree finishes in milliseconds,
	// so moving the re-point after the scan passes a poll either way. A review
	// showed that mutation surviving.
	onRescanProgressForTest func()
}

// SetRootContext wires the server-lifecycle context. Mirrors SetDispatcher:
// optional, called once from the router.
func (h *LibraryHandler) SetRootContext(ctx context.Context) { h.rootCtx = ctx }

// scanContext returns the context background scans should use.
func (h *LibraryHandler) scanContext() context.Context {
	if h.rootCtx != nil {
		return h.rootCtx
	}
	return context.Background()
}

func NewLibraryHandler(queries *db.Queries, scanner *library.Scanner, hub *ws.Hub, watcher *library.Watcher, activity *ActivityLogger) *LibraryHandler {
	return &LibraryHandler{queries: queries, scanner: scanner, hub: hub, watcher: watcher, activity: activity}
}

// SetDispatcher wires scan_complete admin notifications. Optional: nil
// (tests) means scans finish silently, exactly as before Phase 2.
func (h *LibraryHandler) SetDispatcher(d *notify.Dispatcher) {
	h.dispatcher = d
}

// pathAccessError turns a stat/EvalSymlinks failure on a library path
// into an actionable message. The distinction that matters is
// permission-denied vs not-found: Aurora runs as the unprivileged
// `aurora` system user, and home directories default to 0700/0750 on
// modern distros, so a path the admin plainly sees in their own shell
// is often unreachable for the service. Reporting that case as "does
// not exist" sent a real install down a dead end (2026-07-17 report);
// the message now names the actual problem and the commands that fix
// it. These strings surface verbatim in the admin UI's alert dialog.
func pathAccessError(p string, err error) string {
	if errors.Is(err, fs.ErrPermission) {
		return "the Aurora service user cannot access " + p +
			" (permission denied). Grant read access on the server with:" +
			" sudo setfacl -m u:aurora:x <each parent directory> &&" +
			" sudo setfacl -R -m u:aurora:rX " + p +
			" — or re-run the installer with AURORA_MEDIA_DIR=" + p
	}
	return "path does not exist on the server: " + p +
		" (library paths refer to the server's filesystem)"
}

func (h *LibraryHandler) Create(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r.Context())

	var req models.CreateLibraryRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.Name == "" || len(req.Paths) == 0 {
		writeError(w, http.StatusBadRequest, "name and paths required")
		return
	}
	// 2026-05-19 audit (API-H5) — cap library Name to the same 200
	// chars the Update path enforces. Without this, a 10 MB JSON name
	// hits the DB VARCHAR(255) constraint with a generic 500. Library
	// schema is VARCHAR(255); 200 leaves headroom for trim/whitespace.
	if len(req.Name) > 200 {
		writeError(w, http.StatusBadRequest, "name must be 200 characters or fewer")
		return
	}
	if req.Type != models.LibraryMovies && req.Type != models.LibraryShows {
		writeError(w, http.StatusBadRequest, "type must be 'movie' or 'show'")
		return
	}

	// Validate library paths exist and are directories.
	// Resolve symlinks so the blocklist catches the real target.
	//
	// 2026-05-19 audit (API-H6) — added /var/lib/aurora to the blocklist.
	// That's Aurora's own state dir (source mirror, update-status.json,
	// trigger-update). An admin pointing a library at it would expose
	// Aurora's internal files via direct-play streaming.
	blockedPrefixes := []string{"/etc", "/root", "/proc", "/sys", "/dev", "/boot", "/var/run", "/run", "/var/lib/aurora"}
	resolvedPaths := make([]string, 0, len(req.Paths))
	for _, p := range req.Paths {
		cleanPath := filepath.Clean(p)

		// Resolve symlinks to get the real filesystem path.
		// This prevents symlink-to-/etc from bypassing the blocklist.
		resolved, err := filepath.EvalSymlinks(cleanPath)
		if err != nil {
			writeError(w, http.StatusBadRequest, pathAccessError(p, err))
			return
		}

		for _, blocked := range blockedPrefixes {
			if resolved == blocked || strings.HasPrefix(resolved, blocked+"/") {
				writeError(w, http.StatusBadRequest, "path not allowed: "+p)
				return
			}
		}
		info, err := os.Lstat(resolved) // Lstat on resolved path (symlinks already resolved)
		if err != nil {
			writeError(w, http.StatusBadRequest, pathAccessError(p, err))
			return
		}
		if !info.IsDir() {
			writeError(w, http.StatusBadRequest, "path is not a directory: "+p)
			return
		}
		resolvedPaths = append(resolvedPaths, resolved)
	}

	lib := &models.Library{
		Name:         req.Name,
		Type:         req.Type,
		Paths:        resolvedPaths, // Store resolved paths, not user-supplied symlinks
		ScanInterval: 360,           // default 6 hours
		OwnerID:      claims.UserID,
	}

	if err := h.queries.CreateLibrary(r.Context(), lib); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create library")
		return
	}

	if h.activity != nil {
		h.activity.LogLibraryCreated(r.Context(), claims.UserID, lib.Name)
	}

	// Start watcher + auto-scan in background so the HTTP response returns immediately.
	// WatchLibrary calls addDirRecursive (filepath.WalkDir) which can take minutes
	// for large libraries — doing it synchronously caused 504 gateway timeouts.
	go func() {
		if h.watcher != nil {
			if err := h.watcher.WatchLibrary(context.Background(), lib); err != nil {
				slog.Warn("failed to start watcher for new library", "library", lib.Name, "error", err)
			}
		}
		if h.scanner.TryStartScan(lib.ID) {
			// Tell the watcher we just kicked off a scan so its periodic
			// timer + fsnotify debounce don't re-fire on the same library
			// within the 30s dedup window. Without this, a fsnotify event
			// from the initial directory walk could schedule a redundant
			// scan that TryStartScan would silently reject.
			if h.watcher != nil {
				h.watcher.NoteExternalScan(lib.ID)
			}
			scanCtx := h.scanContext()
			h.scanner.ScanLibrary(scanCtx, lib, func(p *models.ScanProgress) {
				h.hub.Broadcast(ws.EventScanProgress, p)
				if h.activity != nil && (p.Status == models.ScanComplete || p.Status == models.ScanFailed) {
					h.activity.LogScanCompleted(scanCtx, lib.ID, lib.Name, p.TotalFiles)
				}
				if p.Status == models.ScanComplete && p.NewFiles > 0 {
					h.hub.Broadcast(ws.EventLibraryUpdate, map[string]interface{}{
						"library_id":   lib.ID,
						"library_name": lib.Name,
						"new_items":    p.NewFiles,
						"action":       "scan_completed",
					})
					if h.dispatcher != nil {
						h.dispatcher.ScanCompleted(scanCtx, lib.Name, p.NewFiles)
					}
				}
			})
		}
	}()

	writeJSON(w, http.StatusCreated, lib)
}

func (h *LibraryHandler) List(w http.ResponseWriter, r *http.Request) {
	libs, err := h.queries.GetLibraries(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list libraries")
		return
	}
	if libs == nil {
		libs = []*models.Library{}
	}
	writeJSON(w, http.StatusOK, libs)
}

func (h *LibraryHandler) Delete(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid library id")
		return
	}

	// Stop file watcher before deleting from DB
	if h.watcher != nil {
		h.watcher.UnwatchLibrary(id)
	}

	deleted, err := h.queries.DeleteLibrary(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete library")
		return
	}
	if !deleted {
		writeError(w, http.StatusNotFound, "library not found")
		return
	}

	if h.activity != nil {
		claims := auth.GetClaims(r.Context())
		h.activity.LogLibraryDeleted(r.Context(), claims.UserID, id)
	}

	writeJSON(w, http.StatusOK, map[string]string{"message": "library deleted"})
}

func (h *LibraryHandler) Update(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid library id")
		return
	}

	var req models.UpdateLibraryRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.Name == nil {
		writeError(w, http.StatusBadRequest, "name is required")
		return
	}

	name := strings.TrimSpace(*req.Name)
	if name == "" || len(name) > 200 {
		writeError(w, http.StatusBadRequest, "name must be 1-200 characters")
		return
	}

	updated, err := h.queries.UpdateLibrary(r.Context(), id, name)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update library")
		return
	}
	if updated == nil {
		writeError(w, http.StatusNotFound, "library not found")
		return
	}

	writeJSON(w, http.StatusOK, updated)
}

func (h *LibraryHandler) Scan(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid library id")
		return
	}

	lib, err := h.queries.GetLibrary(r.Context(), id)
	if err != nil || lib == nil {
		writeError(w, http.StatusNotFound, "library not found")
		return
	}

	// Atomically check + claim the scan slot to prevent concurrent scans
	if !h.scanner.TryStartScan(lib.ID) {
		writeError(w, http.StatusConflict, "scan already in progress")
		return
	}

	if h.activity != nil {
		h.activity.LogScanStarted(r.Context(), lib.ID, lib.Name)
	}

	// Start scan in background with a detached context.
	// IMPORTANT: r.Context() is cancelled when the HTTP response completes, so
	// the long-running scan needs its own — but NOT context.Background(), which
	// outlives shutdown and lands writes on a closed pool. The server-lifecycle
	// context detaches from the request while still ending at shutdown.
	go func() {
		scanCtx := context.Background()
		h.scanner.ScanLibrary(scanCtx, lib, func(p *models.ScanProgress) {
			h.hub.Broadcast(ws.EventScanProgress, p)
			if h.activity != nil && (p.Status == models.ScanComplete || p.Status == models.ScanFailed) {
				h.activity.LogScanCompleted(scanCtx, lib.ID, lib.Name, p.TotalFiles)
			}
			// Notify all users about new library content
			if p.Status == models.ScanComplete && p.NewFiles > 0 {
				h.hub.Broadcast(ws.EventLibraryUpdate, map[string]interface{}{
					"library_id":   lib.ID,
					"library_name": lib.Name,
					"new_items":    p.NewFiles,
					"action":       "scan_completed",
				})
				if h.dispatcher != nil {
					h.dispatcher.ScanCompleted(scanCtx, lib.Name, p.NewFiles)
				}
			}
		})
	}()

	writeJSON(w, http.StatusAccepted, map[string]string{"message": "scan started"})
}

// Health reports each library's metadata-match rate and warns about the ones
// that look mis-typed. Admin-only, and mounted under /api/admin rather than
// beside the other library routes because GET /api/libraries is NOT admin-gated
// — every signed-in member reads it to render the browse tabs, and per-library
// item counts plus a diagnosis of what is wrong with the server are not theirs.
//
// Report only. It never changes a library; correcting one destroys catalog rows
// and has its own explicit action.
func (h *LibraryHandler) Health(w http.ResponseWriter, r *http.Request) {
	tallies, err := h.queries.GetLibraryMatchHealth(r.Context())
	if err != nil {
		slog.Error("library health query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to read library health")
		return
	}
	// h.scanner is a *library.Scanner, so passing it straight in wraps a nil
	// pointer in a NON-nil interface and the adapter's `s == nil` check misses
	// it. Narrow it here instead. Production always sets the field; tests build
	// handlers without one.
	var progress ScanProgressSource
	if h.scanner != nil {
		progress = h.scanner
	}
	writeJSON(w, http.StatusOK, LibraryHealthReportFor(tallies, progress))
}

func (h *LibraryHandler) ScanStatus(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid library id")
		return
	}

	progress := h.scanner.GetProgress(id)
	writeJSON(w, http.StatusOK, progress)
}

// ============================================================
// Media Handlers
// ============================================================

// allowedRatingsForMax is a thin alias over the canonical content-rating ladder
// in package db (single source of truth — db/ratings.go). Kept as a
// package-local name so existing api call sites read unchanged; browse,
// onboarding, and the recommender now all gate through the same ladder.
func allowedRatingsForMax(maxRating string) []string {
	return db.AllowedRatingsForMax(maxRating)
}

type MediaHandler struct {
	queries  *db.Queries
	activity *ActivityLogger  // optional; nil in tests
	semantic SemanticSearcher // optional; nil when LLM is disabled
}

// SemanticSearcher is the contract MediaHandler uses for natural-language
// search. Defining the interface here (instead of importing internal/search
// directly) keeps the api package free of LLM dependencies and makes the
// handler trivially testable with a fake.
type SemanticSearcher interface {
	Search(ctx context.Context, query string, limit int) ([]SemanticHit, error)
}

// SemanticHit mirrors search.Hit at the API boundary. The api package owns
// what's serialized; the search package can evolve its internal types freely.
// Reason is the LLM-generated one-line caption for this hit, when the rerank
// stage succeeded — empty string when the search fell back to vector order.
type SemanticHit struct {
	Item   *models.MediaItem
	Score  float64
	Reason string
}

func NewMediaHandler(queries *db.Queries, activity *ActivityLogger) *MediaHandler {
	return &MediaHandler{queries: queries, activity: activity}
}

// DeleteItem removes a media item (show or movie) and everything hanging off
// it — files, seasons, episodes, artwork, cast, watch progress — from the
// catalog. Admin-only. This is the manual counterpart to the scanner's
// automatic empty-item cleanup (DeleteEmptyMediaItems): it lets an admin
// remove a "no files available" ghost immediately instead of waiting for the
// next scan, and also works on an item whose files are still on disk. The
// files themselves are left untouched; only Aurora's library entry is removed.
func (h *MediaHandler) DeleteItem(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid media id")
		return
	}

	// Look the item up first so we have its title for the activity log and can
	// return a clean 404 (vs a generic 200) when the id doesn't exist.
	item, err := h.queries.GetMediaItem(r.Context(), id)
	if err != nil || item == nil {
		writeError(w, http.StatusNotFound, "media not found")
		return
	}

	deleted, err := h.queries.DeleteMediaItem(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete media item")
		return
	}
	if !deleted {
		// Raced with another delete (or the scanner's empty-item sweep) between
		// the lookup and the delete — already gone is the desired end state.
		writeError(w, http.StatusNotFound, "media not found")
		return
	}

	if h.activity != nil {
		if claims := auth.GetClaims(r.Context()); claims != nil {
			h.activity.LogMediaDeleted(r.Context(), claims.UserID, id, item.Title)
		}
	}

	writeJSON(w, http.StatusOK, map[string]string{"message": "media deleted"})
}

// SetSemanticSearcher attaches the optional semantic-search backend. Pass nil
// (or never call this) to keep the handler on the trigram-only path.
func (h *MediaHandler) SetSemanticSearcher(s SemanticSearcher) {
	h.semantic = s
}

// wantsRecommendations reports whether a search query is explicitly asking the
// system to reason about taste — a comparison ("movies like X", "similar to
// Y", "reminds me of Z") or a request ("recommend a thriller", "what should I
// watch"). These are the ONLY queries routed straight to the semantic LLM
// path, because the trigram path would short-circuit on a title embedded in
// the phrase (e.g. "movies like The Matrix" trigram-matches "The Matrix" and
// returns it, instead of titles *similar* to it).
//
// Everything else — including multi-word exact titles ("A Time to Kill",
// "Gone with the Wind") and titles that merely contain a mood word ("The Dark
// Knight", "Good Will Hunting") — goes to the trigram path FIRST. Title
// lookups must always check the library before paying the LLM round-trip;
// marker-less queries the library can't satisfy fall back to semantic at the
// call site, so descriptive vibe queries ("dark gritty thriller") still work.
//
// Issue #207: the previous heuristic routed any 4+-word query (and any title
// containing an incidental word like "dark"/"good"/"with") to the slow, fuzzy
// semantic path, so exact titles came back wrong or empty.
//
// True (semantic-first): "movies like Severance", "recommend a thriller",
//
//	"what should I watch tonight"
//
// False (trigram-first): "Inception", "A Time to Kill", "The Dark Knight",
//
//	"dark gritty thriller"
func wantsRecommendations(query string) bool {
	q := strings.ToLower(strings.TrimSpace(query))
	if q == "" {
		return false
	}
	return recommendationMarkerRE.MatchString(q)
}

// recommendationMarkerRE matches comparison + request phrases that signal a
// taste query. It deliberately excludes bare mood adjectives (dark, good,
// funny, scary…), prepositions (with, without), and title-leading request
// phrases (show me, find me — cf. "Show Me a Hero") because those appear in
// real titles and caused #207. Descriptive queries without an explicit marker
// are handled by the empty-trigram → semantic fallback instead.
var recommendationMarkerRE = regexp.MustCompile(
	`\b(like|similar|reminds? me|kind of|sort of|feels? like|recommend|suggest|what should|vibes|mood|feeling)\b`,
)

// semanticFirst decides whether a query should try the semantic LLM path
// before trigram. It returns false when no LLM is configured or the caller
// forced ?mode=literal, and true when ?mode=semantic or the query carries an
// explicit recommendation marker. Marker-less queries return false here and
// only reach semantic via the empty-trigram fallback in Search — so exact
// title lookups always check the library first (#207).
func semanticFirst(mode, query string, semanticConfigured bool) bool {
	if !semanticConfigured || mode == "literal" {
		return false
	}
	return mode == "semantic" || wantsRecommendations(query)
}

// retryListQuery runs fn, and on a transient (non-canceled) error retries it
// once after a short, context-aware backoff. This absorbs a brief DB blip — e.g.
// pool/connection exhaustion while the startup metadata-refresh worker hammers
// the DB, which surfaced as a fast 500 on the library list. The retry reuses the
// request context (a context-error retry would be doomed, so we skip it), and
// the backoff aborts immediately if the request is canceled. Extracted so the
// retry policy is unit-testable without a database.
func retryListQuery(ctx context.Context, fn func() ([]*models.MediaItem, int64, error)) ([]*models.MediaItem, int64, error) {
	items, total, err := fn()
	if err == nil || ctx.Err() != nil {
		return items, total, err
	}
	slog.Warn("media list query failed, retrying once", "error", err)
	select {
	case <-time.After(75 * time.Millisecond):
	case <-ctx.Done():
		return items, total, ctx.Err()
	}
	return fn()
}

func (h *MediaHandler) List(w http.ResponseWriter, r *http.Request) {
	claims, ok := requireClaims(w, r)
	if !ok {
		return
	}
	q := r.URL.Query()
	filter := models.MediaFilter{
		Type:   models.MediaType(q.Get("type")),
		Genre:  q.Get("genre"),
		SortBy: q.Get("sort_by"),
		Query:  q.Get("q"),
	}
	if yearStr := q.Get("year"); yearStr != "" {
		filter.Year, _ = strconv.Atoi(yearStr)
	}
	// Issue #462 — the rating ceiling used to come straight off the
	// client-supplied max_rating query param (a full bypass: any client
	// could ask for an unfiltered feed by simply omitting it). It's now
	// derived server-side from the request's acting sub-profile, same
	// mechanism the read/playback path enforces with. This endpoint is
	// discovery/UX, not the security boundary (that's the playback path in
	// phase2_handlers.go) — so on a profile-resolve error we log and fall
	// back to unrestricted rather than fail the whole browse/search surface,
	// matching this codebase's existing fail-open posture for non-security
	// convenience checks (e.g. ChangeMedia's existence check).
	if profile, err := h.queries.ResolveActingProfile(r.Context(), claims.UserID, claims.RefreshTokenID); err != nil {
		slog.Warn("resolve acting profile for media list failed, defaulting to unrestricted", "user_id", claims.UserID, "error", err)
	} else {
		filter.AllowedRatings = db.AllowedRatingsForMax(profile.MaxAgeRating)
	}

	params := paginate(r)

	// GetMediaItems now performs cross-library deduplication at the SQL level
	// using DISTINCT ON, so COUNT and OFFSET operate on the deduped result set.
	// No application-level overfetch/dedup/trim needed.
	items, total, err := retryListQuery(r.Context(), func() ([]*models.MediaItem, int64, error) {
		return h.queries.GetMediaItems(r.Context(), filter, params)
	})
	if err != nil {
		// A canceled request (client walked away, or the retry's backoff was
		// cut short) isn't a server error — don't log it as one or write a 500
		// nobody will read.
		if r.Context().Err() != nil {
			return
		}
		// Log the real error — previously it was swallowed, leaving the 500 a
		// mystery with no diagnostic trail.
		slog.Error("media list query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to query media")
		return
	}
	if items == nil {
		items = []*models.MediaItem{}
	}

	// Annotate items with has_4k badge (cross-library aware)
	if len(items) > 0 {
		ids := make([]int64, len(items))
		for i, item := range items {
			ids[i] = item.ID
		}
		fourKMap, err := h.queries.GetMediaItemsWith4KCrossLibrary(r.Context(), ids)
		if err != nil {
			slog.Warn("failed to query 4K versions", "error", err)
		} else {
			for _, item := range items {
				item.Has4K = fourKMap[item.ID]
			}
		}

		// Annotate has_hdr the same way (cross-library aware). A failed
		// HDR query is non-fatal — the badge is cosmetic, so we log and
		// leave has_hdr false rather than failing the whole list response.
		hdrMap, err := h.queries.GetMediaItemsWithHDRCrossLibrary(r.Context(), ids)
		if err != nil {
			slog.Warn("failed to query HDR versions", "error", err)
		} else {
			for _, item := range items {
				item.HasHDR = hdrMap[item.ID]
			}
		}

		// Load genres for all items in batch
		genreMap, err := h.queries.GetMediaGenresBatch(r.Context(), ids)
		if err != nil {
			slog.Warn("failed to query genres", "error", err)
		} else {
			for _, item := range items {
				item.Genres = genreMap[item.ID]
			}
		}
	}

	writeJSON(w, http.StatusOK, paginatedResponse(items, total, params))
}

// ListGenres returns the distinct genre names present in the library,
// optionally narrowed to a single media type (movie | show). Used by
// BrowseView to populate the genre dropdown with the FULL catalog of
// genres — not just the genres present in the currently loaded page,
// which would shift each time the user paginated or re-sorted.
//
// Returns: { "genres": ["Action", "Comedy", "Horror", ...] }
// Sorted alphabetically; admin/internal-only genres (none currently)
// are not filtered here — the genres table is curated.
func (h *MediaHandler) ListGenres(w http.ResponseWriter, r *http.Request) {
	mediaType := r.URL.Query().Get("type")
	// Whitelist the type param so a typo returns 400 instead of an
	// empty array (which would look like a legitimate "no genres
	// found" response and silently break the dropdown).
	if mediaType != "" && mediaType != "movie" && mediaType != "show" {
		writeError(w, http.StatusBadRequest, "type must be 'movie' or 'show'")
		return
	}
	genres, err := h.queries.ListGenres(r.Context(), mediaType)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list genres")
		return
	}
	if genres == nil {
		genres = []string{}
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"genres": genres})
}

func (h *MediaHandler) GetFiles(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid media id")
		return
	}

	// Try cross-library file aggregation first
	crossFiles, libNames, crossErr := h.queries.GetCrossLibraryFiles(r.Context(), id)
	if crossErr == nil && len(crossFiles) > 0 {
		for _, f := range crossFiles {
			if name, ok := libNames[f.ID]; ok {
				f.LibraryName = name
			}
		}
		writeJSON(w, http.StatusOK, crossFiles)
		return
	}

	// Fallback: no TMDB ID or cross-library query failed
	files, err := h.queries.GetMediaFiles(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to get files")
		return
	}
	if files == nil {
		files = []*models.MediaFile{}
	}

	writeJSON(w, http.StatusOK, files)
}

func (h *MediaHandler) Recent(w http.ResponseWriter, r *http.Request) {
	claims, ok := requireClaims(w, r)
	if !ok {
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 || limit > 50 {
		limit = 20
	}

	// The ceiling comes from the session's acting profile (issue #462), never
	// the profile_id/max_rating a client sends, with the same fail-open posture
	// as List: this is discovery, and the read/playback path is the boundary.
	var allowedRatings []string
	if profile, err := h.queries.ResolveActingProfile(r.Context(), claims.UserID, claims.RefreshTokenID); err != nil {
		slog.Warn("resolve acting profile for recent media failed, defaulting to unrestricted", "user_id", claims.UserID, "error", err)
	} else {
		allowedRatings = db.AllowedRatingsForMax(profile.MaxAgeRating)
	}

	// GetRecentMedia performs SQL-level dedup via DISTINCT ON CTE
	items, err := h.queries.GetRecentMedia(r.Context(), limit, allowedRatings)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to get recent media")
		return
	}
	if items == nil {
		items = []*models.MediaItem{}
	}

	// Annotate items with has_4k badge and genres (cross-library aware)
	if len(items) > 0 {
		ids := make([]int64, len(items))
		for i, item := range items {
			ids[i] = item.ID
		}
		fourKMap, err := h.queries.GetMediaItemsWith4KCrossLibrary(r.Context(), ids)
		if err != nil {
			slog.Warn("failed to query 4K versions", "error", err)
		} else {
			for _, item := range items {
				item.Has4K = fourKMap[item.ID]
			}
		}

		// Annotate has_hdr the same way (cross-library aware). A failed
		// HDR query is non-fatal — the badge is cosmetic, so we log and
		// leave has_hdr false rather than failing the whole list response.
		hdrMap, err := h.queries.GetMediaItemsWithHDRCrossLibrary(r.Context(), ids)
		if err != nil {
			slog.Warn("failed to query HDR versions", "error", err)
		} else {
			for _, item := range items {
				item.HasHDR = hdrMap[item.ID]
			}
		}

		genreMap, err := h.queries.GetMediaGenresBatch(r.Context(), ids)
		if err != nil {
			slog.Warn("failed to query genres", "error", err)
		} else {
			for _, item := range items {
				item.Genres = genreMap[item.ID]
			}
		}
	}

	writeJSON(w, http.StatusOK, items)
}

func (h *MediaHandler) Search(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query().Get("q")
	if query == "" {
		writeError(w, http.StatusBadRequest, "search query required")
		return
	}
	// 2026-05-19 audit (API-M5) — cap query length. Without this, a
	// 100 KB query string burns trigram + (optionally) LLM-embed
	// budget under DB CPU + token cost. 200 chars is comfortably
	// above any human-typed search (the longest natural-language
	// title query peaks around 80 chars).
	if len(query) > 200 {
		writeError(w, http.StatusBadRequest, "search query must be 200 characters or fewer")
		return
	}

	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 || limit > 50 {
		limit = 20
	}

	// Routing. Title lookups must hit the trigram path FIRST — it does exact,
	// substring, and typo-tolerant matching, so any title actually in the
	// library always resolves. Only queries that explicitly ask for
	// recommendations ("movies like X", "recommend a thriller") skip straight
	// to the semantic LLM path, because trigram would short-circuit on a title
	// embedded in such a phrase. Marker-less queries the library can't satisfy
	// fall back to semantic, so descriptive vibe queries still work (#207).
	//
	// The `mode` query param forces a side for testing:
	//   ?mode=semantic — use the LLM path (degrades to trigram on error)
	//   ?mode=literal  — use trigram only, never the LLM
	mode := r.URL.Query().Get("mode")

	// trigram runs the fast literal path (exact + substring + trigram-similar).
	trigram := func() ([]*models.MediaItem, error) {
		fetchLimit := limit + 10
		if fetchLimit > 50 {
			fetchLimit = 50
		}
		return h.queries.SearchMedia(r.Context(), query, fetchLimit)
	}
	// semantic runs the LLM path; ok is false when it errored (the caller
	// decides how to degrade). Reason is a transient per-search annotation set
	// here rather than on the model so it doesn't bleed into other endpoints
	// that serve the same media item.
	semantic := func() (its []*models.MediaItem, ok bool) {
		hits, err := h.semantic.Search(r.Context(), query, limit+10)
		if err != nil {
			slog.Warn("semantic search failed", "error", err, "q", query)
			return nil, false
		}
		its = make([]*models.MediaItem, len(hits))
		for i, hit := range hits {
			its[i] = hit.Item
			if hit.Reason != "" && its[i] != nil {
				its[i].Reason = hit.Reason
			}
		}
		return its, true
	}

	var items []*models.MediaItem
	// Reported back in X-Search-Mode so the frontend shows a "Smart search"
	// badge only when the LLM path actually served the results.
	searchMode := "literal"
	// semanticAllowed gates the empty-result fallback; ?mode=literal opts a
	// request out of the LLM entirely.
	semanticAllowed := h.semantic != nil && mode != "literal"

	if semanticFirst(mode, query, h.semantic != nil) {
		// Explicit recommendation/comparison query → LLM first.
		sem, semOK := semantic()
		if !semOK {
			writeError(w, http.StatusInternalServerError, "search failed")
			return
		}
		items = sem
		searchMode = "semantic"
		// Trigram rescue. semanticFirst routes on MARKER WORDS ("like",
		// "similar to", "movies about"), and those words also occur inside real
		// titles — "As You Like It", "Something Like Summer". When the LLM
		// answers successfully but finds nothing, the query may simply have
		// been a title lookup that tripped a marker, so fall back to trigram
		// rather than serving an empty page for a film the library actually
		// has. Mirrors the empty-trigram → semantic fallback in the else
		// branch, in the opposite direction.
		//
		// A trigram error here is NOT fatal: the semantic path already
		// succeeded, so the correct outcome is its (empty) result, not a 500.
		if len(items) == 0 {
			if its, err := trigram(); err == nil && len(its) > 0 {
				items, searchMode = its, "literal"
			}
		}
	} else {
		// Title lookup → trigram first.
		its, err := trigram()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "search failed")
			return
		}
		items = its
		// Nothing in the library matched: fall back to semantic so a
		// marker-less descriptive query ("dark gritty thriller") still
		// returns something instead of an empty page.
		if len(items) == 0 && semanticAllowed {
			if sem, ok := semantic(); ok && len(sem) > 0 {
				items, searchMode = sem, "semantic"
			}
		}
	}
	if items == nil {
		items = []*models.MediaItem{}
	}
	w.Header().Set("X-Search-Mode", searchMode)

	// Annotate items with has_4k badge (cross-library aware)
	if len(items) > 0 {
		ids := make([]int64, len(items))
		for i, item := range items {
			ids[i] = item.ID
		}
		fourKMap, err := h.queries.GetMediaItemsWith4KCrossLibrary(r.Context(), ids)
		if err != nil {
			slog.Warn("failed to query 4K versions", "error", err)
		} else {
			for _, item := range items {
				item.Has4K = fourKMap[item.ID]
			}
		}

		// Annotate has_hdr the same way (cross-library aware). A failed
		// HDR query is non-fatal — the badge is cosmetic, so we log and
		// leave has_hdr false rather than failing the whole list response.
		hdrMap, err := h.queries.GetMediaItemsWithHDRCrossLibrary(r.Context(), ids)
		if err != nil {
			slog.Warn("failed to query HDR versions", "error", err)
		} else {
			for _, item := range items {
				item.HasHDR = hdrMap[item.ID]
			}
		}

		// Load genres for all items in batch
		genreMap, err := h.queries.GetMediaGenresBatch(r.Context(), ids)
		if err != nil {
			slog.Warn("failed to query genres", "error", err)
		} else {
			for _, item := range items {
				item.Genres = genreMap[item.ID]
			}
		}
	}

	// Deduplicate cross-library items
	deduped, err := h.queries.DeduplicateByTMDBID(r.Context(), items)
	if err != nil {
		slog.Warn("failed to deduplicate search results", "error", err)
		deduped = items
	}

	// Trim to requested limit after dedup
	if len(deduped) > limit {
		deduped = deduped[:limit]
	}

	writeJSON(w, http.StatusOK, deduped)
}
