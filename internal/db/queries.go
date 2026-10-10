package db

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/aurora-media/aurora/internal/models"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func marshalTracks(audio []models.AudioTrack, subtitle []models.SubtitleTrack) ([]byte, []byte) {
	aj, _ := json.Marshal(audio)
	sj, _ := json.Marshal(subtitle)
	if aj == nil {
		aj = []byte("[]")
	}
	if sj == nil {
		sj = []byte("[]")
	}
	return aj, sj
}

type Queries struct {
	pool *pgxpool.Pool

	// testHookInRetypeTxn, when non-nil, runs inside RetypeLibrary's transaction
	// between the recount and the DELETE. Nil in production; a FIELD rather than
	// a package variable so it is scoped to the Queries a test built, and so a
	// parallel test cannot see another's hook.
	//
	// It exists because the window it opens cannot be reached by racing: the
	// transaction holds FOR UPDATE on the library row, which blocks concurrent
	// INSERTs into that library, and the one writer it does NOT block — an UPDATE
	// flipping an existing row's type into the doomed set — has no production
	// caller to race against. Without a seam the RowsAffected guard is only ever
	// reached through the recount, which catches the same case first, so
	// deleting the guard left every package green.
	testHookInRetypeTxn func()

	// Pauses after identifying a refresh token's user but before taking its
	// lock. Scoped to this Queries instance and nil in production, so tests
	// can commit account revocation at that exact interleaving without races.
	testHookBeforeRefreshUserLock func()
}

func NewQueries(pool *pgxpool.Pool) *Queries {
	return &Queries{pool: pool}
}

// hashToken produces a hex-encoded SHA-256 of a raw token for safe storage.
func hashToken(raw string) string {
	h := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(h[:])
}

// ============================================================
// Users
// ============================================================

func (q *Queries) CreateUser(ctx context.Context, username, email, passwordHash string, role models.UserRole) (*models.User, error) {
	user := &models.User{}
	err := q.pool.QueryRow(ctx,
		`INSERT INTO users (username, email, password_hash, role)
		 VALUES ($1, $2, $3, $4)
		 RETURNING id, username, email, role, COALESCE(avatar_url, ''), created_at, updated_at`,
		username, email, passwordHash, role,
	).Scan(&user.ID, &user.Username, &user.Email, &user.Role, &user.AvatarURL, &user.CreatedAt, &user.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("create user: %w", err)
	}
	return user, nil
}

func (q *Queries) GetUserByUsername(ctx context.Context, username string) (*models.User, error) {
	user := &models.User{}
	// Case-insensitive lookup so "admin"/"Admin"/"ADMIN" all resolve to the
	// same row. Paired with migration 017's LOWER(username) unique index
	// which prevents registering homoglyphs of an existing username.
	//
	// Loads oauth_provider/oauth_subject (migration 020). Both are nullable;
	// scanned as *string. Used by the login handler to detect "OAuth-only
	// users" (empty password_hash + non-nil oauth_provider) and reject
	// password attempts against them.
	err := q.pool.QueryRow(ctx,
		`SELECT id, username, email, password_hash, role, COALESCE(avatar_url, ''),
			created_at, updated_at, token_version, oauth_provider, oauth_subject
		 FROM users WHERE LOWER(username) = LOWER($1)`,
		username,
	).Scan(&user.ID, &user.Username, &user.Email, &user.PasswordHash, &user.Role, &user.AvatarURL,
		&user.CreatedAt, &user.UpdatedAt, &user.TokenVersion, &user.OAuthProvider, &user.OAuthSubject)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("get user by username: %w", err)
	}
	return user, nil
}

func (q *Queries) GetUserByEmail(ctx context.Context, email string) (*models.User, error) {
	user := &models.User{}
	err := q.pool.QueryRow(ctx,
		`SELECT id, username, email, password_hash, role, COALESCE(avatar_url, ''),
			created_at, updated_at, token_version, oauth_provider, oauth_subject
		 FROM users WHERE LOWER(email) = LOWER($1)`,
		email,
	).Scan(&user.ID, &user.Username, &user.Email, &user.PasswordHash, &user.Role, &user.AvatarURL,
		&user.CreatedAt, &user.UpdatedAt, &user.TokenVersion, &user.OAuthProvider, &user.OAuthSubject)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("get user by email: %w", err)
	}
	return user, nil
}

func (q *Queries) GetUserByID(ctx context.Context, id int64) (*models.User, error) {
	user := &models.User{}
	err := q.pool.QueryRow(ctx,
		`SELECT id, username, email, password_hash, role, COALESCE(avatar_url, ''),
			created_at, updated_at, token_version, oauth_provider, oauth_subject
		 FROM users WHERE id = $1`,
		id,
	).Scan(&user.ID, &user.Username, &user.Email, &user.PasswordHash, &user.Role, &user.AvatarURL,
		&user.CreatedAt, &user.UpdatedAt, &user.TokenVersion, &user.OAuthProvider, &user.OAuthSubject)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("get user by id: %w", err)
	}
	return user, nil
}

// GetUserByOAuth resolves a (provider, subject) pair to a user. Returns
// nil if no user has linked that OAuth identity.
//
// Deprecated (migration 031): resolution now goes through
// GetUserByOAuthIdentity against the authoritative oauth_identities table,
// which supports multiple providers per user. This column-based lookup remains
// only for back-compat / rollback safety and is no longer on the OAuth login
// path. Do not add new callers.
func (q *Queries) GetUserByOAuth(ctx context.Context, provider, subject string) (*models.User, error) {
	user := &models.User{}
	err := q.pool.QueryRow(ctx,
		`SELECT id, username, email, password_hash, role, COALESCE(avatar_url, ''),
			created_at, updated_at, token_version, oauth_provider, oauth_subject
		 FROM users
		 WHERE oauth_provider = $1 AND oauth_subject = $2`,
		provider, subject,
	).Scan(&user.ID, &user.Username, &user.Email, &user.PasswordHash, &user.Role, &user.AvatarURL,
		&user.CreatedAt, &user.UpdatedAt, &user.TokenVersion, &user.OAuthProvider, &user.OAuthSubject)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("get user by oauth: %w", err)
	}
	return user, nil
}

// ErrOAuthIdentityConflict is returned by LinkOAuthToUser when the target user
// already has a DIFFERENT non-empty OAuth identity set. The single
// oauth_provider/oauth_subject column pair can hold exactly one identity, so we
// refuse to silently overwrite an existing one (e.g. a second provider, or a
// re-link to a different Google account, clobbering the first). The caller
// should surface this to the user rather than treating the link as successful.
var ErrOAuthIdentityConflict = errors.New("user already has a different oauth identity linked")

// LinkOAuthToUser writes (provider, subject) onto an existing user row,
// either because they signed in via OAuth using an email that matches
// their local account (auto-link) or because they explicitly linked via
// the settings UI. Returns error if the (provider, subject) pair would
// collide with another user — protected by idx_users_oauth_identity.
//
// MED audit fix: this used to blindly overwrite oauth_provider/oauth_subject.
// Because those are single-value columns, a second LinkOAuthToUser call (a
// different provider, or the same provider with a different subject) would
// silently clobber the first identity — breaking the original provider's
// fast-path sign-in (GetUserByOAuth) with no error surfaced. We now only write
// when the existing identity is empty OR already equals the incoming pair
// (idempotent re-link); otherwise we return ErrOAuthIdentityConflict.
//
// Deprecated (migration 031): the oauth_identities table + AddOAuthIdentity now
// provide the true multi-provider linking this function's header said was
// deferred. AddOAuthIdentity is the link write-path for both auto-link-by-email
// and explicit Settings linking. LinkOAuthToUser is retained only for
// back-compat / rollback safety and is no longer called on the OAuth flow. Do
// not add new callers.
func (q *Queries) LinkOAuthToUser(ctx context.Context, userID int64, provider, subject string) error {
	// Conditional UPDATE: only proceed if the row has no identity yet, or the
	// stored identity is exactly the one we're (re-)writing. The guard runs
	// atomically inside the single statement so two concurrent links can't both
	// pass a read-then-write check. The existing collision-with-another-user
	// case is still caught by idx_users_oauth_identity (unique violation flows
	// through the err path below).
	tag, err := q.pool.Exec(ctx,
		`UPDATE users SET oauth_provider = $1, oauth_subject = $2, updated_at = NOW()
		 WHERE id = $3
		   AND (
		     oauth_provider IS NULL OR oauth_provider = ''
		     OR (oauth_provider = $1 AND oauth_subject = $2)
		   )`,
		provider, subject, userID,
	)
	if err != nil {
		return fmt.Errorf("link oauth to user: %w", err)
	}
	if tag.RowsAffected() == 0 {
		// The guarded UPDATE matched nothing: either the user doesn't exist, or
		// they already have a different non-empty identity. Disambiguate so the
		// caller gets a precise error instead of a silent no-op success.
		var existingProvider, existingSubject *string
		qErr := q.pool.QueryRow(ctx,
			`SELECT oauth_provider, oauth_subject FROM users WHERE id = $1`, userID,
		).Scan(&existingProvider, &existingSubject)
		if qErr != nil {
			if qErr == pgx.ErrNoRows {
				return fmt.Errorf("link oauth to user: user %d not found", userID)
			}
			return fmt.Errorf("link oauth to user: %w", qErr)
		}
		return ErrOAuthIdentityConflict
	}
	return nil
}

// CreateOAuthUser creates a new user with an OAuth identity attached and
// NO local password (password_hash = empty string). The login flow gates
// against empty password_hash so these users can only authenticate via
// OAuth until they explicitly set a password via the change-password
// flow. Username/email come from the OAuth provider's profile claims.
//
// Role is always "user" for OAuth-created accounts — first-admin
// bootstrapping still requires the password-based register flow, so the
// operator chooses who admin is rather than the first random Google user
// to discover the OAuth callback.
//
// Deprecated (migration 031): the Tier-3 new-user path now uses
// CreateOAuthUserWithIdentity, which also inserts the authoritative
// oauth_identities row in the same transaction so a new OAuth user always has a
// table identity. This column-only insert is retained for back-compat /
// rollback safety. Do not add new callers.
func (q *Queries) CreateOAuthUser(ctx context.Context, username, email, avatarURL, provider, subject string) (*models.User, error) {
	user := &models.User{}
	err := q.pool.QueryRow(ctx,
		`INSERT INTO users (username, email, password_hash, role, avatar_url, oauth_provider, oauth_subject)
		 VALUES ($1, $2, '', 'user', $3, $4, $5)
		 RETURNING id, username, email, role, COALESCE(avatar_url, ''), created_at, updated_at, token_version,
			oauth_provider, oauth_subject`,
		username, email, avatarURL, provider, subject,
	).Scan(&user.ID, &user.Username, &user.Email, &user.Role, &user.AvatarURL,
		&user.CreatedAt, &user.UpdatedAt, &user.TokenVersion, &user.OAuthProvider, &user.OAuthSubject)
	if err != nil {
		return nil, fmt.Errorf("create oauth user: %w", err)
	}
	return user, nil
}

// GetUsernamesByIDs returns a map of id → username for the given user IDs in
// a single round-trip. Replaces a per-id loop of GetUserByID in admin views;
// for 50 unique users it drops 50 sequential queries to 1.
func (q *Queries) GetUsernamesByIDs(ctx context.Context, ids []int64) (map[int64]string, error) {
	out := make(map[int64]string, len(ids))
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := q.pool.Query(ctx,
		`SELECT id, username FROM users WHERE id = ANY($1)`, ids)
	if err != nil {
		return nil, fmt.Errorf("get usernames by ids: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var name string
		if err := rows.Scan(&id, &name); err != nil {
			return nil, err
		}
		out[id] = name
	}
	return out, rows.Err()
}

func (q *Queries) GetAllUsers(ctx context.Context) ([]*models.User, error) {
	rows, err := q.pool.Query(ctx,
		`SELECT id, username, email, role, COALESCE(avatar_url, ''), created_at, updated_at, last_login_at,
			oauth_provider, referral_status, referral_source, referral_detail, referral_answered_at
		 FROM users ORDER BY created_at ASC`)
	if err != nil {
		return nil, fmt.Errorf("get all users: %w", err)
	}
	defer rows.Close()

	var users []*models.User
	for rows.Next() {
		u := &models.User{}
		// last_login_at is nullable (migration 036); scanned into *time.Time so a
		// never-signed-in user stays nil → "Never" in the admin UI.
		//
		// oauth_provider was MISSING from this select while the admin table's
		// "Sign-in" column rendered it — so every user, including Google and
		// Discord signups, displayed as "password".
		//
		// Read it for what it is: a best-effort mirror of the user's PRIMARY
		// (first-linked) identity, per queries_oauth_identities.go. It is also
		// filled when a password user later links a provider, so it answers
		// "can sign in with" rather than "signed up via", and shows only the
		// first of several links. The referral columns beside it are the ones
		// that actually track signup path (migration 046), and a NULL
		// referral_status there means "never eligible", not "we forgot to ask".
		if err := rows.Scan(&u.ID, &u.Username, &u.Email, &u.Role, &u.AvatarURL, &u.CreatedAt, &u.UpdatedAt, &u.LastLoginAt,
			&u.OAuthProvider, &u.ReferralStatus, &u.ReferralSource, &u.ReferralDetail, &u.ReferralAnsweredAt); err != nil {
			return nil, fmt.Errorf("scan user: %w", err)
		}
		users = append(users, u)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate users: %w", err)
	}
	return users, nil
}

// UpdateLastLogin stamps a user's last_login_at to the DB clock (NOW(), matching
// the created_at/updated_at clock source). Called on every fresh authentication
// — password login, OAuth callback, and registration's immediate sign-in — but
// NOT on token refresh, which is a silent session continuation rather than a
// re-login. Callers treat this as best-effort: the session is already valid by
// the time it runs, so a write failure must not fail the login. Deliberately
// does not touch updated_at, which tracks account mutations, not sign-ins.
func (q *Queries) UpdateLastLogin(ctx context.Context, id int64) error {
	_, err := q.pool.Exec(ctx, `UPDATE users SET last_login_at = NOW() WHERE id = $1`, id)
	if err != nil {
		return fmt.Errorf("update last login: %w", err)
	}
	return nil
}

// DeleteUser removes a user row. All foreign-key references to users(id) in
// the schema use an explicit ON DELETE policy, so this single DELETE
// cascades correctly and never leaves orphan rows.
//
// CASCADE (data deleted with the user):
//
//	refresh_tokens, watch_progress, requests, profiles, libraries.owner_id,
//	user_preferences, invite_codes.created_by, watch_party hosts,
//	party_participants, user_follows (both directions — migration 050)
//
// SET NULL (data preserved, attribution cleared):
//
//	invite_codes.used_by, server_settings.updated_by, activity_log.user_id
//
// Audited 2026-05. If a new table is added that references users(id), it
// MUST declare an explicit ON DELETE policy and be added to this comment.
func (q *Queries) DeleteUser(ctx context.Context, id int64) (bool, error) {
	result, err := q.pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, id)
	if err != nil {
		return false, err
	}
	return result.RowsAffected() > 0, nil
}

// GetUserTokenVersion returns the current token_version for a user. Used by
// the auth middleware to validate access tokens against post-password-change
// invalidations. Cached in-memory; this is the slow-path on cache miss.
func (q *Queries) GetUserTokenVersion(ctx context.Context, id int64) (int, error) {
	var v int
	err := q.pool.QueryRow(ctx,
		`SELECT token_version FROM users WHERE id = $1`, id,
	).Scan(&v)
	if err != nil {
		if err == pgx.ErrNoRows {
			// User deleted. Return a sentinel no real token can carry so the
			// downstream version check FAILS CLOSED. token_version starts at 0
			// and only ever increments, so a JWT's claim is always >= 0 and can
			// never equal -1. The old behavior (return 0) made the check PASS
			// for any deleted user whose token_version was still the default 0
			// — i.e. a just-deleted account (including a deleted admin) kept
			// full API access until its access token expired. See audit H2.
			return -1, nil
		}
		return 0, fmt.Errorf("get user token_version: %w", err)
	}
	return v, nil
}

// BumpUserTokenVersion atomically increments token_version, immediately
// invalidating every access token previously issued for this user. Called
// from ChangePassword (and any future "log out everywhere" admin action).
// Returns the new version so the caller can also update its in-memory cache
// without an extra read.
func (q *Queries) BumpUserTokenVersion(ctx context.Context, id int64) (int, error) {
	var v int
	err := q.pool.QueryRow(ctx,
		`UPDATE users SET token_version = token_version + 1 WHERE id = $1
		 RETURNING token_version`, id,
	).Scan(&v)
	if err != nil {
		return 0, fmt.Errorf("bump user token_version: %w", err)
	}
	return v, nil
}

func (q *Queries) CountUsers(ctx context.Context) (int64, error) {
	var count int64
	err := q.pool.QueryRow(ctx, `SELECT COUNT(*) FROM users`).Scan(&count)
	return count, err
}

// CreateFirstAdmin atomically inserts a new admin user ONLY if the users table
// is empty. This prevents the TOCTOU race where two concurrent registrations
// both see CountUsers==0 and both become admin. Uses a CTE with a subquery
// guard so the INSERT is a no-op when users already exist.
// Returns (user, true, nil) on success, (nil, false, nil) when users already
// exist (the caller should fall back to the invite-code path), or
// (nil, false, err) on a real DB error.
func (q *Queries) CreateFirstAdmin(ctx context.Context, username, email, passwordHash string) (*models.User, bool, error) {
	user := &models.User{}
	err := q.pool.QueryRow(ctx,
		`INSERT INTO users (username, email, password_hash, role)
		 SELECT $1, $2, $3, 'admin'
		 WHERE NOT EXISTS (SELECT 1 FROM users)
		 RETURNING id, username, email, role, COALESCE(avatar_url, ''), created_at, updated_at`,
		username, email, passwordHash,
	).Scan(&user.ID, &user.Username, &user.Email, &user.Role, &user.AvatarURL, &user.CreatedAt, &user.UpdatedAt)
	if err != nil {
		if err == pgx.ErrNoRows {
			// Users already exist — someone else registered first
			return nil, false, nil
		}
		return nil, false, fmt.Errorf("create first admin: %w", err)
	}
	return user, true, nil
}

// ============================================================
// Refresh Tokens
// ============================================================

func (q *Queries) CreateRefreshToken(ctx context.Context, rt *models.RefreshToken) error {
	hashed := hashToken(rt.Token)
	return q.pool.QueryRow(ctx,
		`INSERT INTO refresh_tokens (user_id, token, expires_at, device_info, active_profile_id)
		 VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
		rt.UserID, hashed, rt.ExpiresAt, rt.DeviceInfo, rt.ActiveProfileID,
	).Scan(&rt.ID, &rt.CreatedAt)
}

// CreateRefreshTokenAtVersion fences a pending device grant against
// account-wide revocation. Both operations lock the user row first, so issuance
// either precedes revocation (and is revoked by it) or observes the new version.
func (q *Queries) CreateRefreshTokenAtVersion(ctx context.Context, rt *models.RefreshToken, expectedVersion int) (bool, error) {
	tx, err := q.pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	var version int
	if err := tx.QueryRow(ctx, `SELECT token_version FROM users WHERE id = $1 FOR UPDATE`, rt.UserID).Scan(&version); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return false, nil
		}
		return false, err
	}
	if version != expectedVersion {
		return false, nil
	}
	if err := tx.QueryRow(ctx,
		`INSERT INTO refresh_tokens (user_id, token, expires_at, device_info, active_profile_id)
		 VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
		rt.UserID, hashToken(rt.Token), rt.ExpiresAt, rt.DeviceInfo, rt.ActiveProfileID,
	).Scan(&rt.ID, &rt.CreatedAt); err != nil {
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	return true, nil
}

// RotateRefreshToken consumes and replaces a session under the same user lock
// as account-wide revocation. Capture the identity before committing: a later
// lookup could assign a post-revocation version to this pre-revocation session.
// Role changes deliberately retain refresh sessions, so they use the fresh role
// and version read under the lock. A missing/expired/consumed token returns nil.
func (q *Queries) RotateRefreshToken(ctx context.Context, token string, replacement *models.RefreshToken) (*models.User, error) {
	tx, err := q.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	hashed := hashToken(token)
	var userID int64
	// Identify the lock without taking a token-row lock first. Revocation locks
	// the user before its tokens; following that order avoids a deadlock.
	if err := tx.QueryRow(ctx, `SELECT user_id FROM refresh_tokens WHERE token = $1 AND NOT revoked AND expires_at > NOW()`, hashed).Scan(&userID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	if q.testHookBeforeRefreshUserLock != nil {
		q.testHookBeforeRefreshUserLock()
	}
	user := &models.User{}
	if err := tx.QueryRow(ctx,
		`SELECT id, username, email, password_hash, role, COALESCE(avatar_url, ''),
			created_at, updated_at, token_version, oauth_provider, oauth_subject
		 FROM users WHERE id = $1 FOR UPDATE`, userID,
	).Scan(&user.ID, &user.Username, &user.Email, &user.PasswordHash, &user.Role, &user.AvatarURL,
		&user.CreatedAt, &user.UpdatedAt, &user.TokenVersion, &user.OAuthProvider, &user.OAuthSubject); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	// Recheck after acquiring the user lock. A revocation or another rotation
	// may have retired the token while the initial lookup was still visible.
	if err := tx.QueryRow(ctx,
		`UPDATE refresh_tokens SET revoked = TRUE
		 WHERE token = $1 AND NOT revoked AND expires_at > clock_timestamp()
		 RETURNING active_profile_id`, hashed,
	).Scan(&replacement.ActiveProfileID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	replacement.UserID = user.ID
	if err := tx.QueryRow(ctx,
		`INSERT INTO refresh_tokens (user_id, token, expires_at, device_info, active_profile_id)
		 VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
		replacement.UserID, hashToken(replacement.Token), replacement.ExpiresAt, replacement.DeviceInfo, replacement.ActiveProfileID,
	).Scan(&replacement.ID, &replacement.CreatedAt); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return user, nil
}

// RevokeAllUserSessions changes the version and revokes renewable sessions in
// one transaction, using the same user-row lock as issuance and rotation.
func (q *Queries) RevokeAllUserSessions(ctx context.Context, userID int64) (int, error) {
	tx, err := q.pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	var version int
	if err := tx.QueryRow(ctx, `UPDATE users SET token_version = token_version + 1 WHERE id = $1 RETURNING token_version`, userID).Scan(&version); err != nil {
		return 0, err
	}
	if _, err := tx.Exec(ctx, `UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = $1`, userID); err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return version, nil
}

func (q *Queries) GetRefreshToken(ctx context.Context, token string) (*models.RefreshToken, error) {
	hashed := hashToken(token)
	rt := &models.RefreshToken{}
	err := q.pool.QueryRow(ctx,
		`SELECT id, user_id, token, expires_at, created_at, revoked, COALESCE(device_info, ''), active_profile_id
		 FROM refresh_tokens WHERE token = $1 AND NOT revoked AND expires_at > NOW()`,
		hashed,
	).Scan(&rt.ID, &rt.UserID, &rt.Token, &rt.ExpiresAt, &rt.CreatedAt, &rt.Revoked, &rt.DeviceInfo, &rt.ActiveProfileID)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("get refresh token: %w", err)
	}
	return rt, nil
}

func (q *Queries) RevokeRefreshToken(ctx context.Context, token string) error {
	hashed := hashToken(token)
	_, err := q.pool.Exec(ctx, `UPDATE refresh_tokens SET revoked = TRUE WHERE token = $1`, hashed)
	return err
}

// RevokeAndGetRefreshToken atomically revokes a refresh token and returns its data.
// Prevents TOCTOU race where two concurrent refresh requests both succeed.
func (q *Queries) RevokeAndGetRefreshToken(ctx context.Context, token string) (*models.RefreshToken, error) {
	hashed := hashToken(token)
	rt := &models.RefreshToken{}
	err := q.pool.QueryRow(ctx,
		`UPDATE refresh_tokens SET revoked = TRUE
		 WHERE token = $1 AND NOT revoked AND expires_at > NOW()
		 RETURNING id, user_id, token, expires_at, created_at, revoked, COALESCE(device_info, ''), active_profile_id`,
		hashed,
	).Scan(&rt.ID, &rt.UserID, &rt.Token, &rt.ExpiresAt, &rt.CreatedAt, &rt.Revoked, &rt.DeviceInfo, &rt.ActiveProfileID)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("revoke and get refresh token: %w", err)
	}
	return rt, nil
}

func (q *Queries) RevokeAllUserTokens(ctx context.Context, userID int64) error {
	_, err := q.pool.Exec(ctx, `UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = $1`, userID)
	return err
}

// PurgeExpiredTokens deletes tokens that are either revoked or expired.
// Should be called periodically (e.g. every hour) to keep the table bounded.
func (q *Queries) PurgeExpiredTokens(ctx context.Context) (int64, error) {
	result, err := q.pool.Exec(ctx, `DELETE FROM refresh_tokens WHERE revoked = TRUE OR expires_at < NOW()`)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected(), nil
}

// ============================================================
// Invite Codes
// ============================================================

func (q *Queries) CreateInviteCode(ctx context.Context, ic *models.InviteCode) error {
	return q.pool.QueryRow(ctx,
		`INSERT INTO invite_codes (code, created_by, expires_at)
		 VALUES ($1, $2, $3) RETURNING id, created_at`,
		ic.Code, ic.CreatedBy, ic.ExpiresAt,
	).Scan(&ic.ID, &ic.CreatedAt)
}

// ClaimInviteCode atomically claims an invite code by setting used_at to NOW(),
// preventing concurrent registrations from reusing it.
// The claim uses used_at (not used_by) as the lock because used_by has a FK
// constraint to users(id) — setting it to a sentinel like -1 violates the FK
// and silently fails the UPDATE.
// Returns the invite code's DB ID for later finalization or unclaiming.
func (q *Queries) ClaimInviteCode(ctx context.Context, code string) (int64, error) {
	var id int64
	err := q.pool.QueryRow(ctx,
		`UPDATE invite_codes SET used_at = NOW()
		 WHERE code = $1 AND used_by IS NULL AND used_at IS NULL AND expires_at > NOW()
		 RETURNING id`,
		code,
	).Scan(&id)
	if err != nil {
		// Log diagnostic info to help debug invite code failures.
		// Check if the code exists at all, and if so, why the claim failed.
		var diagID int64
		var usedBy *int64
		var usedAt *time.Time
		var expiresAt time.Time
		diagErr := q.pool.QueryRow(ctx,
			`SELECT id, used_by, used_at, expires_at FROM invite_codes WHERE code = $1`,
			code,
		).Scan(&diagID, &usedBy, &usedAt, &expiresAt)
		if diagErr != nil {
			// Do NOT log any portion of the code: it is a 16-char shared
			// secret, and a 4-char prefix is enough to meaningfully narrow a
			// brute-force of the remaining space. The code simply doesn't
			// exist here (no row, hence no invite_id to log); code_length is a
			// non-reversible signal that's sufficient for triage.
			slog.Warn("invite code claim failed: code not found in database",
				"code_length", len(code))
		} else if usedBy != nil {
			slog.Warn("invite code claim failed: already used",
				"invite_id", diagID,
				"used_by", *usedBy)
		} else if usedAt != nil {
			slog.Warn("invite code claim failed: already claimed (pending registration)",
				"invite_id", diagID)
		} else if !expiresAt.After(time.Now()) {
			slog.Warn("invite code claim failed: expired",
				"invite_id", diagID,
				"expires_at", expiresAt)
		} else {
			slog.Warn("invite code claim failed: unknown reason (possible race)",
				"invite_id", diagID)
		}
		return 0, fmt.Errorf("invite code already used or expired")
	}
	return id, nil
}

// FinalizeInviteCode sets the real user ID on a previously claimed invite code.
func (q *Queries) FinalizeInviteCode(ctx context.Context, inviteID, userID int64) error {
	// The predicates matter as much as the assignment. `used_at IS NOT NULL`
	// requires that THIS invite went through ClaimInviteCode (i.e. it is a
	// pending claim, not an untouched row someone named by id), and
	// `used_by IS NULL` requires that it has not already been spent by another
	// signup. Without them, finalizing an arbitrary id succeeded against any
	// existing invite row — including one already consumed by a different
	// user, which both let the uninvited signup through and silently
	// reassigned someone else's invite.
	//
	// Expiry is deliberately NOT re-checked here: ClaimInviteCode already
	// required `expires_at > NOW()` when it reserved the row, and an invite
	// that expires during the OAuth round-trip should still finalize for the
	// user who legitimately holds the claim.
	tag, err := q.pool.Exec(ctx,
		`UPDATE invite_codes
		    SET used_by = $1
		  WHERE id = $2
		    AND used_by IS NULL
		    AND used_at IS NOT NULL`,
		userID, inviteID,
	)
	if err != nil {
		return err
	}
	// A zero row count means the id names no pending claim. Reporting success
	// here let a bogus claim id walk an OAuth signup past the invite gate:
	// resolveOAuthUser's tier-3 check only asks whether inviteClaimID > 0, the
	// finalize then quietly matched nothing, and the rollback that exists for
	// exactly this case never fired. Erroring makes the caller roll the signup
	// back, which is the behavior that code was already written for.
	//
	// The claim id used to reach the callback in a client-writable cookie,
	// which is what made forging one trivial; it now comes from a server-side
	// transaction row. The predicates above and this error are the layer that
	// holds regardless of how the id arrived.
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("finalize invite code: claim %d is not a pending claim", inviteID)
	}
	return nil
}

// UnclaimInviteCode releases a PENDING invite claim so the code can be used
// again. It is the rollback half of ClaimInviteCode, called when the signup
// that reserved the code did not end up creating a user.
//
// `used_by IS NULL` is the load-bearing predicate: it scopes the release to
// claims that were never finalized. Without it, naming the id of an invite
// somebody had already redeemed reopened that invite for reuse — a consumed
// invite is not this flow's to release, and on an invite-only server handing
// one back is handing out an account.
//
// A no-op is not an error. The rollback runs on failure paths that may or may
// not have gotten as far as claiming anything, so "there was nothing pending to
// release" is a normal outcome.
func (q *Queries) UnclaimInviteCode(ctx context.Context, inviteID int64) error {
	_, err := q.pool.Exec(ctx,
		`UPDATE invite_codes
		    SET used_by = NULL, used_at = NULL
		  WHERE id = $1
		    AND used_by IS NULL`,
		inviteID,
	)
	return err
}

// ReleaseInviteCodeForUser rolls back a claim that was ALREADY finalized to
// userID, for the one caller that has to compensate past its own successful
// FinalizeInviteCode: register's rollbackUser, which deletes the new user when
// token issuance fails afterwards.
//
// UnclaimInviteCode cannot serve that case. Its `used_by IS NULL` predicate is
// what stops a spent invite being reopened, and by this point used_by is set —
// so it would no-op, and the subsequent DeleteUser would leave the row with
// used_by NULL'd by the FK but used_at still stamped, a state ClaimInviteCode
// (which requires used_at IS NULL) can never claim again. The invite would be
// destroyed rather than returned.
//
// Scoping the release to `used_by = $2` keeps the security property intact: a
// caller can only release an invite that this very user holds, never one
// somebody else redeemed. That is the ONLY row this may touch — matching an
// unclaimed row as well would make this a scope-free unclaim for any future
// caller that passes a stale id, which is exactly the shape being fixed here.
// UnclaimInviteCode is the right call for a not-yet-finalized claim.
func (q *Queries) ReleaseInviteCodeForUser(ctx context.Context, inviteID, userID int64) error {
	_, err := q.pool.Exec(ctx,
		`UPDATE invite_codes
		    SET used_by = NULL, used_at = NULL
		  WHERE id = $1
		    AND used_by = $2`,
		inviteID, userID,
	)
	return err
}

// ============================================================
// Libraries
// ============================================================

func (q *Queries) CreateLibrary(ctx context.Context, lib *models.Library) error {
	return q.pool.QueryRow(ctx,
		`INSERT INTO libraries (name, type, paths, scan_interval_min, owner_id)
		 VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at, updated_at`,
		lib.Name, lib.Type, lib.Paths, lib.ScanInterval, lib.OwnerID,
	).Scan(&lib.ID, &lib.CreatedAt, &lib.UpdatedAt)
}

func (q *Queries) GetLibraries(ctx context.Context) ([]*models.Library, error) {
	rows, err := q.pool.Query(ctx,
		`SELECT id, name, type, paths, scan_interval_min, owner_id, created_at, updated_at
		 FROM libraries ORDER BY name`)
	if err != nil {
		return nil, fmt.Errorf("get libraries: %w", err)
	}
	defer rows.Close()

	var libs []*models.Library
	for rows.Next() {
		l := &models.Library{}
		if err := rows.Scan(&l.ID, &l.Name, &l.Type, &l.Paths, &l.ScanInterval, &l.OwnerID, &l.CreatedAt, &l.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan library: %w", err)
		}
		libs = append(libs, l)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate libraries: %w", err)
	}
	return libs, nil
}

func (q *Queries) GetLibrary(ctx context.Context, id int64) (*models.Library, error) {
	l := &models.Library{}
	err := q.pool.QueryRow(ctx,
		`SELECT id, name, type, paths, scan_interval_min, owner_id, created_at, updated_at
		 FROM libraries WHERE id = $1`, id,
	).Scan(&l.ID, &l.Name, &l.Type, &l.Paths, &l.ScanInterval, &l.OwnerID, &l.CreatedAt, &l.UpdatedAt)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("get library: %w", err)
	}
	return l, nil
}

func (q *Queries) UpdateLibrary(ctx context.Context, id int64, name string) (*models.Library, error) {
	l := &models.Library{}
	err := q.pool.QueryRow(ctx,
		`UPDATE libraries SET name = $2, updated_at = NOW()
		 WHERE id = $1
		 RETURNING id, name, type, paths, scan_interval_min, owner_id, created_at, updated_at`,
		id, name,
	).Scan(&l.ID, &l.Name, &l.Type, &l.Paths, &l.ScanInterval, &l.OwnerID, &l.CreatedAt, &l.UpdatedAt)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("update library: %w", err)
	}
	return l, nil
}

func (q *Queries) DeleteLibrary(ctx context.Context, id int64) (bool, error) {
	result, err := q.pool.Exec(ctx, `DELETE FROM libraries WHERE id = $1`, id)
	if err != nil {
		return false, err
	}
	return result.RowsAffected() > 0, nil
}

// ============================================================
// Media Items
// ============================================================

// DeleteMediaItem removes a single media item (movie or show) by id. Every
// child record — files, seasons, episodes, episode files, artwork, cast,
// genres, watch progress, collection memberships, etc. — is reaped via the
// ON DELETE CASCADE foreign keys that all reference media_items(id). Returns
// true when a row was actually deleted (false ⇒ no such id). Files on disk are
// NOT touched; this only removes Aurora's catalog entry. Used by the admin
// "remove from library" action.
func (q *Queries) DeleteMediaItem(ctx context.Context, id int64) (bool, error) {
	result, err := q.pool.Exec(ctx, `DELETE FROM media_items WHERE id = $1`, id)
	if err != nil {
		return false, err
	}
	return result.RowsAffected() > 0, nil
}

// DeletedMediaItem identifies a media item removed by DeleteEmptyMediaItems,
// carried back so the scanner can log exactly what it swept.
type DeletedMediaItem struct {
	ID    int64
	Title string
}

// DeleteEmptyMediaItems removes every media item in a library that has no
// playable file left — a movie with zero media_files, or a show with zero
// episode_files across all of its episodes. This is the catalog-side
// complement to the scanner's file prune: once a title's last file is deleted
// from disk (and pruned from episode_files/media_files), its orphaned metadata
// shell — the "no files available" ghost the UI would otherwise show forever —
// is swept away too, cascading its seasons/episodes/artwork/progress.
//
// SAFETY: scoped to a single library and only ever invoked by the scanner
// AFTER a clean, non-empty directory walk (see ScanLibrary's walkFailed /
// zero-discovered guards), so a transient mount failure that hides files can
// never trip this into deleting live catalog rows. Media items are only ever
// created by the scanner from real files, so an empty item always means its
// files genuinely vanished. Returns the removed items for activity logging.
func (q *Queries) DeleteEmptyMediaItems(ctx context.Context, libraryID int64) ([]DeletedMediaItem, error) {
	rows, err := q.pool.Query(ctx, `
		DELETE FROM media_items mi
		WHERE mi.library_id = $1
		  AND NOT EXISTS (
		        SELECT 1 FROM media_files mf WHERE mf.media_item_id = mi.id)
		  AND NOT EXISTS (
		        SELECT 1 FROM tv_episodes te
		        JOIN episode_files ef ON ef.episode_id = te.id
		        WHERE te.media_item_id = mi.id)
		RETURNING mi.id, mi.title`, libraryID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var deleted []DeletedMediaItem
	for rows.Next() {
		var d DeletedMediaItem
		if err := rows.Scan(&d.ID, &d.Title); err != nil {
			return nil, err
		}
		deleted = append(deleted, d)
	}
	return deleted, rows.Err()
}

func (q *Queries) UpsertMediaItem(ctx context.Context, item *models.MediaItem) error {
	// Uses the unique index uq_media_items_lib_type_title_year which handles NULL years via COALESCE
	return q.pool.QueryRow(ctx,
		`INSERT INTO media_items (library_id, type, title, sort_title, year, overview, rating, runtime_minutes, content_rating)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		 ON CONFLICT (library_id, type, title, COALESCE(year, 0)) DO UPDATE SET
		   sort_title = EXCLUDED.sort_title,
		   updated_at = NOW()
		 RETURNING id, added_at, updated_at`,
		item.LibraryID, item.Type, item.Title, item.SortTitle, item.Year,
		item.Overview, item.Rating, item.RuntimeMin, item.ContentRating,
	).Scan(&item.ID, &item.AddedAt, &item.UpdatedAt)
}

func (q *Queries) GetMediaItems(ctx context.Context, filter models.MediaFilter, page models.PaginationParams) ([]*models.MediaItem, int64, error) {
	// Build dynamic query
	where := []string{"1=1"}
	args := []interface{}{}
	argIdx := 1

	if filter.Type != "" {
		where = append(where, fmt.Sprintf("m.type = $%d", argIdx))
		args = append(args, filter.Type)
		argIdx++
	}
	if filter.Genre != "" {
		where = append(where, fmt.Sprintf(
			`EXISTS (SELECT 1 FROM media_genres mg JOIN genres g ON g.id = mg.genre_id
			 WHERE mg.media_item_id = m.id AND g.name ILIKE $%d)`, argIdx))
		args = append(args, filter.Genre)
		argIdx++
	}
	if filter.Year > 0 {
		where = append(where, fmt.Sprintf("m.year = $%d", argIdx))
		args = append(args, filter.Year)
		argIdx++
	}
	if filter.Query != "" {
		// 2026-05-19 audit (BE-C1) — `'%%%%'` in Sprintf produces
		// `'%%'` in the SQL, which ILIKE matches as the LITERAL
		// two-char string "%%", not the wildcard. Single `%%` in
		// the format string produces the correct `'%'` wildcard.
		// The text filter on GET /media has been silently broken
		// in production until this fix.
		where = append(where, fmt.Sprintf("m.title ILIKE '%%' || $%d || '%%'", argIdx))
		args = append(args, filter.Query)
		argIdx++
	}
	if len(filter.AllowedRatings) > 0 {
		where = append(where, fmt.Sprintf("m.content_rating = ANY($%d)", argIdx))
		args = append(args, filter.AllowedRatings)
		argIdx++
	}

	whereClause := strings.Join(where, " AND ")

	// Cross-library deduplication: items in multiple libraries (e.g. "Movies"
	// and "4K Movies") share a tmdb_id. We use DISTINCT ON inside a CTE to
	// pick the best item per unique tmdb_id once, then both COUNT and the
	// paginated SELECT read from the materialized CTE result.
	// Items without a tmdb_id (or tmdb_id=0) use -id as a unique key so
	// they are never merged with each other.
	//
	// Among duplicates, we pick the item with the richest metadata via a
	// scoring expression that mirrors Go's metadataRichness(), including
	// a Genres check via EXISTS subquery.
	//
	// m.type is part of the dedup key because TMDB's movie and TV id spaces are
	// INDEPENDENT: movie 100 and tv 100 both exist and are unrelated titles.
	// The `m.type = $n` filter above cannot be relied on to scope this — it is
	// only added when filter.Type is non-empty, and GET /api/media without a
	// `type` param is a real call (the SPA's catalog-size count issues
	// `/api/media?per_page=1`). Without the type in the key, such a request
	// collapsed a colliding movie and show into one row and undercounted
	// total_items by one per collision.
	dedupCTE := fmt.Sprintf(
		`WITH deduped AS (
		   SELECT DISTINCT ON (m.type, COALESCE(NULLIF(m.tmdb_id, 0)::bigint, -m.id))
		          m.id, m.library_id, m.type, m.title, m.sort_title,
		          COALESCE(m.year, 0) AS year,
		          COALESCE(m.overview, '') AS overview,
		          COALESCE(m.rating, 0) AS rating,
		          COALESCE(m.runtime_minutes, 0) AS runtime_minutes,
		          COALESCE(m.content_rating, '') AS content_rating,
		          COALESCE(m.poster_path,'') AS poster_path,
		          COALESCE(m.backdrop_path,'') AS backdrop_path,
		          m.added_at, m.updated_at
		   FROM media_items m
		   WHERE %s
		   ORDER BY m.type, COALESCE(NULLIF(m.tmdb_id, 0)::bigint, -m.id),
		            (CASE WHEN m.overview IS NOT NULL AND m.overview <> '' THEN 3 ELSE 0 END
		           + CASE WHEN m.poster_path IS NOT NULL AND m.poster_path <> '' THEN 3 ELSE 0 END
		           + CASE WHEN m.backdrop_path IS NOT NULL AND m.backdrop_path <> '' THEN 2 ELSE 0 END
		           + CASE WHEN m.rating > 0 THEN 2 ELSE 0 END
		           + CASE WHEN m.runtime_minutes > 0 THEN 1 ELSE 0 END
		           + CASE WHEN m.content_rating IS NOT NULL AND m.content_rating <> '' THEN 1 ELSE 0 END
		           + CASE WHEN m.year > 0 THEN 1 ELSE 0 END
		           + CASE WHEN EXISTS (SELECT 1 FROM media_genres WHERE media_item_id = m.id) THEN 1 ELSE 0 END) DESC,
		            m.id ASC
		 )`,
		whereClause,
	)

	// Count total unique items (after dedup)
	var total int64
	countQuery := dedupCTE + ` SELECT COUNT(*) FROM deduped`
	if err := q.pool.QueryRow(ctx, countQuery, args...).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("count media items: %w", err)
	}

	// Determine sort
	orderBy := "d.added_at DESC"
	switch filter.SortBy {
	case "title":
		orderBy = "d.sort_title ASC"
	case "rating":
		orderBy = "d.rating DESC NULLS LAST"
	case "year":
		orderBy = "d.year DESC NULLS LAST"
	}

	// Paginate
	if page.PerPage <= 0 {
		page.PerPage = 20
	}
	if page.Page <= 0 {
		page.Page = 1
	}
	offset := (page.Page - 1) * page.PerPage

	// The nullable columns are handled INSIDE dedupCTE, which COALESCEs and
	// aliases them; this projection reads those aliases, so it needs no second
	// COALESCE. A branch of the #510 work briefly added one here and it was pure
	// noise — see the NULL-scan section in CLAUDE.md, which states the rule.
	dataQuery := dedupCTE + fmt.Sprintf(
		` SELECT d.id, d.library_id, d.type, d.title, d.sort_title, d.year,
		        d.overview, d.rating, d.runtime_minutes, d.content_rating,
		        d.poster_path, d.backdrop_path, d.added_at, d.updated_at
		 FROM deduped d
		 ORDER BY %s LIMIT $%d OFFSET $%d`,
		orderBy, argIdx, argIdx+1,
	)
	args = append(args, page.PerPage, offset)

	rows, err := q.pool.Query(ctx, dataQuery, args...)
	if err != nil {
		return nil, 0, fmt.Errorf("query media items: %w", err)
	}
	defer rows.Close()

	var items []*models.MediaItem
	for rows.Next() {
		item := &models.MediaItem{}
		if err := rows.Scan(
			&item.ID, &item.LibraryID, &item.Type, &item.Title, &item.SortTitle,
			&item.Year, &item.Overview, &item.Rating, &item.RuntimeMin, &item.ContentRating,
			&item.PosterPath, &item.BackdropPath,
			&item.AddedAt, &item.UpdatedAt,
		); err != nil {
			return nil, 0, fmt.Errorf("scan media item: %w", err)
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("iterate media items: %w", err)
	}

	return items, total, nil
}

// FoundMediaItem is the narrow projection FindMediaItemByTitle returns: the
// identity fields the scanner needs to adopt an existing row, plus whether that
// row has ever actually had metadata written to it.
//
// Deliberately NOT models.MediaItem: the scanner only ever reads
// ID/AddedAt/UpdatedAt off this result, so the wide projection was carrying
// eleven columns nobody looked at, and every one of them a column this query
// then had to keep NULL-safe.
//
// It is NOT the fix for the NULL-year scan error. That was already closed on the
// base branch, by COALESCEing the wide projection; narrowing it removes the
// columns rather than the NULLs, and nothing about UpsertMediaItem's
// COALESCE(year, 0) keying moves either way. Do not read this as a second fix
// for the same bug — an earlier version of this comment did, and stating a
// defect the code never had is how the next reader mis-reasons about it.
type FoundMediaItem struct {
	ID        int64
	AddedAt   time.Time
	UpdatedAt time.Time
	// Attempted reports whether this row has ever made metadata PROGRESS:
	// either metadata was stored (last_metadata) or a provider was asked and
	// answered (last_metadata_attempt). It reads the same metadataProgressExpr
	// the refresh queue orders on, so the scanner and the queue cannot disagree
	// about what "already dealt with" means.
	//
	// "Stored" alone would be the wrong test. It cannot distinguish "enrichment
	// never ran" — the #510 state, which must be re-queued — from "enrichment
	// ran and no provider has an entry for this title", which must NOT be, or
	// every scan that brings a file re-pays a TMDB search, a TVDB search, an
	// embed and possibly an LLM re-match for a show that will never match.
	// Progress covers both: a scan interrupted before its deferred TV pass
	// leaves BOTH columns NULL, so the #510 rows still recover, while an
	// answered-but-unmatched show is left to the refresh queue's rotation.
	Attempted bool
}

// FindMediaItemByTitle finds an existing media item by (library_id, type, title)
// regardless of year. Used by the scanner under the per-show lock to resolve the
// canonical item even after enrichment has changed its year (which breaks the
// UpsertMediaItem ON CONFLICT path that includes COALESCE(year, 0)).
// Returns nil, nil if no matching item exists.
func (q *Queries) FindMediaItemByTitle(ctx context.Context, libraryID int64, mediaType, title string) (*FoundMediaItem, error) {
	found := &FoundMediaItem{}
	err := q.pool.QueryRow(ctx,
		`SELECT id, added_at, updated_at, `+metadataProgressExpr+` IS NOT NULL
		 FROM media_items WHERE library_id = $1 AND type = $2 AND title = $3
		 ORDER BY id ASC LIMIT 1`,
		libraryID, mediaType, title,
	).Scan(&found.ID, &found.AddedAt, &found.UpdatedAt, &found.Attempted)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("find media item by title: %w", err)
	}
	return found, nil
}

func (q *Queries) GetMediaItem(ctx context.Context, id int64) (*models.MediaItem, error) {
	item := &models.MediaItem{}
	// 2026-05-25 — match_status added to the projection so callers can
	// distinguish 'matched' vs 'needs_review' vs unset. The AI re-matcher
	// inline worker needs this to skip items that a concurrent ManualMatch
	// flipped to 'matched' between enqueue and processing (deep-debugger
	// Bug 7.1). COALESCE because pre-Phase-2 rows may have NULL status.
	var matchStatus *string
	err := q.pool.QueryRow(ctx,
		`SELECT id, library_id, type, title, sort_title, COALESCE(year, 0), COALESCE(overview, ''),
		        COALESCE(rating, 0), COALESCE(runtime_minutes, 0), COALESCE(content_rating, ''),
		        COALESCE(poster_path,''), COALESCE(backdrop_path,''), match_status, added_at, updated_at
		 FROM media_items WHERE id = $1`, id,
	).Scan(&item.ID, &item.LibraryID, &item.Type, &item.Title, &item.SortTitle,
		&item.Year, &item.Overview, &item.Rating, &item.RuntimeMin, &item.ContentRating,
		&item.PosterPath, &item.BackdropPath, &matchStatus,
		&item.AddedAt, &item.UpdatedAt,
	)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("get media item: %w", err)
	}
	if matchStatus != nil {
		item.MatchStatus = *matchStatus
	}
	return item, nil
}

func (q *Queries) SearchMedia(ctx context.Context, query string, limit int) ([]*models.MediaItem, error) {
	if limit <= 0 {
		limit = 20
	}
	rows, err := q.pool.Query(ctx,
		`SELECT id, library_id, type, title, sort_title, COALESCE(year, 0), COALESCE(overview, ''),
		        COALESCE(rating, 0), COALESCE(runtime_minutes, 0), COALESCE(content_rating, ''),
		        COALESCE(poster_path,''), COALESCE(backdrop_path,''), added_at, updated_at
		 FROM media_items
		 WHERE title % $1 OR title ILIKE '%' || $1 || '%'
		    OR overview % $1 OR overview ILIKE '%' || $1 || '%'
		 ORDER BY similarity(title, $1) DESC, id DESC
		 LIMIT $2`,
		query, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("search media: %w", err)
	}
	defer rows.Close()

	var items []*models.MediaItem
	for rows.Next() {
		item := &models.MediaItem{}
		if err := rows.Scan(
			&item.ID, &item.LibraryID, &item.Type, &item.Title, &item.SortTitle,
			&item.Year, &item.Overview, &item.Rating, &item.RuntimeMin, &item.ContentRating,
			&item.PosterPath, &item.BackdropPath,
			&item.AddedAt, &item.UpdatedAt,
		); err != nil {
			return nil, fmt.Errorf("scan search result: %w", err)
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate search results: %w", err)
	}
	return items, nil
}

// ============================================================
// Match Status (flag for review)
// ============================================================

func (q *Queries) SetMatchStatus(ctx context.Context, itemID int64, status string) error {
	_, err := q.pool.Exec(ctx,
		`UPDATE media_items SET match_status = $2, updated_at = NOW() WHERE id = $1`,
		itemID, status)
	return err
}

func (q *Queries) GetItemsNeedingReview(ctx context.Context) ([]*models.MediaItem, error) {
	// AI-match suggestion columns (migration 026) are scanned into pointer
	// fields on MediaItem — NULL distinguishes "AI never ran on this item"
	// from "AI ran but the LLM returned 0 confidence". The admin UI uses the
	// presence of ai_suggested_tmdb_id to render a one-click "Accept
	// suggestion" button that hits the existing ManualMatch endpoint.
	rows, err := q.pool.Query(ctx,
		`SELECT m.id, m.library_id, m.type, m.title, m.sort_title,
		        COALESCE(m.year, 0), COALESCE(m.overview, ''),
		        COALESCE(m.rating, 0), COALESCE(m.runtime_minutes, 0),
		        COALESCE(m.content_rating, ''),
		        COALESCE(m.poster_path,''), COALESCE(m.backdrop_path,''),
		        m.added_at, m.updated_at,
		        m.ai_suggested_tmdb_id, COALESCE(m.ai_suggested_title, ''),
		        COALESCE(m.ai_suggested_year, 0), m.ai_match_confidence,
		        COALESCE(m.ai_match_reasoning, ''), m.ai_match_ran_at,
		        COALESCE(
		            (SELECT mf.path FROM media_files mf WHERE mf.media_item_id = m.id ORDER BY mf.id LIMIT 1),
		            (SELECT ef.path FROM episode_files ef
		             JOIN tv_episodes ep ON ep.id = ef.episode_id
		             WHERE ep.media_item_id = m.id
		             ORDER BY ep.season_id, ep.episode_number, ef.id LIMIT 1),
		            ''
		        ) AS file_path
		 FROM media_items m
		 WHERE m.match_status = 'needs_review'
		 ORDER BY m.added_at DESC`)
	if err != nil {
		return nil, fmt.Errorf("get items needing review: %w", err)
	}
	defer rows.Close()

	var items []*models.MediaItem
	for rows.Next() {
		item := &models.MediaItem{}
		if err := rows.Scan(
			&item.ID, &item.LibraryID, &item.Type, &item.Title, &item.SortTitle,
			&item.Year, &item.Overview, &item.Rating, &item.RuntimeMin, &item.ContentRating,
			&item.PosterPath, &item.BackdropPath,
			&item.AddedAt, &item.UpdatedAt,
			&item.AISuggestedTMDBID, &item.AISuggestedTitle,
			&item.AISuggestedYear, &item.AIMatchConfidence,
			&item.AIMatchReasoning, &item.AIMatchRanAt,
			&item.FilePath,
		); err != nil {
			return nil, fmt.Errorf("scan review item: %w", err)
		}
		item.MatchStatus = "needs_review"
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate review items: %w", err)
	}
	return items, nil
}

// ============================================================
// Media Files
// ============================================================

func (q *Queries) UpsertMediaFile(ctx context.Context, f *models.MediaFile) error {
	aj, sj := marshalTracks(f.AudioTracks, f.SubtitleTracks)
	return q.pool.QueryRow(ctx,
		`INSERT INTO media_files (media_item_id, path, size_bytes, container, video_codec, audio_codec, resolution, bitrate, duration_ms, file_hash, audio_tracks, subtitle_tracks, version_tag, video_profile, video_pix_fmt, color_transfer, color_primaries, video_fps)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
		 ON CONFLICT (path) DO UPDATE SET
		   size_bytes = EXCLUDED.size_bytes, container = EXCLUDED.container,
		   video_codec = EXCLUDED.video_codec, audio_codec = EXCLUDED.audio_codec,
		   resolution = EXCLUDED.resolution, bitrate = EXCLUDED.bitrate,
		   duration_ms = EXCLUDED.duration_ms, file_hash = EXCLUDED.file_hash,
		   audio_tracks = EXCLUDED.audio_tracks, subtitle_tracks = EXCLUDED.subtitle_tracks,
		   version_tag = EXCLUDED.version_tag,
		   video_profile = EXCLUDED.video_profile, video_pix_fmt = EXCLUDED.video_pix_fmt,
		   color_transfer = EXCLUDED.color_transfer, color_primaries = EXCLUDED.color_primaries, video_fps = EXCLUDED.video_fps,
		   scanned_at = NOW()
		 RETURNING id, scanned_at`,
		f.MediaItemID, f.Path, f.SizeBytes, f.Container, f.VideoCodec,
		f.AudioCodec, f.Resolution, f.Bitrate, f.DurationMs, f.FileHash, aj, sj, f.VersionTag,
		f.VideoProfile, f.VideoPixFmt, f.ColorTransfer, f.ColorPrimaries, f.VideoFPS,
	).Scan(&f.ID, &f.ScannedAt)
}

func (q *Queries) GetMediaFileByPath(ctx context.Context, path string) (*models.MediaFile, error) {
	f := &models.MediaFile{}
	var audioJSON, subtitleJSON []byte
	err := q.pool.QueryRow(ctx,
		`SELECT id, media_item_id, path, size_bytes, COALESCE(container, ''), COALESCE(video_codec, ''), COALESCE(audio_codec, ''),
		        COALESCE(resolution, ''), COALESCE(bitrate, 0), COALESCE(duration_ms, 0),
		        file_hash, scanned_at, audio_tracks, subtitle_tracks, version_tag, video_profile, video_pix_fmt, color_transfer, color_primaries, video_fps
		 FROM media_files WHERE path = $1`, path,
	).Scan(&f.ID, &f.MediaItemID, &f.Path, &f.SizeBytes, &f.Container, &f.VideoCodec,
		&f.AudioCodec, &f.Resolution, &f.Bitrate, &f.DurationMs, &f.FileHash, &f.ScannedAt,
		&audioJSON, &subtitleJSON, &f.VersionTag, &f.VideoProfile, &f.VideoPixFmt, &f.ColorTransfer, &f.ColorPrimaries, &f.VideoFPS,
	)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("get media file: %w", err)
	}
	// 2026-05-19 audit (BE-H1) — route through unmarshalTracks
	// (queries_crosslib.go) so corrupt JSONB rows log a warning
	// instead of silently leaving tracks empty. An empty AudioTracks
	// makes DecidePlayback think the file has no audio and can pick
	// direct_play for an actually-incompatible file.
	unmarshalTracks(audioJSON, &f.AudioTracks, f.ID, "audio")
	unmarshalTracks(subtitleJSON, &f.SubtitleTracks, f.ID, "subtitle")
	return f, nil
}

func (q *Queries) GetMediaFiles(ctx context.Context, mediaItemID int64) ([]*models.MediaFile, error) {
	rows, err := q.pool.Query(ctx,
		`SELECT id, media_item_id, path, size_bytes, COALESCE(container, ''), COALESCE(video_codec, ''), COALESCE(audio_codec, ''),
		        COALESCE(resolution, ''), COALESCE(bitrate, 0), COALESCE(duration_ms, 0),
		        file_hash, scanned_at, audio_tracks, subtitle_tracks, version_tag, video_profile, video_pix_fmt, color_transfer, color_primaries, video_fps
		 FROM media_files WHERE media_item_id = $1
		 ORDER BY CASE version_tag WHEN '4K' THEN 1 WHEN '1080p' THEN 2 WHEN '720p' THEN 3 ELSE 4 END, id`, mediaItemID,
	)
	if err != nil {
		return nil, fmt.Errorf("get media files: %w", err)
	}
	defer rows.Close()

	var files []*models.MediaFile
	for rows.Next() {
		f := &models.MediaFile{}
		var audioJSON, subtitleJSON []byte
		if err := rows.Scan(&f.ID, &f.MediaItemID, &f.Path, &f.SizeBytes, &f.Container, &f.VideoCodec,
			&f.AudioCodec, &f.Resolution, &f.Bitrate, &f.DurationMs, &f.FileHash, &f.ScannedAt,
			&audioJSON, &subtitleJSON, &f.VersionTag, &f.VideoProfile, &f.VideoPixFmt, &f.ColorTransfer, &f.ColorPrimaries, &f.VideoFPS,
		); err != nil {
			return nil, fmt.Errorf("scan media file: %w", err)
		}
		// 2026-05-19 audit (BE-H1) — see GetMediaFile above for the
		// rationale; same call site here, log corrupt rows instead
		// of silently returning empty tracks.
		unmarshalTracks(audioJSON, &f.AudioTracks, f.ID, "audio")
		unmarshalTracks(subtitleJSON, &f.SubtitleTracks, f.ID, "subtitle")
		files = append(files, f)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate media files: %w", err)
	}
	return files, nil
}

// GetAnyFilePath returns a representative file path for a media item,
// checking media_files (movies) then episode_files (TV shows).
func (q *Queries) GetAnyFilePath(ctx context.Context, mediaItemID int64) string {
	var path string
	err := q.pool.QueryRow(ctx,
		`SELECT COALESCE(
			(SELECT mf.path FROM media_files mf WHERE mf.media_item_id = $1 ORDER BY mf.id LIMIT 1),
			(SELECT ef.path FROM episode_files ef
			 JOIN tv_episodes ep ON ep.id = ef.episode_id
			 JOIN tv_seasons s ON s.id = ep.season_id
			 WHERE s.media_item_id = $1
			 ORDER BY s.season_number, ep.episode_number, ef.id LIMIT 1),
			''
		)`, mediaItemID).Scan(&path)
	if err != nil {
		return ""
	}
	return path
}

func (q *Queries) GetRecentMedia(ctx context.Context, limit int) ([]*models.MediaItem, error) {
	if limit <= 0 {
		limit = 20
	}
	// Cross-library deduplication: same DISTINCT ON pattern as GetMediaItems.
	// Among duplicates sharing a tmdb_id, pick the item with the richest
	// metadata, then order the deduped set by added_at DESC.
	//
	// The nullable columns are COALESCEd and aliased inside the CTE below, so the
	// outer SELECT reads those aliases and needs no second COALESCE. One lesson
	// from finding this query's NULL defect is worth keeping, though: with a
	// single all-NULL row present this was the only query in the SUITE that
	// broke, and that was briefly mistaken for evidence that the others were
	// unreachable. A test sweep is not a reachability argument.
	//
	// The richness CASEs below read the raw columns and each already collapses
	// NULL and zero identically, so ranking is unaffected either way.
	//
	// m.type is part of the dedup key because TMDB's movie and TV id spaces are
	// INDEPENDENT: movie 100 and tv 100 both exist and are unrelated titles.
	// This query carries no type filter at all, so without the type in the key
	// a colliding movie and show collapsed into one row and one of the two
	// vanished from "Recently Added" entirely — in practice the show, because the
	// tie-break after equal richness is media_items.id ASC and movie libraries
	// are typically scanned first, so their rows carry the lower ids.
	rows, err := q.pool.Query(ctx,
		`WITH deduped AS (
		   SELECT DISTINCT ON (m.type, COALESCE(NULLIF(m.tmdb_id, 0)::bigint, -m.id))
		          m.id, m.library_id, m.type, m.title, m.sort_title,
		          COALESCE(m.year, 0) AS year,
		          COALESCE(m.overview, '') AS overview,
		          COALESCE(m.rating, 0) AS rating,
		          COALESCE(m.runtime_minutes, 0) AS runtime_minutes,
		          COALESCE(m.content_rating, '') AS content_rating,
		          COALESCE(m.poster_path,'') AS poster_path,
		          COALESCE(m.backdrop_path,'') AS backdrop_path,
		          m.added_at, m.updated_at
		   FROM media_items m
		   ORDER BY m.type, COALESCE(NULLIF(m.tmdb_id, 0)::bigint, -m.id),
		            (CASE WHEN m.overview IS NOT NULL AND m.overview <> '' THEN 3 ELSE 0 END
		           + CASE WHEN m.poster_path IS NOT NULL AND m.poster_path <> '' THEN 3 ELSE 0 END
		           + CASE WHEN m.backdrop_path IS NOT NULL AND m.backdrop_path <> '' THEN 2 ELSE 0 END
		           + CASE WHEN m.rating > 0 THEN 2 ELSE 0 END
		           + CASE WHEN m.runtime_minutes > 0 THEN 1 ELSE 0 END
		           + CASE WHEN m.content_rating IS NOT NULL AND m.content_rating <> '' THEN 1 ELSE 0 END
		           + CASE WHEN m.year > 0 THEN 1 ELSE 0 END
		           + CASE WHEN EXISTS (SELECT 1 FROM media_genres WHERE media_item_id = m.id) THEN 1 ELSE 0 END) DESC,
		            m.id ASC
		 )
		 SELECT id, library_id, type, title, sort_title, year,
		        overview, rating, runtime_minutes, content_rating,
		        poster_path, backdrop_path, added_at, updated_at
		 FROM deduped
		 ORDER BY added_at DESC LIMIT $1`, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("get recent media: %w", err)
	}
	defer rows.Close()

	var items []*models.MediaItem
	for rows.Next() {
		item := &models.MediaItem{}
		if err := rows.Scan(
			&item.ID, &item.LibraryID, &item.Type, &item.Title, &item.SortTitle,
			&item.Year, &item.Overview, &item.Rating, &item.RuntimeMin, &item.ContentRating,
			&item.PosterPath, &item.BackdropPath,
			&item.AddedAt, &item.UpdatedAt,
		); err != nil {
			return nil, fmt.Errorf("scan recent media: %w", err)
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate recent media: %w", err)
	}
	return items, nil
}

// ============================================================
// Batch Operations (for scanner performance)
// ============================================================

func (q *Queries) BatchInsertMediaFiles(ctx context.Context, files []*models.MediaFile) error {
	if len(files) == 0 {
		return nil
	}

	batch := &pgx.Batch{}
	for _, f := range files {
		aj, sj := marshalTracks(f.AudioTracks, f.SubtitleTracks)
		batch.Queue(
			`INSERT INTO media_files (media_item_id, path, size_bytes, container, video_codec, audio_codec, resolution, bitrate, duration_ms, file_hash, audio_tracks, subtitle_tracks, version_tag, video_profile, video_pix_fmt, color_transfer, color_primaries, video_fps)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
			 ON CONFLICT (path) DO UPDATE SET
			   size_bytes = EXCLUDED.size_bytes, file_hash = EXCLUDED.file_hash,
			   container = EXCLUDED.container, video_codec = EXCLUDED.video_codec,
			   audio_codec = EXCLUDED.audio_codec, resolution = EXCLUDED.resolution,
			   bitrate = EXCLUDED.bitrate, duration_ms = EXCLUDED.duration_ms,
			   audio_tracks = EXCLUDED.audio_tracks, subtitle_tracks = EXCLUDED.subtitle_tracks,
			   version_tag = EXCLUDED.version_tag,
			   video_profile = EXCLUDED.video_profile, video_pix_fmt = EXCLUDED.video_pix_fmt,
			   color_transfer = EXCLUDED.color_transfer, color_primaries = EXCLUDED.color_primaries, video_fps = EXCLUDED.video_fps,
			   scanned_at = NOW()`,
			f.MediaItemID, f.Path, f.SizeBytes, f.Container, f.VideoCodec,
			f.AudioCodec, f.Resolution, f.Bitrate, f.DurationMs, f.FileHash, aj, sj, f.VersionTag,
			f.VideoProfile, f.VideoPixFmt, f.ColorTransfer, f.ColorPrimaries, f.VideoFPS,
		)
	}

	br := q.pool.SendBatch(ctx, batch)
	defer br.Close()

	for range files {
		if _, err := br.Exec(); err != nil {
			return fmt.Errorf("batch insert media file: %w", err)
		}
	}
	return nil
}

func (q *Queries) BatchInsertEpisodeFiles(ctx context.Context, files []*models.EpisodeFile) error {
	if len(files) == 0 {
		return nil
	}

	batch := &pgx.Batch{}
	for _, f := range files {
		aj, sj := marshalTracks(f.AudioTracks, f.SubtitleTracks)
		batch.Queue(
			`INSERT INTO episode_files (episode_id, path, size_bytes, container, video_codec, audio_codec, resolution, bitrate, duration_ms, file_hash, audio_tracks, subtitle_tracks, version_tag, video_profile, video_pix_fmt, color_transfer, color_primaries, video_fps)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
			 ON CONFLICT (path) DO UPDATE SET
			   episode_id = EXCLUDED.episode_id,
			   size_bytes = EXCLUDED.size_bytes, file_hash = EXCLUDED.file_hash,
			   container = EXCLUDED.container, video_codec = EXCLUDED.video_codec,
			   audio_codec = EXCLUDED.audio_codec, resolution = EXCLUDED.resolution,
			   bitrate = EXCLUDED.bitrate, duration_ms = EXCLUDED.duration_ms,
			   audio_tracks = EXCLUDED.audio_tracks, subtitle_tracks = EXCLUDED.subtitle_tracks,
			   version_tag = EXCLUDED.version_tag,
			   video_profile = EXCLUDED.video_profile, video_pix_fmt = EXCLUDED.video_pix_fmt,
			   color_transfer = EXCLUDED.color_transfer, color_primaries = EXCLUDED.color_primaries, video_fps = EXCLUDED.video_fps,
			   scanned_at = NOW()`,
			f.EpisodeID, f.Path, f.SizeBytes, f.Container, f.VideoCodec,
			f.AudioCodec, f.Resolution, f.Bitrate, f.DurationMs, f.FileHash, aj, sj, f.VersionTag,
			f.VideoProfile, f.VideoPixFmt, f.ColorTransfer, f.ColorPrimaries, f.VideoFPS,
		)
	}

	br := q.pool.SendBatch(ctx, batch)
	defer br.Close()

	for range files {
		if _, err := br.Exec(); err != nil {
			return fmt.Errorf("batch insert episode file: %w", err)
		}
	}
	return nil
}

// UpdateUserPassword sets a new password hash for a user.
func (q *Queries) UpdateUserPassword(ctx context.Context, userID int64, passwordHash string) error {
	_, err := q.pool.Exec(ctx,
		`UPDATE users SET password_hash = $2, updated_at = NOW() WHERE id = $1`,
		userID, passwordHash)
	return err
}

// roleChangeLockKey is a transaction-scoped pg advisory-lock key that
// serializes all role changes so the last-admin guard in UpdateUserRole cannot
// race. The value is arbitrary but fixed ("AUROLE" in hex); it only has to be
// distinct from any other advisory-lock key the app uses.
const roleChangeLockKey int64 = 0x4155524F4C45

// UpdateUserRole sets a user's role (admin/user) and stamps updated_at (a role
// change is an account mutation). Returns:
//   - updated: a row was changed (false → no such user; handler maps to 404).
//   - lastAdmin: the change was refused because it would demote the last
//     remaining admin (handler maps to 400). Never set for a promotion.
//
// Zero-admin protection: the handler's self-guard already makes a *sequential*
// path to zero admins impossible (you can't demote yourself, so demoting any
// other admin always leaves you). The remaining hole is concurrency — two
// admins demoting each other at the same instant would each read admin_count
// == 2 and both succeed, stranding the server with no admin (unrecoverable,
// since promotion is itself admin-gated). We close it by taking a
// transaction-scoped advisory lock that serializes role changes, then checking
// the live admin count inside the same transaction. The lock releases on
// commit/rollback; role changes are rare admin actions, so global
// serialization costs nothing.
//
// The role is also baked into the JWT at issue time and RequireAdmin reads it
// from the claims, so the caller MUST bump the target's token_version after
// this for the change to take effect promptly rather than waiting out the
// access-token lifetime. See AuthHandler.UpdateUserRole.
func (q *Queries) UpdateUserRole(ctx context.Context, id int64, role models.UserRole) (updated, lastAdmin bool, err error) {
	tx, err := q.pool.Begin(ctx)
	if err != nil {
		return false, false, fmt.Errorf("begin role tx: %w", err)
	}
	defer tx.Rollback(ctx)

	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, roleChangeLockKey); err != nil {
		return false, false, fmt.Errorf("lock role change: %w", err)
	}

	if role == models.RoleUser {
		// Single query: how many admins exist, and is the target one of them?
		// BOOL_OR is NULL when there are no admin rows, hence the COALESCE.
		var adminCount int
		var targetIsAdmin bool
		if err = tx.QueryRow(ctx,
			`SELECT COUNT(*), COALESCE(BOOL_OR(id = $1), false) FROM users WHERE role = 'admin'`,
			id).Scan(&adminCount, &targetIsAdmin); err != nil {
			return false, false, fmt.Errorf("count admins: %w", err)
		}
		if targetIsAdmin && adminCount <= 1 {
			return false, true, nil
		}
	}

	result, err := tx.Exec(ctx,
		`UPDATE users SET role = $2, updated_at = NOW() WHERE id = $1`,
		id, role)
	if err != nil {
		return false, false, fmt.Errorf("update user role: %w", err)
	}
	if err = tx.Commit(ctx); err != nil {
		return false, false, fmt.Errorf("commit role change: %w", err)
	}
	return result.RowsAffected() > 0, false, nil
}

// GetMediaFilePathsForLibrary returns all media_file (id, path) pairs for a library.
func (q *Queries) GetMediaFilePathsForLibrary(ctx context.Context, libraryID int64) (map[string]int64, error) {
	rows, err := q.pool.Query(ctx,
		`SELECT mf.id, mf.path
		 FROM media_files mf
		 JOIN media_items mi ON mi.id = mf.media_item_id
		 WHERE mi.library_id = $1`, libraryID)
	if err != nil {
		return nil, fmt.Errorf("get media file paths: %w", err)
	}
	defer rows.Close()

	result := make(map[string]int64)
	for rows.Next() {
		var id int64
		var path string
		if err := rows.Scan(&id, &path); err != nil {
			return nil, fmt.Errorf("scan media file path: %w", err)
		}
		result[path] = id
	}
	return result, rows.Err()
}

// GetEpisodeFilePathsForLibrary returns all episode_file (id, path) pairs for a library.
func (q *Queries) GetEpisodeFilePathsForLibrary(ctx context.Context, libraryID int64) (map[string]int64, error) {
	rows, err := q.pool.Query(ctx,
		`SELECT ef.id, ef.path
		 FROM episode_files ef
		 JOIN tv_episodes te ON te.id = ef.episode_id
		 JOIN tv_seasons ts ON ts.id = te.season_id
		 JOIN media_items mi ON mi.id = ts.media_item_id
		 WHERE mi.library_id = $1`, libraryID)
	if err != nil {
		return nil, fmt.Errorf("get episode file paths: %w", err)
	}
	defer rows.Close()

	result := make(map[string]int64)
	for rows.Next() {
		var id int64
		var path string
		if err := rows.Scan(&id, &path); err != nil {
			return nil, fmt.Errorf("scan episode file path: %w", err)
		}
		result[path] = id
	}
	return result, rows.Err()
}

// DeleteMediaFilesByIDs deletes media_files by their IDs.
func (q *Queries) DeleteMediaFilesByIDs(ctx context.Context, ids []int64) (int64, error) {
	if len(ids) == 0 {
		return 0, nil
	}
	tag, err := q.pool.Exec(ctx,
		`DELETE FROM media_files WHERE id = ANY($1)`, ids)
	if err != nil {
		return 0, fmt.Errorf("delete media files: %w", err)
	}
	return tag.RowsAffected(), nil
}

// DeleteEpisodeFilesByIDs deletes episode_files by their IDs.
func (q *Queries) DeleteEpisodeFilesByIDs(ctx context.Context, ids []int64) (int64, error) {
	if len(ids) == 0 {
		return 0, nil
	}
	tag, err := q.pool.Exec(ctx,
		`DELETE FROM episode_files WHERE id = ANY($1)`, ids)
	if err != nil {
		return 0, fmt.Errorf("delete episode files: %w", err)
	}
	return tag.RowsAffected(), nil
}
