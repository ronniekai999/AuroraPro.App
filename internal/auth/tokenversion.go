package auth

import (
	"context"
	"sync"
	"time"
)

// TokenVersionQuerier is the minimal contract TokenVersionStore needs.
// Defined here (not as *db.Queries directly) so tests can stub it without
// pulling in the whole DB layer.
type TokenVersionQuerier interface {
	GetUserTokenVersion(ctx context.Context, userID int64) (int, error)
}

// TokenVersionStore validates JWT token_version claims against the current
// per-user value in the database, with a small in-memory cache to avoid
// hitting the DB on every authenticated request.
//
// Cache lifecycle:
//   - Miss or expired: DB lookup, fill cache, return result.
//   - Hit & fresh: in-memory compare, no DB.
//   - Invalidate(userID): drop cache entry — next check refreshes from DB.
//     Called from ChangePassword after BumpUserTokenVersion, so a password
//     change invalidates every existing access token within microseconds
//     (next request triggers a refresh and finds the bumped version).
//
// Default TTL is short (60s) so a missed Invalidate (e.g. if an external
// process bumps the version) self-heals within the minute. For Aurora's
// scale (<100 users, <100 req/s typical) the per-user DB cost amortizes to
// negligible.
type TokenVersionStore struct {
	mu      sync.RWMutex
	cache   map[int64]versionEntry
	queries TokenVersionQuerier
	ttl     time.Duration
}

type versionEntry struct {
	version  int
	loadedAt time.Time
}

func NewTokenVersionStore(q TokenVersionQuerier) *TokenVersionStore {
	return &TokenVersionStore{
		cache:   make(map[int64]versionEntry),
		queries: q,
		ttl:     60 * time.Second,
	}
}

// Check returns true if claimVersion matches the current persisted version
// for userID. Fail-closed: any DB error returns false, since we cannot
// confidently say the token is valid.
func (s *TokenVersionStore) Check(ctx context.Context, userID int64, claimVersion int) bool {
	s.mu.RLock()
	e, ok := s.cache[userID]
	if ok && time.Since(e.loadedAt) < s.ttl {
		s.mu.RUnlock()
		return e.version == claimVersion
	}
	s.mu.RUnlock()

	v, err := s.queries.GetUserTokenVersion(ctx, userID)
	if err != nil {
		return false
	}
	s.mu.Lock()
	s.cache[userID] = versionEntry{version: v, loadedAt: time.Now()}
	s.mu.Unlock()
	return v == claimVersion
}

// Invalidate drops the cached version for userID so the next Check refreshes
// from the DB. Call after any operation that bumps token_version
// (ChangePassword, admin "log out all sessions", etc.).
func (s *TokenVersionStore) Invalidate(userID int64) {
	s.mu.Lock()
	delete(s.cache, userID)
	s.mu.Unlock()
}
