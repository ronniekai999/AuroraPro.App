package api

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/aurora-media/aurora/internal/auth"
	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/library"
	"github.com/aurora-media/aurora/internal/models"
	ws "github.com/aurora-media/aurora/internal/websocket"
	"github.com/go-chi/chi/v5"
)

type LibraryHandler struct {
	queries  *db.Queries
	scanner  *library.Scanner
	hub      *ws.Hub
	watcher  *library.Watcher
	activity *ActivityLogger
}

func NewLibraryHandler(queries *db.Queries, scanner *library.Scanner, hub *ws.Hub, watcher *library.Watcher, activity *ActivityLogger) *LibraryHandler {
	return &LibraryHandler{queries: queries, scanner: scanner, hub: hub, watcher: watcher, activity: activity}
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
			writeError(w, http.StatusBadRequest, "path does not exist: "+p)
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
			writeError(w, http.StatusBadRequest, "path does not exist: "+p)
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
			scanCtx := context.Background()
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

	// Start scan in background with detached context
	// IMPORTANT: r.Context() gets cancelled when the HTTP response completes,
	// so we use context.Background() for the long-running scan goroutine.
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
			}
		})
	}()

	writeJSON(w, http.StatusAccepted, map[string]string{"message": "scan started"})
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

// ageRatingOrder maps content rating strings to a numeric severity level.
// Both MPAA (movie) and TV Parental Guidelines ratings are supported.
var ageRatingOrder = map[string]int{
	"G": 1, "PG": 2, "PG-13": 3, "R": 4, "NC-17": 5,
	"TV-Y": 1, "TV-Y7": 2, "TV-G": 2, "TV-PG": 3, "TV-14": 4, "TV-MA": 5,
}

// allowedRatingsForMax returns all rating strings whose severity is at or
// below the given max rating. Returns nil if maxRating is not recognized.
func allowedRatingsForMax(maxRating string) []string {
	maxLevel, ok := ageRatingOrder[maxRating]
	if !ok {
		return nil
	}
	var allowed []string
	for rating, level := range ageRatingOrder {
		if level <= maxLevel {
			allowed = append(allowed, rating)
		}
	}
	return allowed
}

type MediaHandler struct {
	queries  *db.Queries
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

func NewMediaHandler(queries *db.Queries) *MediaHandler {
	return &MediaHandler{queries: queries}
}

// SetSemanticSearcher attaches the optional semantic-search backend. Pass nil
// (or never call this) to keep the handler on the trigram-only path.
func (h *MediaHandler) SetSemanticSearcher(s SemanticSearcher) {
	h.semantic = s
}

// isLiteralLookalike heuristically classifies a search query as a title
// lookup vs a descriptive/conversational query. Mirrors search.IsLiteralQuery
// but kept inline here so the api package doesn't need to import internal/search
// just for one regex.
//
// True (use trigram):  "Inception", "the matrix", "severance s2"
// False (use semantic): "movies like Severance", "feel-good 90s sci-fi"
func isLiteralLookalike(query string) bool {
	q := strings.ToLower(strings.TrimSpace(query))
	if q == "" {
		return true
	}
	if literalLookalikeRE.MatchString(q) {
		return false
	}
	return len(strings.Fields(q)) <= 3
}

var literalLookalikeRE = regexp.MustCompile(
	`\b(like|similar|kind of|sort of|feels? like|reminds? me|something|anything|good|best|recommend|watch|show me|find me|should|with|without|but|funny|sad|scary|dark|light|cozy|wholesome|gritty|underrated)\b`,
)

func (h *MediaHandler) List(w http.ResponseWriter, r *http.Request) {
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
	if maxRating := q.Get("max_rating"); maxRating != "" {
		filter.MaxRating = maxRating
		filter.AllowedRatings = allowedRatingsForMax(maxRating)
	}

	params := paginate(r)

	// GetMediaItems now performs cross-library deduplication at the SQL level
	// using DISTINCT ON, so COUNT and OFFSET operate on the deduped result set.
	// No application-level overfetch/dedup/trim needed.
	items, total, err := h.queries.GetMediaItems(r.Context(), filter, params)
	if err != nil {
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
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 || limit > 50 {
		limit = 20
	}

	// GetRecentMedia performs SQL-level dedup via DISTINCT ON CTE
	items, err := h.queries.GetRecentMedia(r.Context(), limit)
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

	// Route: short, literal-looking queries go to the trigram path (it's
	// faster and better at exact title matching). Conversational / vibe
	// queries go to the semantic path. The `mode` query param can force
	// either side for testing: ?mode=semantic or ?mode=literal.
	mode := r.URL.Query().Get("mode")
	useSemantic := h.semantic != nil &&
		(mode == "semantic" || (mode == "" && !isLiteralLookalike(query)))

	var items []*models.MediaItem
	// Reported back in X-Search-Mode so the frontend can show a "Smart search"
	// badge when the LLM path was actually used. "semantic" means the LLM
	// parsed + retrieved; "literal" means we used the trigram fast path.
	searchMode := "literal"
	if useSemantic {
		hits, err := h.semantic.Search(r.Context(), query, limit+10)
		if err != nil {
			// Degrade silently to trigram so the user still gets results.
			slog.Warn("semantic search failed, falling back to trigram", "error", err, "q", query)
			items, err = h.queries.SearchMedia(r.Context(), query, limit+10)
			if err != nil {
				writeError(w, http.StatusInternalServerError, "search failed")
				return
			}
			searchMode = "literal" // fell back; don't claim semantic
		} else {
			items = make([]*models.MediaItem, len(hits))
			for i, hit := range hits {
				items[i] = hit.Item
				// Reason is a transient per-search annotation — set it here
				// rather than on the model so it doesn't bleed into other
				// endpoints that serve the same media item.
				if hit.Reason != "" && items[i] != nil {
					items[i].Reason = hit.Reason
				}
			}
			searchMode = "semantic"
		}
	} else {
		fetchLimit := limit + 10
		if fetchLimit > 50 {
			fetchLimit = 50
		}
		var err error
		items, err = h.queries.SearchMedia(r.Context(), query, fetchLimit)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "search failed")
			return
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
