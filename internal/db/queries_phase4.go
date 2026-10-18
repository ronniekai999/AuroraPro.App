package db

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/aurora-media/aurora/internal/models"
	"github.com/jackc/pgx/v5"
)

// ============================================================
// User Profiles
// ============================================================

func (q *Queries) CreateProfile(ctx context.Context, p *models.UserProfile) error {
	return q.pool.QueryRow(ctx, `
		INSERT INTO user_profiles (user_id, name, avatar_url, is_default, max_age_rating, language, subtitle_lang, subtitle_mode)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		RETURNING id, created_at, updated_at`,
		p.UserID, p.Name, p.AvatarURL, p.IsDefault, nilIfEmpty(p.MaxAgeRating),
		p.Language, nilIfEmpty(p.SubtitleLang), p.SubtitleMode,
	).Scan(&p.ID, &p.CreatedAt, &p.UpdatedAt)
}

func (q *Queries) GetProfilesByUser(ctx context.Context, userID int64) ([]*models.UserProfile, error) {
	rows, err := q.pool.Query(ctx, `
		SELECT id, user_id, name, COALESCE(avatar_url, ''), is_default,
		       COALESCE(max_age_rating, ''), COALESCE(language, ''), COALESCE(subtitle_lang, ''),
		       COALESCE(subtitle_mode, ''), created_at, updated_at, taste_onboarding_completed,
		       maturity_pref, (pin_hash IS NOT NULL)
		FROM user_profiles WHERE user_id = $1
		ORDER BY is_default DESC, name`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var profiles []*models.UserProfile
	for rows.Next() {
		p := &models.UserProfile{}
		if err := rows.Scan(&p.ID, &p.UserID, &p.Name, &p.AvatarURL, &p.IsDefault,
			&p.MaxAgeRating, &p.Language, &p.SubtitleLang, &p.SubtitleMode,
			&p.CreatedAt, &p.UpdatedAt, &p.TasteOnboardingCompleted, &p.MaturityPref, &p.HasPIN); err != nil {
			return nil, err
		}
		profiles = append(profiles, p)
	}
	return profiles, rows.Err()
}

func (q *Queries) GetProfile(ctx context.Context, profileID int64) (*models.UserProfile, error) {
	p := &models.UserProfile{}
	err := q.pool.QueryRow(ctx, `
		SELECT id, user_id, name, COALESCE(avatar_url, ''), is_default,
		       COALESCE(max_age_rating, ''), COALESCE(language, ''), COALESCE(subtitle_lang, ''),
		       COALESCE(subtitle_mode, ''), created_at, updated_at, taste_onboarding_completed,
		       maturity_pref, (pin_hash IS NOT NULL)
		FROM user_profiles WHERE id = $1`, profileID).
		Scan(&p.ID, &p.UserID, &p.Name, &p.AvatarURL, &p.IsDefault,
			&p.MaxAgeRating, &p.Language, &p.SubtitleLang, &p.SubtitleMode,
			&p.CreatedAt, &p.UpdatedAt, &p.TasteOnboardingCompleted, &p.MaturityPref, &p.HasPIN)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	return p, nil
}

func (q *Queries) GetDefaultProfile(ctx context.Context, userID int64) (*models.UserProfile, error) {
	p := &models.UserProfile{}
	err := q.pool.QueryRow(ctx, `
		SELECT id, user_id, name, COALESCE(avatar_url, ''), is_default,
		       COALESCE(max_age_rating, ''), COALESCE(language, ''), COALESCE(subtitle_lang, ''),
		       COALESCE(subtitle_mode, ''), created_at, updated_at, taste_onboarding_completed,
		       maturity_pref, (pin_hash IS NOT NULL)
		FROM user_profiles WHERE user_id = $1 AND is_default = TRUE`, userID).
		Scan(&p.ID, &p.UserID, &p.Name, &p.AvatarURL, &p.IsDefault,
			&p.MaxAgeRating, &p.Language, &p.SubtitleLang, &p.SubtitleMode,
			&p.CreatedAt, &p.UpdatedAt, &p.TasteOnboardingCompleted, &p.MaturityPref, &p.HasPIN)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	return p, nil
}

// ResolveActingProfile returns the sub-profile currently bound to
// refreshTokenID (set via ProfileHandler.ActivateProfile), falling back to
// the account's default profile when there's no binding — refreshTokenID is
// 0 (a cast-scoped token, or an access token minted before this feature
// shipped), the bound profile was deleted, or it no longer belongs to
// userID. This is issue #462's fix: it is the ONLY place read/playback
// (and now discovery) rating-ceiling enforcement should get an acting
// profile from — never a client-supplied profile_id/max_rating, which was
// a full bypass (the ceiling was entirely client-elective).
//
// Deliberately does NOT filter the refresh_tokens lookup on `NOT revoked`:
// Refresh() rotates the row (revoking the old one) on every renewal, but the
// OLD access token stays valid — and gets presented — for up to its own
// 15-minute TTL afterward. Filtering on revoked would make that token's
// requests silently fall through to the account default (typically
// unrestricted) for the rest of its lifetime, undermining the enforcement
// this function exists for. Ownership (`user_id = $2`) is still checked.
//
// Contract: whenever err == nil, the returned profile is NEVER nil — on the
// documented (and real: see phase2_handlers.go's ProgressHandler comment)
// edge case where an account has no default profile row yet, a synthetic
// unrestricted profile is returned rather than nil, so every caller can
// dereference the result without a separate nil check. This matches the
// existing "prof == nil means unrestricted" convention in
// party_invite_handlers.go's send-time ceiling check.
//
// A token that names a session row which no longer exists resolves to the
// account's MOST restrictive profile, not the default. Its binding is
// unknowable, and the default is usually the unrestricted parent: the purge
// used to delete revoked rows while their access tokens were still valid, and
// a kid's stale token then lifted its own ceiling. PurgeExpiredTokens now keeps
// revoked rows past the access-token lifetime, so this is the backstop.
func (q *Queries) ResolveActingProfile(ctx context.Context, userID, refreshTokenID int64) (*models.UserProfile, error) {
	if refreshTokenID != 0 {
		var profileID *int64
		err := q.pool.QueryRow(ctx,
			`SELECT active_profile_id FROM refresh_tokens WHERE id = $1 AND user_id = $2`,
			refreshTokenID, userID,
		).Scan(&profileID)
		if err == pgx.ErrNoRows {
			return q.mostRestrictiveProfile(ctx, userID)
		}
		if err != nil {
			return nil, fmt.Errorf("resolve acting profile: %w", err)
		}
		if profileID != nil {
			p, err := q.GetProfile(ctx, *profileID)
			if err != nil {
				return nil, err
			}
			if p != nil && p.UserID == userID {
				return p, nil
			}
		}
	}
	p, err := q.GetDefaultProfile(ctx, userID)
	if err != nil {
		return nil, err
	}
	if p == nil {
		return &models.UserProfile{UserID: userID}, nil
	}
	return p, nil
}

// mostRestrictiveProfile returns the account's profile with the tightest
// ceiling (the fewest allowed ratings), or its default when none has one.
func (q *Queries) mostRestrictiveProfile(ctx context.Context, userID int64) (*models.UserProfile, error) {
	profiles, err := q.GetProfilesByUser(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("resolve acting profile: %w", err)
	}
	var tightest *models.UserProfile
	for _, p := range profiles {
		allowed := AllowedRatingsForMax(p.MaxAgeRating)
		if allowed == nil {
			continue
		}
		if tightest == nil || len(allowed) < len(AllowedRatingsForMax(tightest.MaxAgeRating)) {
			tightest = p
		}
	}
	if tightest != nil {
		return tightest, nil
	}
	p, err := q.GetDefaultProfile(ctx, userID)
	if err != nil {
		return nil, err
	}
	if p == nil {
		return &models.UserProfile{UserID: userID}, nil
	}
	return p, nil
}

// SetActiveProfileForToken binds profileID as the acting sub-profile for the
// session identified by refreshTokenID (issue #462). Returns false if no
// matching row exists for userID at all — the caller has already validated
// profileID ownership separately, so this only fails when the row was never
// created for this account (or a forged/foreign id).
//
// A revoked row is refused (false). Rotation copies the binding to the row's
// successor when it revokes it, so writing to the revoked row after that
// changed only what an old access token saw: the client was told the switch
// took while the session itself kept the previous profile. The caller answers
// 409, and the clients, which now show a switch only once the server confirms
// it, refresh and retry. (This filter used to be left off on purpose, because
// the web client activated fire-and-forget and swallowed the 409.)
func (q *Queries) SetActiveProfileForToken(ctx context.Context, refreshTokenID, userID, profileID int64) (bool, error) {
	tag, err := q.pool.Exec(ctx,
		`UPDATE refresh_tokens SET active_profile_id = $1
		 WHERE id = $2 AND user_id = $3 AND NOT revoked`,
		profileID, refreshTokenID, userID,
	)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

func (q *Queries) UpdateProfile(ctx context.Context, profileID int64, req *models.UpdateProfileRequest) error {
	setClauses := []string{}
	args := []interface{}{}
	idx := 1

	addField := func(col string, val interface{}) {
		setClauses = append(setClauses, fmt.Sprintf("%s = $%d", col, idx))
		args = append(args, val)
		idx++
	}

	if req.Name != nil {
		addField("name", *req.Name)
	}
	if req.AvatarURL != nil {
		addField("avatar_url", *req.AvatarURL)
	}
	if req.MaxAgeRating != nil {
		addField("max_age_rating", nilIfEmpty(*req.MaxAgeRating))
	}
	if req.Language != nil {
		addField("language", *req.Language)
	}
	if req.SubtitleLang != nil {
		addField("subtitle_lang", nilIfEmpty(*req.SubtitleLang))
	}
	if req.SubtitleMode != nil {
		addField("subtitle_mode", *req.SubtitleMode)
	}
	if req.MaturityPref != nil {
		v := *req.MaturityPref
		if v < -1 || v > 2 {
			v = -1 // out of range → off
		}
		addField("maturity_pref", v)
	}

	if len(setClauses) == 0 {
		return nil
	}

	// Always bump the updated_at timestamp
	setClauses = append(setClauses, "updated_at = NOW()")

	query := fmt.Sprintf("UPDATE user_profiles SET %s WHERE id = $%d",
		strings.Join(setClauses, ", "), idx)
	args = append(args, profileID)

	_, err := q.pool.Exec(ctx, query, args...)
	return err
}

// DeleteProfile deletes a non-default profile. Every session bound to it goes
// with it: the binding's foreign key cascades (migration 062). It used to be
// ON DELETE SET NULL, and an unbound session acts as the account default, so
// a kid's devices woke up on the parent's profile, past its PIN. Deleting the
// session rows (not just unbinding them) means a still-valid access token of
// theirs finds no row, which resolves to the most restrictive profile; the
// devices sign in again.
func (q *Queries) DeleteProfile(ctx context.Context, profileID int64) (bool, error) {
	tag, err := q.pool.Exec(ctx,
		"DELETE FROM user_profiles WHERE id = $1 AND is_default = FALSE", profileID)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

func (q *Queries) SetDefaultProfile(ctx context.Context, userID, profileID int64) error {
	tx, err := q.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	_, err = tx.Exec(ctx,
		"UPDATE user_profiles SET is_default = FALSE WHERE user_id = $1 AND is_default = TRUE", userID)
	if err != nil {
		return err
	}

	_, err = tx.Exec(ctx,
		"UPDATE user_profiles SET is_default = TRUE WHERE id = $1 AND user_id = $2", profileID, userID)
	if err != nil {
		return err
	}

	return tx.Commit(ctx)
}

func (q *Queries) CreateDefaultProfileForUser(ctx context.Context, userID int64, name string) (*models.UserProfile, error) {
	p := &models.UserProfile{
		UserID:       userID,
		Name:         name,
		IsDefault:    true,
		Language:     "en",
		SubtitleMode: "off",
	}
	if err := q.CreateProfile(ctx, p); err != nil {
		return nil, err
	}
	return p, nil
}

func (q *Queries) CountProfilesByUser(ctx context.Context, userID int64) (int, error) {
	var count int
	err := q.pool.QueryRow(ctx,
		"SELECT COUNT(*) FROM user_profiles WHERE user_id = $1", userID).Scan(&count)
	return count, err
}

// ============================================================
// Watchlists
// ============================================================

func (q *Queries) CreateWatchlist(ctx context.Context, wl *models.Watchlist) error {
	if wl.ListType == "" {
		wl.ListType = "custom"
	}
	return q.pool.QueryRow(ctx, `
		INSERT INTO watchlists (profile_id, name, list_type)
		VALUES ($1, $2, $3)
		RETURNING id, created_at, updated_at`,
		wl.ProfileID, wl.Name, wl.ListType,
	).Scan(&wl.ID, &wl.CreatedAt, &wl.UpdatedAt)
}

func (q *Queries) GetWatchlistsByProfile(ctx context.Context, profileID int64) ([]*models.Watchlist, error) {
	rows, err := q.pool.Query(ctx, `
		SELECT w.id, w.profile_id, w.name, w.list_type,
		       (SELECT COUNT(*) FROM watchlist_items wi WHERE wi.watchlist_id = w.id),
		       w.created_at, w.updated_at
		FROM watchlists w WHERE w.profile_id = $1
		ORDER BY w.name`, profileID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var lists []*models.Watchlist
	for rows.Next() {
		wl := &models.Watchlist{}
		if err := rows.Scan(&wl.ID, &wl.ProfileID, &wl.Name, &wl.ListType,
			&wl.ItemCount, &wl.CreatedAt, &wl.UpdatedAt); err != nil {
			return nil, err
		}
		lists = append(lists, wl)
	}
	return lists, rows.Err()
}

func (q *Queries) GetWatchlist(ctx context.Context, watchlistID int64) (*models.Watchlist, error) {
	wl := &models.Watchlist{}
	err := q.pool.QueryRow(ctx, `
		SELECT w.id, w.profile_id, w.name, w.list_type,
		       (SELECT COUNT(*) FROM watchlist_items wi WHERE wi.watchlist_id = w.id),
		       w.created_at, w.updated_at
		FROM watchlists w WHERE w.id = $1`, watchlistID).
		Scan(&wl.ID, &wl.ProfileID, &wl.Name, &wl.ListType,
			&wl.ItemCount, &wl.CreatedAt, &wl.UpdatedAt)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	return wl, nil
}

func (q *Queries) DeleteWatchlist(ctx context.Context, watchlistID int64) (bool, error) {
	tag, err := q.pool.Exec(ctx, "DELETE FROM watchlists WHERE id = $1", watchlistID)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

func (q *Queries) AddToWatchlist(ctx context.Context, watchlistID, mediaItemID int64) error {
	_, err := q.pool.Exec(ctx, `
		INSERT INTO watchlist_items (watchlist_id, media_item_id, sort_order)
		VALUES ($1, $2, COALESCE((SELECT MAX(sort_order)+1 FROM watchlist_items WHERE watchlist_id = $1), 0))
		ON CONFLICT (watchlist_id, media_item_id) DO NOTHING`,
		watchlistID, mediaItemID)
	return err
}

func (q *Queries) RemoveFromWatchlist(ctx context.Context, watchlistID, itemID int64) (bool, error) {
	tag, err := q.pool.Exec(ctx,
		"DELETE FROM watchlist_items WHERE watchlist_id = $1 AND id = $2", watchlistID, itemID)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

// RemoveFromWatchlistByMedia deletes an item by its media_item_id (rather than
// the watchlist_item row id). This is what a save/unsave TOGGLE needs — the UI
// knows the media it's un-saving, not the join-row id — and it means an add
// followed by a remove in the same session doesn't require refetching the row
// id first.
func (q *Queries) RemoveFromWatchlistByMedia(ctx context.Context, watchlistID, mediaItemID int64) (bool, error) {
	tag, err := q.pool.Exec(ctx,
		"DELETE FROM watchlist_items WHERE watchlist_id = $1 AND media_item_id = $2", watchlistID, mediaItemID)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

// libraryWatchlistName is the reserved name of the per-profile "My Library"
// list that backs the + save button. Using a reserved name (not a schema
// flag) reuses the existing UNIQUE(profile_id, name) constraint for
// race-safe get-or-create, so no migration is needed.
const libraryWatchlistName = "My Library"

// GetOrCreateLibraryWatchlist returns the profile's reserved "My Library"
// watchlist, creating it on first use.
//
// list_type is 'custom', NOT 'favorites': the 'favorites' type is owned by the
// taste-onboarding list (GetOrCreateFavoritesWatchlist selects
// `list_type='favorites' ORDER BY id LIMIT 1`), so a favorites-typed library
// created before onboarding would be picked up as the onboarding list and get
// the recommender seeds mixed into it.
//
// Read-first so the steady-state path (every GetLibrary) performs no write.
// Matched by the reserved NAME; the UNIQUE(profile_id, name) constraint makes
// the create race-safe (concurrent first-saves converge on one row). If the
// profile already has a same-named list from the right-click "Add to
// Watchlist…" flow, that list is adopted.
func (q *Queries) GetOrCreateLibraryWatchlist(ctx context.Context, profileID int64) (*models.Watchlist, error) {
	const sel = `SELECT id, profile_id, name, list_type, created_at, updated_at
		FROM watchlists WHERE profile_id = $1 AND name = $2`

	wl := &models.Watchlist{}
	err := q.pool.QueryRow(ctx, sel, profileID, libraryWatchlistName).
		Scan(&wl.ID, &wl.ProfileID, &wl.Name, &wl.ListType, &wl.CreatedAt, &wl.UpdatedAt)
	if err == nil {
		return wl, nil
	}
	if err != pgx.ErrNoRows {
		return nil, fmt.Errorf("find library watchlist: %w", err)
	}

	err = q.pool.QueryRow(ctx, `
		INSERT INTO watchlists (profile_id, name, list_type)
		VALUES ($1, $2, 'custom')
		ON CONFLICT (profile_id, name) DO NOTHING
		RETURNING id, profile_id, name, list_type, created_at, updated_at`,
		profileID, libraryWatchlistName,
	).Scan(&wl.ID, &wl.ProfileID, &wl.Name, &wl.ListType, &wl.CreatedAt, &wl.UpdatedAt)
	if err == nil {
		return wl, nil
	}
	if err != pgx.ErrNoRows {
		return nil, fmt.Errorf("create library watchlist: %w", err)
	}

	// Lost the insert race — a concurrent call created it. Re-read.
	err = q.pool.QueryRow(ctx, sel, profileID, libraryWatchlistName).
		Scan(&wl.ID, &wl.ProfileID, &wl.Name, &wl.ListType, &wl.CreatedAt, &wl.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("reread library watchlist: %w", err)
	}
	return wl, nil
}

// GetAllWatchlistItems returns every item in a watchlist (no pagination),
// newest-saved first. Used by the library sync, where the client needs the
// full authoritative set to reconcile against its local cache. Bounded by the
// user's own save count.
func (q *Queries) GetAllWatchlistItems(ctx context.Context, watchlistID int64) ([]*models.WatchlistItem, error) {
	rows, err := q.pool.Query(ctx, `
		SELECT wi.id, wi.watchlist_id, wi.media_item_id, wi.added_at, wi.sort_order,
		       mi.title, COALESCE(mi.poster_path, ''), COALESCE(mi.year, 0), mi.type
		FROM watchlist_items wi
		JOIN media_items mi ON mi.id = wi.media_item_id
		WHERE wi.watchlist_id = $1
		ORDER BY wi.added_at DESC`, watchlistID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := []*models.WatchlistItem{}
	for rows.Next() {
		item := &models.WatchlistItem{}
		if err := rows.Scan(&item.ID, &item.WatchlistID, &item.MediaItemID, &item.AddedAt,
			&item.SortOrder, &item.Title, &item.PosterPath, &item.Year, &item.Type); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (q *Queries) GetWatchlistItems(ctx context.Context, watchlistID int64, params models.PaginationParams) ([]*models.WatchlistItem, int64, error) {
	var total int64
	err := q.pool.QueryRow(ctx,
		"SELECT COUNT(*) FROM watchlist_items WHERE watchlist_id = $1", watchlistID).Scan(&total)
	if err != nil {
		return nil, 0, err
	}

	offset := (params.Page - 1) * params.PerPage
	rows, err := q.pool.Query(ctx, `
		SELECT wi.id, wi.watchlist_id, wi.media_item_id, wi.added_at, wi.sort_order,
		       mi.title, COALESCE(mi.poster_path, ''), COALESCE(mi.year, 0), mi.type
		FROM watchlist_items wi
		JOIN media_items mi ON mi.id = wi.media_item_id
		WHERE wi.watchlist_id = $1
		ORDER BY wi.sort_order, wi.added_at DESC
		LIMIT $2 OFFSET $3`, watchlistID, params.PerPage, offset)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	var items []*models.WatchlistItem
	for rows.Next() {
		item := &models.WatchlistItem{}
		if err := rows.Scan(&item.ID, &item.WatchlistID, &item.MediaItemID, &item.AddedAt,
			&item.SortOrder, &item.Title, &item.PosterPath, &item.Year, &item.Type); err != nil {
			return nil, 0, err
		}
		items = append(items, item)
	}
	return items, total, rows.Err()
}

// ============================================================
// Activity Log
// ============================================================

func (q *Queries) InsertActivity(ctx context.Context, entry *models.ActivityEntry) error {
	var detailsJSON []byte
	if entry.Details != nil {
		var err error
		detailsJSON, err = json.Marshal(entry.Details)
		if err != nil {
			return err
		}
	}

	var ipAddr interface{}
	if entry.IPAddress != "" {
		ipAddr = entry.IPAddress
	}

	return q.pool.QueryRow(ctx, `
		INSERT INTO activity_log (user_id, profile_id, event_type, details, ip_address)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id, created_at`,
		entry.UserID, entry.ProfileID, entry.EventType, detailsJSON, ipAddr,
	).Scan(&entry.ID, &entry.CreatedAt)
}

func (q *Queries) GetRecentActivity(ctx context.Context, limit int, eventType string) ([]*models.ActivityEntry, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}

	query := `
		SELECT al.id, al.user_id, al.profile_id, al.event_type, al.details,
		       COALESCE(host(al.ip_address), ''), al.created_at, COALESCE(u.username, '')
		FROM activity_log al
		LEFT JOIN users u ON u.id = al.user_id`

	args := []interface{}{}
	idx := 1

	if eventType != "" {
		query += fmt.Sprintf(" WHERE al.event_type = $%d", idx)
		args = append(args, eventType)
		idx++
	}

	query += fmt.Sprintf(" ORDER BY al.created_at DESC LIMIT $%d", idx)
	args = append(args, limit)

	rows, err := q.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	return scanActivityRows(rows)
}

func (q *Queries) GetActivityPaginated(ctx context.Context, params models.PaginationParams, eventType string) ([]*models.ActivityEntry, int64, error) {
	countQuery := "SELECT COUNT(*) FROM activity_log"
	countArgs := []interface{}{}
	if eventType != "" {
		countQuery += " WHERE event_type = $1"
		countArgs = append(countArgs, eventType)
	}

	var total int64
	if err := q.pool.QueryRow(ctx, countQuery, countArgs...).Scan(&total); err != nil {
		return nil, 0, err
	}

	offset := (params.Page - 1) * params.PerPage
	query := `
		SELECT al.id, al.user_id, al.profile_id, al.event_type, al.details,
		       COALESCE(host(al.ip_address), ''), al.created_at, COALESCE(u.username, '')
		FROM activity_log al
		LEFT JOIN users u ON u.id = al.user_id`

	args := []interface{}{}
	idx := 1

	if eventType != "" {
		query += fmt.Sprintf(" WHERE al.event_type = $%d", idx)
		args = append(args, eventType)
		idx++
	}

	query += fmt.Sprintf(" ORDER BY al.created_at DESC LIMIT $%d OFFSET $%d", idx, idx+1)
	args = append(args, params.PerPage, offset)

	rows, err := q.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	entries, err := scanActivityRows(rows)
	return entries, total, err
}

// GetActivityEventTypes returns every distinct event_type currently present
// in activity_log with its row count, ordered alphabetically so an option
// keeps a stable position in the admin filter as counts move around.
//
// Grouping over the whole table is affordable here: activity_log is bounded
// by the 90-day retention sweep and event_type is indexed
// (idx_activity_log_type), so this is an index-only scan.
func (q *Queries) GetActivityEventTypes(ctx context.Context) ([]*models.ActivityEventType, error) {
	rows, err := q.pool.Query(ctx, `
		SELECT event_type, COUNT(*)
		FROM activity_log
		GROUP BY event_type
		ORDER BY event_type ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var types []*models.ActivityEventType
	for rows.Next() {
		t := &models.ActivityEventType{}
		if err := rows.Scan(&t.EventType, &t.Count); err != nil {
			return nil, err
		}
		types = append(types, t)
	}
	return types, rows.Err()
}

func scanActivityRows(rows pgx.Rows) ([]*models.ActivityEntry, error) {
	var entries []*models.ActivityEntry
	for rows.Next() {
		e := &models.ActivityEntry{}
		var detailsJSON []byte
		if err := rows.Scan(&e.ID, &e.UserID, &e.ProfileID, &e.EventType, &detailsJSON,
			&e.IPAddress, &e.CreatedAt, &e.Username); err != nil {
			return nil, err
		}
		if detailsJSON != nil {
			_ = json.Unmarshal(detailsJSON, &e.Details)
		}
		entries = append(entries, e)
	}
	return entries, rows.Err()
}

func (q *Queries) PurgeOldActivity(ctx context.Context, olderThan time.Duration) (int64, error) {
	cutoff := time.Now().Add(-olderThan)
	tag, err := q.pool.Exec(ctx,
		"DELETE FROM activity_log WHERE created_at < $1", cutoff)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// ============================================================
// Server Settings
// ============================================================

func (q *Queries) GetSetting(ctx context.Context, key string) (string, error) {
	var value string
	err := q.pool.QueryRow(ctx,
		"SELECT value FROM server_settings WHERE key = $1", key).Scan(&value)
	if err != nil {
		if err == pgx.ErrNoRows {
			return "", nil
		}
		return "", err
	}
	return value, nil
}

func (q *Queries) GetAllSettings(ctx context.Context) ([]*models.ServerSetting, error) {
	rows, err := q.pool.Query(ctx,
		"SELECT key, value, updated_at, updated_by FROM server_settings ORDER BY key")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var settings []*models.ServerSetting
	for rows.Next() {
		s := &models.ServerSetting{}
		if err := rows.Scan(&s.Key, &s.Value, &s.UpdatedAt, &s.UpdatedBy); err != nil {
			return nil, err
		}
		settings = append(settings, s)
	}
	return settings, rows.Err()
}

// UpsertSetting writes (key, value, updated_by). server_settings.updated_by
// has a FK to users(id), and the convention in this codebase is to pass 0
// for "no user / system write" (the Go zero value). NULLIF($3, 0)::bigint
// translates that sentinel to SQL NULL so the FK accepts it — without this,
// any UpdateLLMSettings call (which routes through SetSetting → updatedBy=0)
// would 500 with "insert or update on table server_settings violates foreign
// key constraint".
//
// Identity columns start at 1 in PostgreSQL, so user_id=0 can never refer
// to a real user — the NULLIF is unambiguous and only fires on the sentinel.
func (q *Queries) UpsertSetting(ctx context.Context, key, value string, updatedBy int64) error {
	_, err := q.pool.Exec(ctx, `
		INSERT INTO server_settings (key, value, updated_by)
		VALUES ($1, $2, NULLIF($3, 0)::bigint)
		ON CONFLICT (key) DO UPDATE SET
			value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
		key, value, updatedBy)
	return err
}

// SetSetting is a thin convenience wrapper used by handlers that don't have
// (or don't care about) the requesting user's ID. It writes updated_by=NULL
// via UpsertSetting's NULLIF translation — the row exists, but with no actor
// attribution. Audit/activity attribution lives in a separate table; that
// layer is what the UI surfaces for "who changed this".
func (q *Queries) SetSetting(ctx context.Context, key, value string) error {
	return q.UpsertSetting(ctx, key, value, 0)
}

// InsertSettingIfAbsent writes a setting only when no row exists — the
// racing-first-writer-wins primitive VAPID key provisioning needs (see the
// atomic VAPID-setting contract in docs/push.md). UpsertSetting is last-write-wins by
// design, which is correct for admin edits and exactly wrong for a
// generated keypair: two racing generators upserting would leave clients
// holding a public key whose private half was clobbered. With DO NOTHING,
// both racers converge by re-reading whichever single value won.
func (q *Queries) InsertSettingIfAbsent(ctx context.Context, key, value string) error {
	_, err := q.pool.Exec(ctx, `
		INSERT INTO server_settings (key, value, updated_by)
		VALUES ($1, $2, NULL)
		ON CONFLICT (key) DO NOTHING`,
		key, value)
	return err
}

// GetSettingExists is the three-state read: returns (value, exists, err).
// "exists=true with value=”" means the operator explicitly cleared the
// setting in the UI (an intentional override), distinct from "exists=false"
// meaning the row was never written and the env/default should apply.
// This precedence matters for boot-time config: applyLLMOverrides treats
// an explicit empty-string DB value as "user wants none here", not "fall
// back to env."
func (q *Queries) GetSettingExists(ctx context.Context, key string) (string, bool, error) {
	var value string
	err := q.pool.QueryRow(ctx,
		"SELECT value FROM server_settings WHERE key = $1", key).Scan(&value)
	if err != nil {
		if err == pgx.ErrNoRows {
			return "", false, nil
		}
		return "", false, err
	}
	return value, true, nil
}

// ============================================================
// Stats Queries (for Admin Dashboard)
// ============================================================

func (q *Queries) GetMediaCounts(ctx context.Context) (movieCount, showCount, episodeCount int64, err error) {
	err = q.pool.QueryRow(ctx, `
		SELECT
			COUNT(*) FILTER (WHERE type = 'movie'),
			COUNT(*) FILTER (WHERE type = 'show'),
			(SELECT COUNT(*) FROM tv_episodes)
		FROM media_items`).Scan(&movieCount, &showCount, &episodeCount)
	return
}

func (q *Queries) GetTotalFileSize(ctx context.Context) (int64, error) {
	var total int64
	err := q.pool.QueryRow(ctx, `
		SELECT COALESCE(
			(SELECT SUM(size_bytes) FROM media_files), 0
		) + COALESCE(
			(SELECT SUM(size_bytes) FROM episode_files), 0
		)`).Scan(&total)
	return total, err
}

func (q *Queries) GetLibraryCount(ctx context.Context) (int, error) {
	var count int
	err := q.pool.QueryRow(ctx, "SELECT COUNT(*) FROM libraries").Scan(&count)
	return count, err
}

// ============================================================
// Watch Progress Extensions
// ============================================================

func (q *Queries) DeleteWatchProgress(ctx context.Context, userID, mediaItemID int64, episodeID *int64) error {
	if episodeID != nil {
		_, err := q.pool.Exec(ctx,
			"DELETE FROM watch_progress WHERE user_id = $1 AND episode_id = $2 AND profile_id = (SELECT id FROM user_profiles WHERE user_id = $1 AND is_default = TRUE LIMIT 1)",
			userID, *episodeID)
		return err
	}
	_, err := q.pool.Exec(ctx,
		"DELETE FROM watch_progress WHERE user_id = $1 AND media_item_id = $2 AND episode_id IS NULL AND profile_id = (SELECT id FROM user_profiles WHERE user_id = $1 AND is_default = TRUE LIMIT 1)",
		userID, mediaItemID)
	return err
}

// DeleteWatchProgressForProfile clears only the selected profile's row. The
// handler validates ownership; user_id remains in the predicate as defense in
// depth. Keep the default-profile wrapper for legacy internal callers.
func (q *Queries) DeleteWatchProgressForProfile(ctx context.Context, userID, profileID, mediaItemID int64, episodeID *int64) error {
	_, err := q.pool.Exec(ctx,
		`DELETE FROM watch_progress WHERE user_id = $1 AND profile_id = $2
		 AND media_item_id = $3 AND episode_id IS NOT DISTINCT FROM $4`,
		userID, profileID, mediaItemID, episodeID)
	return err
}

func (q *Queries) GetRecentlyWatched(ctx context.Context, userID int64, limit int) ([]models.ContinueWatchingItem, error) {
	if limit <= 0 || limit > 50 {
		limit = 20
	}

	rows, err := q.pool.Query(ctx, `
		SELECT wp.id, wp.user_id, COALESCE(wp.profile_id, 0), wp.media_item_id, wp.episode_id,
		       wp.position_ms, wp.duration_ms, wp.completed, wp.updated_at,
		       mi.title, COALESCE(mi.poster_path, ''), COALESCE(mi.backdrop_path, ''), mi.type,
		       COALESCE(mi.year, 0),
		       COALESCE(mi.rating, 0),
		       COALESCE(e.title, ''),
		       s.season_number, e.episode_number
		FROM watch_progress wp
		JOIN media_items mi ON mi.id = wp.media_item_id
		LEFT JOIN tv_episodes e ON e.id = wp.episode_id
		LEFT JOIN tv_seasons s ON s.id = e.season_id
		WHERE wp.user_id = $1
		ORDER BY wp.updated_at DESC
		LIMIT $2`, userID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	return scanContinueWatchingRows(rows)
}

func (q *Queries) GetWatchHistory(ctx context.Context, userID int64, params models.PaginationParams) ([]models.ContinueWatchingItem, int64, error) {
	var total int64
	err := q.pool.QueryRow(ctx,
		"SELECT COUNT(*) FROM watch_progress WHERE user_id = $1", userID).Scan(&total)
	if err != nil {
		return nil, 0, err
	}

	offset := (params.Page - 1) * params.PerPage
	rows, err := q.pool.Query(ctx, `
		SELECT wp.id, wp.user_id, COALESCE(wp.profile_id, 0), wp.media_item_id, wp.episode_id,
		       wp.position_ms, wp.duration_ms, wp.completed, wp.updated_at,
		       mi.title, COALESCE(mi.poster_path, ''), COALESCE(mi.backdrop_path, ''), mi.type,
		       COALESCE(mi.year, 0),
		       COALESCE(mi.rating, 0),
		       COALESCE(e.title, ''),
		       s.season_number, e.episode_number
		FROM watch_progress wp
		JOIN media_items mi ON mi.id = wp.media_item_id
		LEFT JOIN tv_episodes e ON e.id = wp.episode_id
		LEFT JOIN tv_seasons s ON s.id = e.season_id
		WHERE wp.user_id = $1
		ORDER BY wp.updated_at DESC
		LIMIT $2 OFFSET $3`, userID, params.PerPage, offset)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	items, err := scanContinueWatchingRows(rows)
	return items, total, err
}

func scanContinueWatchingRows(rows pgx.Rows) ([]models.ContinueWatchingItem, error) {
	var items []models.ContinueWatchingItem
	for rows.Next() {
		var c models.ContinueWatchingItem
		// Field order MUST match the SELECT list in GetContinueWatching
		// and GetContinueWatchingByProfile. QA BUG-007 added Rating
		// between Year and EpisodeTitle in both SELECTs and here.
		if err := rows.Scan(&c.ID, &c.UserID, &c.ProfileID, &c.MediaItemID, &c.EpisodeID,
			&c.PositionMs, &c.DurationMs, &c.Completed, &c.UpdatedAt,
			&c.Title, &c.PosterPath, &c.BackdropPath, &c.Type, &c.Year,
			&c.Rating,
			&c.EpisodeTitle, &c.SeasonNum, &c.EpisodeNum); err != nil {
			return nil, err
		}
		if c.DurationMs > 0 {
			c.Percent = float64(c.PositionMs) / float64(c.DurationMs) * 100
		}
		items = append(items, c)
	}
	return items, rows.Err()
}

// ============================================================
// Helpers
// ============================================================

func nilIfEmpty(s string) interface{} {
	if s == "" {
		return nil
	}
	return s
}
