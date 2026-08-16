package db

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// OAuth transaction store (migration 057).
//
// The OAuth round-trip needs to carry two pieces of server state across a
// redirect the client fully controls: in LINK mode, which user the new
// provider identity attaches to; in LOGIN mode, which invite_codes row a
// pre-flight claim reserved. Both used to ride in cookies as bare row ids,
// which made them forgeable — see migration 057 for the takeover this enabled.
//
// Now Start writes a row here and hands the client only an opaque token; the
// callback consumes the row to recover the ids. Nothing the client sends is
// trusted beyond its ability to name a row that the server itself wrote.

// ErrOAuthTxnNotFound is returned by ConsumeOAuthTransaction when no row is
// live for the supplied token hash: unknown token, already consumed, or past
// expiry. The three are deliberately indistinguishable to the caller so a
// forged token cannot be used to probe which ids exist.
var ErrOAuthTxnNotFound = errors.New("oauth transaction not found, already used, or expired")

// OAuthTxnMode names the two flows a transaction can belong to.
type OAuthTxnMode string

const (
	// OAuthTxnModeLogin is a login/signup flow. UserID is nil; InviteID may
	// carry a pre-flight invite claim.
	OAuthTxnModeLogin OAuthTxnMode = "login"
	// OAuthTxnModeLink is an authenticated link flow. UserID is the account
	// the provider identity attaches to, captured at Start from a verified
	// session — never from anything the client sends at callback time.
	OAuthTxnModeLink OAuthTxnMode = "link"
)

// OAuthTransaction is a consumed transaction row. Provider and State are
// returned so the caller can re-verify the transaction was minted for the
// exact flow now completing.
type OAuthTransaction struct {
	ID       int64
	Mode     OAuthTxnMode
	Provider string
	State    string
	UserID   *int64
	InviteID *int64
}

// CreateOAuthTransaction inserts a transaction row keyed by tokenHash (the
// SHA-256 of the opaque token the caller hands the client — the raw token is
// never stored, so a database read yields nothing replayable).
//
// userID must be non-nil for link mode; the table's check constraint enforces
// that independently, but failing here gives a clearer error than a constraint
// violation.
func (q *Queries) CreateOAuthTransaction(
	ctx context.Context,
	tokenHash []byte,
	mode OAuthTxnMode,
	provider, state string,
	userID, inviteID *int64,
	ttl time.Duration,
) (int64, error) {
	switch mode {
	case OAuthTxnModeLogin, OAuthTxnModeLink:
	default:
		return 0, fmt.Errorf("create oauth transaction: unknown mode %q", mode)
	}
	if mode == OAuthTxnModeLink && userID == nil {
		return 0, errors.New("create oauth transaction: link mode requires a user id")
	}
	if len(tokenHash) == 0 {
		return 0, errors.New("create oauth transaction: empty token hash")
	}
	if state == "" || provider == "" {
		return 0, errors.New("create oauth transaction: provider and state are required")
	}

	// The deadline is computed from the DATABASE clock, matching the
	// consume/sweep queries. Deriving it from the application clock instead
	// would let a skewed app host widen the real window, since only the
	// comparison side runs in SQL.
	var id int64
	err := q.pool.QueryRow(ctx,
		`INSERT INTO oauth_transactions
		     (token_hash, mode, provider, state, user_id, invite_id, expires_at)
		 VALUES ($1, $2, $3, $4, $5, $6, NOW() + make_interval(secs => $7))
		 RETURNING id`,
		tokenHash, string(mode), provider, state, userID, inviteID, ttl.Seconds(),
	).Scan(&id)
	if err != nil {
		return 0, fmt.Errorf("create oauth transaction: %w", err)
	}
	return id, nil
}

// ConsumeOAuthTransaction atomically marks the transaction single-use-consumed
// and returns it. The UPDATE ... WHERE consumed_at IS NULL RETURNING shape is
// what makes replay impossible: two concurrent callbacks race on the same row
// and exactly one sees a returned row, because the loser's predicate no longer
// holds once the winner commits.
//
// Expiry is evaluated in the database (NOW()), and CreateOAuthTransaction
// computes the deadline the same way, so both ends of the window sit on the
// database clock and a skewed application host cannot widen it.
//
// Returns ErrOAuthTxnNotFound when nothing was live to consume. The caller must
// treat that as a hard failure — this is the path a forged token lands on.
func (q *Queries) ConsumeOAuthTransaction(ctx context.Context, tokenHash []byte) (*OAuthTransaction, error) {
	if len(tokenHash) == 0 {
		return nil, ErrOAuthTxnNotFound
	}
	var (
		txn  OAuthTransaction
		mode string
	)
	err := q.pool.QueryRow(ctx,
		`UPDATE oauth_transactions
		    SET consumed_at = NOW()
		  WHERE token_hash = $1
		    AND consumed_at IS NULL
		    AND expires_at > NOW()
		RETURNING id, mode, provider, state, user_id, invite_id`,
		tokenHash,
	).Scan(&txn.ID, &mode, &txn.Provider, &txn.State, &txn.UserID, &txn.InviteID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrOAuthTxnNotFound
		}
		return nil, fmt.Errorf("consume oauth transaction: %w", err)
	}
	txn.Mode = OAuthTxnMode(mode)
	return &txn, nil
}

// DeleteExpiredOAuthTransactions removes rows past expiry. Consumed rows are
// left until they expire so a replay attempt within the window still finds the
// row absent-or-consumed rather than absent-because-swept — the outcome is the
// same either way, but keeping them makes the consumed_at timestamp available
// for incident review. Returns the number of rows removed.
func (q *Queries) DeleteExpiredOAuthTransactions(ctx context.Context) (int64, error) {
	tag, err := q.pool.Exec(ctx,
		`DELETE FROM oauth_transactions WHERE expires_at <= NOW()`)
	if err != nil {
		return 0, fmt.Errorf("delete expired oauth transactions: %w", err)
	}
	return tag.RowsAffected(), nil
}
