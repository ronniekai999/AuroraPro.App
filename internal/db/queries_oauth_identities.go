package db

import (
	"context"
	"errors"
	"fmt"

	"github.com/aurora-media/aurora/internal/models"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Multi-provider OAuth identities (migration 031, audit carve-out D).
//
// This file is the data layer for the oauth_identities table, which is the
// AUTHORITATIVE source for "which Aurora user owns this (provider, subject)
// identity?" — replacing the single-value users.oauth_provider/oauth_subject
// columns from migration 020 for resolution purposes. Those columns are kept
// as a best-effort mirror of each user's PRIMARY identity (the first one
// linked) so the OAuth-only-user login gate (empty password_hash + non-nil
// oauth_provider) keeps working without a wider refactor; the fill/clear
// logic for that mirror lives in AddOAuthIdentity / RemoveOAuthIdentity /
// CreateOAuthUserWithIdentity below.
//
// Conflict sentinels:
//   - ErrOAuthIdentityConflict (defined in queries.go, reused here): the
//     incoming (provider, subject) is already linked to a DIFFERENT user.
//   - ErrOAuthProviderAlreadyLinked (defined here): this user already linked a
//     DIFFERENT subject for the same provider (the per-user single-account-per-
//     provider rule). The caller tells the user to unlink the existing one
//     first.

// ErrOAuthProviderAlreadyLinked is returned by AddOAuthIdentity when the target
// user already has a DIFFERENT subject linked for the same provider. The
// idx_oauth_identities_user_provider unique index enforces "at most one linked
// account per provider per user" — so a user who linked Google account A can't
// silently also link Google account B; they must unlink A first. Distinct from
// ErrOAuthIdentityConflict (which is "this identity belongs to someone else").
var ErrOAuthProviderAlreadyLinked = errors.New("user already has a different account linked for this provider")

// Constraint names from migration 031. Matched against pgconn.PgError.
// ConstraintName to disambiguate which uniqueness rule a 23505 violated.
const (
	constraintOAuthIdentityProviderSubject = "idx_oauth_identities_provider_subject"
	constraintOAuthIdentityUserProvider    = "idx_oauth_identities_user_provider"
)

// oauthUserColumns is the user projection shared by GetUserByOAuthIdentity and
// the column-based GetUserByOAuth, kept identical so the two resolution paths
// hydrate the exact same *models.User shape.
const oauthUserColumns = `users.id, users.username, users.email, users.password_hash, users.role,
	COALESCE(users.avatar_url, ''), users.created_at, users.updated_at, users.token_version,
	users.oauth_provider, users.oauth_subject`

// GetUserByOAuthIdentity resolves a (provider, subject) pair to its owning user
// via the oauth_identities table. This is the authoritative Tier-1 fast-path
// for OAuth sign-in (replacing the column-based GetUserByOAuth): once any
// provider is linked, every subsequent sign-in with that identity lands here.
// Returns nil (not an error) when no identity matches.
func (q *Queries) GetUserByOAuthIdentity(ctx context.Context, provider, subject string) (*models.User, error) {
	user := &models.User{}
	err := q.pool.QueryRow(ctx,
		`SELECT `+oauthUserColumns+`
		 FROM users
		 JOIN oauth_identities oi ON oi.user_id = users.id
		 WHERE oi.provider = $1 AND oi.subject = $2`,
		provider, subject,
	).Scan(&user.ID, &user.Username, &user.Email, &user.PasswordHash, &user.Role, &user.AvatarURL,
		&user.CreatedAt, &user.UpdatedAt, &user.TokenVersion, &user.OAuthProvider, &user.OAuthSubject)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("get user by oauth identity: %w", err)
	}
	return user, nil
}

// AddOAuthIdentity links a (provider, subject) to userID by inserting a row in
// oauth_identities. It is the single write-path for both the auto-link-by-email
// flow (Tier 2 of resolveOAuthUser) and the explicit Settings "Connect" flow
// (the link-mode callback). Conflict semantics, by which unique index the
// 23505 names:
//
//   - idx_oauth_identities_provider_subject: this exact identity already
//     exists. If it already belongs to userID, the link is a no-op SUCCESS
//     (idempotent re-link — e.g. the user clicks "Connect Google" twice, or
//     signs in again through the link flow). If it belongs to ANOTHER user,
//     return ErrOAuthIdentityConflict.
//   - idx_oauth_identities_user_provider: userID already linked a DIFFERENT
//     subject for this provider → ErrOAuthProviderAlreadyLinked.
//
// On a successful insert it also best-effort fills the legacy
// users.oauth_provider/oauth_subject columns IFF they are currently empty, so
// the user's PRIMARY (first-linked) identity is mirrored there for the
// OAuth-only-user login gate. A second provider does NOT overwrite the mirror.
// The mirror write tolerates its own 23505 (another user already owns those
// column values) since the columns are non-authoritative.
func (q *Queries) AddOAuthIdentity(ctx context.Context, userID int64, provider, subject string) error {
	_, err := q.pool.Exec(ctx,
		`INSERT INTO oauth_identities (user_id, provider, subject) VALUES ($1, $2, $3)`,
		userID, provider, subject,
	)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			switch pgErr.ConstraintName {
			case constraintOAuthIdentityProviderSubject:
				// The (provider, subject) is taken. Determine by whom: if it's
				// already this user, treat as an idempotent success; otherwise
				// it's a genuine cross-user conflict.
				var ownerID int64
				qErr := q.pool.QueryRow(ctx,
					`SELECT user_id FROM oauth_identities WHERE provider = $1 AND subject = $2`,
					provider, subject,
				).Scan(&ownerID)
				if qErr != nil {
					if qErr == pgx.ErrNoRows {
						// Raced with a concurrent delete; the slot is free again.
						// Surface the original conflict rather than guessing.
						return ErrOAuthIdentityConflict
					}
					return fmt.Errorf("add oauth identity: resolve owner: %w", qErr)
				}
				if ownerID == userID {
					return nil // idempotent re-link of the same identity
				}
				return ErrOAuthIdentityConflict
			case constraintOAuthIdentityUserProvider:
				return ErrOAuthProviderAlreadyLinked
			}
		}
		return fmt.Errorf("add oauth identity: %w", err)
	}

	// Best-effort mirror onto the legacy primary-identity columns, only when
	// they're still empty. Ignore a 23505 here — that can only come from
	// migration 020's partial unique index idx_users_oauth_identity on
	// (oauth_provider, oauth_subject), i.e. another user already holds those
	// exact column values (e.g. a pre-031 row not yet reconciled). The columns
	// are not the source of truth, so that must not fail the link which has
	// ALREADY succeeded in the authoritative oauth_identities table.
	if _, mErr := q.pool.Exec(ctx,
		`UPDATE users SET oauth_provider = $2, oauth_subject = $3, updated_at = NOW()
		 WHERE id = $1 AND (oauth_provider IS NULL OR oauth_provider = '')`,
		userID, provider, subject,
	); mErr != nil {
		var pgErr *pgconn.PgError
		if !errors.As(mErr, &pgErr) || pgErr.Code != "23505" {
			return fmt.Errorf("add oauth identity: mirror legacy columns: %w", mErr)
		}
	}
	return nil
}

// RemoveOAuthIdentity unlinks a provider from userID, deleting the
// oauth_identities row. Returns (true, nil) when a row was removed, (false,
// nil) when the user had no link for that provider (the caller maps this to a
// 404). The lockout guard ("don't strip a user's only sign-in method") lives
// in the handler, NOT here, so this stays a pure data operation reusable by
// future callers.
//
// If the removed provider matches the legacy users.oauth_provider mirror, the
// mirror columns are cleared so a stale primary identity doesn't linger (and so
// the OAuth-only-user gate reflects reality). Other linked providers, if any,
// remain authoritative in oauth_identities regardless of the mirror.
func (q *Queries) RemoveOAuthIdentity(ctx context.Context, userID int64, provider string) (bool, error) {
	var removedSubject string
	err := q.pool.QueryRow(ctx,
		`DELETE FROM oauth_identities WHERE user_id = $1 AND provider = $2 RETURNING subject`,
		userID, provider,
	).Scan(&removedSubject)
	if err != nil {
		if err == pgx.ErrNoRows {
			return false, nil // nothing linked for this provider
		}
		return false, fmt.Errorf("remove oauth identity: %w", err)
	}

	// Clear the legacy mirror only if it pointed at the provider we just
	// removed. Best-effort: a failure here doesn't undo the authoritative
	// delete, so log-and-ignore semantics would be wrong (the row IS gone) —
	// we surface the error so the caller can decide, but the common path is a
	// clean clear.
	if _, mErr := q.pool.Exec(ctx,
		`UPDATE users SET oauth_provider = NULL, oauth_subject = NULL, updated_at = NOW()
		 WHERE id = $1 AND oauth_provider = $2`,
		userID, provider,
	); mErr != nil {
		return true, fmt.Errorf("remove oauth identity: clear legacy mirror: %w", mErr)
	}
	return true, nil
}

// ListOAuthIdentities returns every provider linked to userID, oldest first
// (the first-linked identity is the de-facto primary). Used by the
// GET /api/auth/oauth/links endpoint to render the Connected Accounts UI.
func (q *Queries) ListOAuthIdentities(ctx context.Context, userID int64) ([]models.OAuthIdentity, error) {
	rows, err := q.pool.Query(ctx,
		`SELECT id, user_id, provider, subject, created_at
		 FROM oauth_identities WHERE user_id = $1 ORDER BY created_at ASC`,
		userID,
	)
	if err != nil {
		return nil, fmt.Errorf("list oauth identities: %w", err)
	}
	defer rows.Close()

	var out []models.OAuthIdentity
	for rows.Next() {
		var oi models.OAuthIdentity
		if err := rows.Scan(&oi.ID, &oi.UserID, &oi.Provider, &oi.Subject, &oi.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan oauth identity: %w", err)
		}
		out = append(out, oi)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate oauth identities: %w", err)
	}
	return out, nil
}

// CountOAuthIdentities returns how many providers userID has linked. The unlink
// lockout guard uses this together with "does the user have a password?" to
// refuse removing the last remaining sign-in method.
func (q *Queries) CountOAuthIdentities(ctx context.Context, userID int64) (int, error) {
	var n int
	err := q.pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM oauth_identities WHERE user_id = $1`, userID,
	).Scan(&n)
	if err != nil {
		return 0, fmt.Errorf("count oauth identities: %w", err)
	}
	return n, nil
}

// CreateOAuthUserWithIdentity creates a brand-new OAuth-only user AND its first
// oauth_identities row atomically, in a single transaction. It replaces
// CreateOAuthUser in the Tier-3 new-user path so a freshly created OAuth user
// can NEVER exist without a matching authoritative identity row (which would
// make GetUserByOAuthIdentity miss them on their next sign-in). The user row is
// created exactly like CreateOAuthUser — empty password_hash, role 'user', and
// the legacy columns set so the OAuth-only-user gate works immediately — then
// the identity row is inserted; either failure rolls back both.
//
// A 23505 from the user INSERT (username or email collision) is propagated
// UNCHANGED as the underlying *pgconn.PgError so the caller's Tier-3
// email-vs-username disambiguation (isEmailUniqueConstraint, audit H5) and its
// username-collision retry loop keep working exactly as before.
// referralPending (migration 046) stamps referral_status='pending' in the SAME
// INSERT rather than a follow-up UPDATE. Callers pass the tier-3 eligibility
// predicate — invite-bypass on AND no invite claim redeemed — and it is set
// here so a new user can never exist in the eligible-but-unmarked state that
// would let the prompt be silently skipped. false writes NULL, meaning "never
// eligible", which is also what every password-signup path produces by simply
// not naming the column.
func (q *Queries) CreateOAuthUserWithIdentity(ctx context.Context, username, email, avatarURL, provider, subject string, referralPending bool) (*models.User, error) {
	tx, err := q.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("create oauth user with identity: begin: %w", err)
	}
	// Rollback is a no-op after a successful Commit, so the deferred rollback
	// safely covers every early-return error path without double-handling.
	defer func() { _ = tx.Rollback(ctx) }()

	user := &models.User{}
	if err := tx.QueryRow(ctx,
		`INSERT INTO users (username, email, password_hash, role, avatar_url, oauth_provider, oauth_subject, referral_status)
		 VALUES ($1, $2, '', 'user', $3, $4, $5, CASE WHEN $6::boolean THEN 'pending' END)
		 RETURNING id, username, email, role, COALESCE(avatar_url, ''), created_at, updated_at, token_version,
			oauth_provider, oauth_subject, referral_status`,
		username, email, avatarURL, provider, subject, referralPending,
	).Scan(&user.ID, &user.Username, &user.Email, &user.Role, &user.AvatarURL,
		&user.CreatedAt, &user.UpdatedAt, &user.TokenVersion, &user.OAuthProvider, &user.OAuthSubject,
		&user.ReferralStatus); err != nil {
		// Propagate the raw error so errors.As(*pgconn.PgError) + the 23505
		// constraint-name check still fire in resolveOAuthUser. NOT wrapped
		// with extra context that could mask the PgError for the caller —
		// %w preserves the chain, which errors.As walks.
		return nil, fmt.Errorf("create oauth user with identity: insert user: %w", err)
	}

	if _, err := tx.Exec(ctx,
		`INSERT INTO oauth_identities (user_id, provider, subject) VALUES ($1, $2, $3)`,
		user.ID, provider, subject,
	); err != nil {
		return nil, fmt.Errorf("create oauth user with identity: insert identity: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("create oauth user with identity: commit: %w", err)
	}
	return user, nil
}
