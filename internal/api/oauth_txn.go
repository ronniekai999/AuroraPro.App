package api

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/aurora-media/aurora/internal/auth"
	"github.com/aurora-media/aurora/internal/db"
)

// Opaque OAuth transaction cookie — the replacement for the two forgeable
// id-carrying cookies (aurora_oauth_link_uid, aurora_oauth_invite_claim).
//
// The threat those cookies missed: HttpOnly is a read restriction on page
// JavaScript, not an integrity guarantee. Anybody can put whatever they like in
// a Cookie header on a request they craft, so a cookie whose VALUE is a
// database id is a cookie whose value is a request parameter. Trusting
// `aurora_oauth_link_uid` meant a caller could run their own provider sign-in
// while naming a victim's user id and have their OAuth identity attached to
// that victim — after which signing in "as themselves" logged them into the
// victim's account, administrators included.
//
// Here the cookie carries a 256-bit random token and nothing else. It names a
// row the SERVER wrote at Start; every authorization-relevant field (which
// user, which invite, which provider, which state, when it expires) is read
// back from that row. Forging the cookie now requires guessing the token.

const (
	// oauthTxnCookieName carries the opaque transaction token across the
	// provider round-trip. Path-scoped to the OAuth routes, HttpOnly, and
	// single-use-cleared by the callback.
	oauthTxnCookieName = "aurora_oauth_txn"

	// oauthTxnTokenBytes is the entropy in the opaque token. 32 bytes puts
	// guessing far out of reach of the 10-minute window the row lives for.
	oauthTxnTokenBytes = 32
)

// generateOAuthTxnToken returns a fresh URL-safe opaque token. The raw value is
// handed to the client exactly once (as the cookie) and never persisted.
func generateOAuthTxnToken() (string, error) {
	b := make([]byte, oauthTxnTokenBytes)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// hashOAuthTxnToken maps a token to the digest stored in oauth_transactions.
// The token is high-entropy and random, so a plain SHA-256 is appropriate — the
// reason to hash at all is that a database read (backup, replica, SQL-injection
// elsewhere) should not yield tokens that can be replayed while still live.
func hashOAuthTxnToken(token string) []byte {
	sum := sha256.Sum256([]byte(token))
	return sum[:]
}

// setOAuthTxnCookie writes the transaction cookie with the same scope and
// lifetime as the state cookie — the two must complete together, and an orphan
// of either is useless on its own.
func (h *OAuthHandler) setOAuthTxnCookie(w http.ResponseWriter, r *http.Request, token string) {
	http.SetCookie(w, &http.Cookie{
		Name:     oauthTxnCookieName,
		Value:    token,
		Path:     "/api/auth/oauth/",
		MaxAge:   oauthStateCookieMaxAge,
		HttpOnly: true,
		Secure:   cookieSecureFor(r, h.secureCookies),
		SameSite: http.SameSiteLaxMode,
	})
}

// oauthTxnExpiry is the row's server-side deadline. It matches the state
// cookie's MaxAge, but it is the row — checked in SQL against the database
// clock — that actually bounds the flow; the cookie MaxAge is only a hint the
// client is free to ignore.
func oauthTxnExpiry() time.Time {
	return time.Now().Add(time.Duration(oauthStateCookieMaxAge) * time.Second)
}

// startOAuthTxn mints a transaction row and sets the cookie. Callers pass the
// state they just generated so the callback can bind the two together.
//
// A failure here is fatal to the flow by design: continuing without a
// transaction would silently drop the link target or the invite claim, and for
// link mode "silently became a login" is precisely the confusion an attacker
// wants.
func (h *OAuthHandler) startOAuthTxn(
	ctx context.Context,
	w http.ResponseWriter,
	r *http.Request,
	mode db.OAuthTxnMode,
	provider, state string,
	userID, inviteID *int64,
) error {
	token, err := generateOAuthTxnToken()
	if err != nil {
		return err
	}
	if _, err := h.queries.CreateOAuthTransaction(
		ctx, hashOAuthTxnToken(token), mode, provider, state, userID, inviteID, oauthTxnExpiry(),
	); err != nil {
		return err
	}
	h.setOAuthTxnCookie(w, r, token)
	return nil
}

// oauthTxnOutcome is what the callback learned from the transaction cookie.
type oauthTxnOutcome struct {
	// IsLink marks a link flow; LinkUID is then the account to attach to.
	IsLink  bool
	LinkUID int64
	// InviteClaimID is the pre-flight invite claim for a login flow, or 0.
	InviteClaimID int64
}

// consumeOAuthTxn reads, clears, and single-use-consumes the transaction
// cookie, then re-verifies that the row was minted for THIS provider and THIS
// state.
//
// Returns (outcome, true) on success, including the "no cookie at all" case —
// a plain OAuth login with no invite legitimately has no transaction, and gets
// a zero-valued outcome.
//
// Returns (_, false) after rendering an error page whenever a cookie IS present
// but does not resolve to a live, matching row. Failing closed is the point: a
// forged or replayed token must abort the flow, never degrade into "continue as
// an ordinary login", because for a link flow that would silently discard the
// safety check and for an invite flow it would leak a free signup.
func (h *OAuthHandler) consumeOAuthTxn(
	w http.ResponseWriter,
	r *http.Request,
	providerName, state string,
) (oauthTxnOutcome, bool) {
	var out oauthTxnOutcome

	c, err := r.Cookie(oauthTxnCookieName)
	if err != nil || c.Value == "" {
		// No transaction: ordinary login, nothing to recover.
		return out, true
	}
	// Single-use at the cookie layer too, so a failed attempt cannot be
	// retried from the same browser without a fresh Start.
	h.clearOAuthCookie(w, r, oauthTxnCookieName)

	txn, cerr := h.queries.ConsumeOAuthTransaction(r.Context(), hashOAuthTxnToken(c.Value))
	if cerr != nil {
		if errors.Is(cerr, db.ErrOAuthTxnNotFound) {
			// Unknown, already-consumed, or expired — indistinguishable on
			// purpose. This is where a forged token lands.
			slog.Warn("oauth callback: transaction not live", "provider", providerName)
			h.renderError(w, "Your sign-in session expired or was already used. Please start again.")
			return out, false
		}
		slog.Error("oauth callback: consume transaction", "provider", providerName, "error", cerr)
		h.renderError(w, "Authentication failed. Please try again.")
		return out, false
	}

	// Bind the transaction to the flow actually completing. The state cookie
	// was already matched against the query parameter by the caller; requiring
	// the ROW to carry that same state stops a transaction minted for one flow
	// from being spliced into another, and the provider check stops a
	// transaction for provider A completing on provider B's callback.
	if txn.Provider != providerName ||
		subtle.ConstantTimeCompare([]byte(txn.State), []byte(state)) != 1 {
		slog.Warn("oauth callback: transaction does not match this flow",
			"provider", providerName, "txn_provider", txn.Provider)
		h.renderError(w, "Authentication failed: mismatched sign-in session. Please try again.")
		return out, false
	}

	switch txn.Mode {
	case db.OAuthTxnModeLink:
		if txn.UserID == nil || *txn.UserID <= 0 {
			// The table's check constraint makes this unreachable; treat it as
			// corruption rather than falling through to a login.
			slog.Error("oauth callback: link transaction has no user", "provider", providerName, "txn_id", txn.ID)
			h.renderError(w, "Could not link the account. Please try again.")
			return out, false
		}
		out.IsLink = true
		out.LinkUID = *txn.UserID
	case db.OAuthTxnModeLogin:
		if txn.InviteID != nil && *txn.InviteID > 0 {
			out.InviteClaimID = *txn.InviteID
		}
	default:
		slog.Error("oauth callback: unknown transaction mode", "provider", providerName, "mode", string(txn.Mode))
		h.renderError(w, "Authentication failed. Please try again.")
		return out, false
	}
	return out, true
}

// linkSessionMatches reports whether the caller currently holds a live session
// for linkUID.
//
// The transaction row already makes linkUID unforgeable, so this is the second
// of two independent controls rather than the only one. It covers the case the
// row cannot: somebody who obtained a live transaction token out of band (a
// shared machine, a leaked URL-bar history, a proxy log) still cannot complete
// the link without also holding the account's session.
//
// It fails CLOSED. The previous code checked the access cookie only when one
// happened to be present and valid, and treated absent-or-expired as "trust the
// cookie" — which, given the cookie was the forgeable uid, meant an
// unauthenticated caller passed the check by simply not sending a session.
//
// Both cookies are visible here: the access cookie is Path=/ and the refresh
// cookie is Path=/api/auth, which the callback path sits under. The refresh
// fallback exists because access tokens are short-lived (15 minutes by default)
// against a 10-minute OAuth window, so an otherwise-valid link would otherwise
// fail whenever the token aged out mid-round-trip.
func (h *OAuthHandler) linkSessionMatches(ctx context.Context, r *http.Request, linkUID int64) bool {
	if c, err := r.Cookie(auth.AccessCookieName); err == nil && c.Value != "" {
		if claims, verr := h.authSvc.ValidateAccessToken(c.Value); verr == nil {
			// A narrow-scoped token (e.g. a cast token) authenticates a device
			// for playback, not an account-management action like linking.
			if claims.Scope != "" {
				return false
			}
			if claims.UserID != linkUID {
				return false
			}
			// Honour a password change that landed mid-flow: the middleware
			// checks token_version on every other authenticated route, and a
			// link is not a weaker action than those.
			return h.tokenVersionCurrent(ctx, linkUID, claims.TokenVersion)
		}
		// Present but unverifiable (expired or tampered) — fall through to the
		// refresh cookie rather than rejecting outright.
	}

	if c, err := r.Cookie(auth.RefreshCookieName); err == nil && c.Value != "" {
		// GetRefreshToken already filters revoked and expired rows, and a
		// password change revokes a user's refresh tokens.
		rt, rerr := h.queries.GetRefreshToken(ctx, c.Value)
		if rerr != nil {
			slog.Error("oauth link callback: refresh lookup", "user_id", linkUID, "error", rerr)
			return false
		}
		if rt != nil && rt.UserID == linkUID {
			return true
		}
	}
	return false
}

// tokenVersionCurrent compares a token's stamped version against the user's
// persisted one. A load failure is treated as "not current" so the link fails
// closed rather than open.
func (h *OAuthHandler) tokenVersionCurrent(ctx context.Context, userID int64, claimVersion int) bool {
	user, err := h.queries.GetUserByID(ctx, userID)
	if err != nil {
		slog.Error("oauth link callback: load user for token version", "user_id", userID, "error", err)
		return false
	}
	if user == nil {
		return false
	}
	return user.TokenVersion == claimVersion
}
