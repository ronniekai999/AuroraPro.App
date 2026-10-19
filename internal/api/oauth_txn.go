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

// oauthTxnTTL is the row's server-side lifetime. It matches the state cookie's
// MaxAge, but it is the row — whose deadline is computed AND compared against
// the database clock — that actually bounds the flow; the cookie MaxAge is only
// a hint the client is free to ignore.
//
// It is a duration rather than an absolute time on purpose: computing the
// deadline here would put it on the application clock while the consume query
// compares against the database clock, so a skewed app host would silently
// widen (or narrow) the real window. Both ends live in SQL instead.
func oauthTxnTTL() time.Duration {
	return time.Duration(oauthStateCookieMaxAge) * time.Second
}

// releaseStaleOAuthTxn consumes whatever transaction the caller's cookie still
// points at and releases any invite claim it was holding. It does NOT touch the
// cookie, so callers are free to mint a replacement immediately afterwards.
//
// EVERY new flow must call this, not just one that ends up without a
// transaction of its own. Overwriting the cookie orphans the previous row, and
// if that row held an invite claim the cookie was the only handle to it — the
// invite would sit at used_at-set/used_by-null until the hourly sweep noticed.
// "Enter code A, go back, enter code B" and "start an invited signup, then
// click Connect in Settings" both take that path.
//
// A consume failure is harmless and swallowed: the row is bound to a state this
// flow will not present, it expires on its own, and the sweep releases its
// claim. A release failure AFTER a successful consume is not harmless — the
// sweep skips consumed rows — so that one is logged rather than dropped, since
// it leaves an invite needing manual repair.
func (h *OAuthHandler) releaseStaleOAuthTxn(ctx context.Context, r *http.Request) {
	c, err := r.Cookie(oauthTxnCookieName)
	if err != nil || c.Value == "" {
		return
	}
	txn, cerr := h.queries.ConsumeOAuthTransaction(ctx, hashOAuthTxnToken(c.Value))
	if cerr != nil {
		return
	}
	if txn.InviteID != nil && *txn.InviteID > 0 {
		if uerr := h.queries.UnclaimInviteCode(ctx, *txn.InviteID); uerr != nil {
			slog.Error("oauth: could not release an abandoned invite claim; "+
				"the transaction is consumed so the sweep will not retry it",
				"invite_id", *txn.InviteID, "error", uerr)
		}
	}
}

// retireStaleOAuthTxn is releaseStaleOAuthTxn plus clearing the cookie, for
// callers that are abandoning the flow rather than replacing it.
func (h *OAuthHandler) retireStaleOAuthTxn(w http.ResponseWriter, r *http.Request) {
	h.releaseStaleOAuthTxn(r.Context(), r)
	h.clearOAuthCookie(w, r, oauthTxnCookieName)
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
		ctx, hashOAuthTxnToken(token), mode, provider, state, userID, inviteID, oauthTxnTTL(),
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

	// Past this point the row is CONSUMED, so every remaining failure must
	// release the invite claim itself. The sweep cannot clean up after these:
	// it deliberately skips consumed rows (their fate was decided here), so an
	// abandoned claim on one of these paths is stranded at
	// used_at-set/used_by-null with nothing left that can repair it.
	releaseClaim := func() {
		if txn.InviteID == nil || *txn.InviteID <= 0 {
			return
		}
		if uerr := h.queries.UnclaimInviteCode(r.Context(), *txn.InviteID); uerr != nil {
			// Same reasoning as releaseStaleOAuthTxn: the row is consumed, so
			// the sweep will not retry this. A silent failure here leaves an
			// invite needing manual repair with nothing recording that fact.
			slog.Error("oauth: could not release an invite claim after a failed binding check; "+
				"the transaction is consumed so the sweep will not retry it",
				"invite_id", *txn.InviteID, "provider", providerName, "error", uerr)
		}
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
		releaseClaim()
		h.renderError(w, "Authentication failed: mismatched sign-in session. Please try again.")
		return out, false
	}

	switch txn.Mode {
	case db.OAuthTxnModeLink:
		if txn.UserID == nil || *txn.UserID <= 0 {
			// The table's check constraint makes this unreachable; treat it as
			// corruption rather than falling through to a login.
			slog.Error("oauth callback: link transaction has no user", "provider", providerName, "txn_id", txn.ID)
			releaseClaim()
			h.renderError(w, "Could not link the account. Please try again.")
			return out, false
		}
		out.IsLink = true
		out.LinkUID = *txn.UserID
		// StartLink never sets an invite id, and the login-side release is
		// unreachable from the link branch (Callback returns straight into
		// handleLinkCallback). Release defensively so a future link path that
		// did carry one could not strand it.
		if txn.InviteID != nil && *txn.InviteID > 0 {
			slog.Warn("oauth: link transaction unexpectedly carried an invite claim; releasing it",
				"provider", providerName, "invite_id", *txn.InviteID)
			releaseClaim()
		}
	case db.OAuthTxnModeLogin:
		if txn.InviteID != nil && *txn.InviteID > 0 {
			out.InviteClaimID = *txn.InviteID
		}
	default:
		slog.Error("oauth callback: unknown transaction mode", "provider", providerName, "mode", string(txn.Mode))
		releaseClaim()
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
			// Belt-and-braces only: ValidateAccessToken already refuses a
			// scoped token (auth.go's Scope != "" check), so a cast token
			// lands in the verr != nil branch below rather than here. Kept so
			// the rule "a playback-scoped token cannot manage sign-in methods"
			// is enforced locally too if that validator ever loosens.
			if claims.Scope != "" {
				return false
			}
			if claims.UserID != linkUID {
				return false
			}
			// Honour a password change that landed mid-flow: the middleware
			// checks token_version on every other authenticated route, and a
			// link is not a weaker action than those.
			return h.tokenVersionCurrent(ctx, linkUID, claims.TokenVersion) &&
				h.linkSessionMayManage(ctx, linkUID, claims.RefreshTokenID)
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
			return h.linkSessionMayManage(ctx, linkUID, rt.ID)
		}
	}
	return false
}

// linkSessionMayManage reports whether the session a link started from may
// still manage sign-in methods: its row is live and its acting profile has no
// ceiling, as the link's start required (denyRestrictedSession). A PIN write
// ends a session by deleting its row, and its access token outlives that by
// up to a token lifetime, longer than a link's state window; without this, a
// session ended or restricted mid-link finished the link anyway, and on an
// account with no password that identity was a way in. Fails closed.
func (h *OAuthHandler) linkSessionMayManage(ctx context.Context, userID, refreshTokenID int64) bool {
	if refreshTokenID != 0 {
		live, err := h.queries.SessionLive(ctx, userID, refreshTokenID)
		if err != nil || !live {
			return false
		}
	}
	acting, err := h.queries.ResolveActingProfile(ctx, userID, refreshTokenID)
	return err == nil && acting != nil && acting.MaxAgeRating == ""
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
