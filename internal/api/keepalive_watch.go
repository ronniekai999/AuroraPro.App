package api

import (
	"sync"
	"time"
)

// A client that keeps pinging a stream session the server no longer has is
// invisible in the logs. Each ping is one INFO request line among hundreds:
// the 2026-08-02 window recorded thirteen identical keepalive 404s across
// thirteen minutes with nothing to separate them from ordinary traffic.
//
// That pattern means a player stuck on a frozen frame. The session died — a
// restart drops every one of them — and the client never noticed. The current
// SPA handles it (the first 404 tears down the ticker and rebuilds), but a tab
// loaded before that shipped runs the old bundle until it is reloaded, and
// cached or third-party clients always will. The server has to be able to say
// so on its own.
//
// ONE 404 is not the signal. It is the normal way a client learns its session
// is gone, and every viewer gets one after a restart. Only a client that keeps
// going after being told is stuck.

const (
	// staleKeepaliveThreshold is how many 404s in a row for one session ID
	// count as stuck. The player pings every 10 s — 60 s once the tab is
	// backgrounded and the browser throttles its timers — so three is 30 s
	// to 3 min of a client ignoring the answer. Well past any restart race,
	// well short of letting a genuinely stuck player sit unreported.
	staleKeepaliveThreshold = 3

	// staleKeepaliveTTL forgets a session ID that has gone quiet, so a
	// client that did stop stops holding a slot.
	staleKeepaliveTTL = 15 * time.Minute

	// staleKeepaliveMaxTracked bounds the map. Session IDs come from the URL
	// path, so any authenticated client can mint unlimited distinct ones —
	// this is a diagnostic, and a diagnostic must not become a way to grow
	// server memory.
	staleKeepaliveMaxTracked = 512
)

type staleKeepaliveEntry struct {
	misses int
	warned bool
	seen   time.Time
}

// staleKeepaliveWatcher counts consecutive keepalive 404s per session ID and
// reports the single moment worth a log line: the ping that crosses the
// threshold. The zero value is ready to use.
type staleKeepaliveWatcher struct {
	mu      sync.Mutex
	entries map[string]*staleKeepaliveEntry
}

// miss records a 404 for sessionID and reports whether THIS ping is the one to
// log. It returns true at most once per tracked session — the point is to name
// a stuck client, not to re-report it every 10 s, which would recreate the
// noise it exists to cut through.
func (w *staleKeepaliveWatcher) miss(sessionID string, now time.Time) (misses int, warn bool) {
	w.mu.Lock()
	defer w.mu.Unlock()

	if w.entries == nil {
		w.entries = make(map[string]*staleKeepaliveEntry)
	}

	e, tracked := w.entries[sessionID]
	if !tracked {
		if len(w.entries) >= staleKeepaliveMaxTracked {
			w.sweepLocked(now)
		}
		if len(w.entries) >= staleKeepaliveMaxTracked {
			// Full of live entries. Losing the diagnostic is the right trade
			// against unbounded growth, and the request itself is unaffected
			// — the caller still answers 404 either way.
			return 0, false
		}
		e = &staleKeepaliveEntry{}
		w.entries[sessionID] = e
	}

	e.misses++
	e.seen = now
	if e.misses >= staleKeepaliveThreshold && !e.warned {
		e.warned = true
		return e.misses, true
	}
	return e.misses, false
}

// alive drops a session ID that answered successfully, so a run of misses
// cannot carry across a session ID that turns out to be live after all.
func (w *staleKeepaliveWatcher) alive(sessionID string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	delete(w.entries, sessionID)
}

// sweepLocked drops entries no ping has touched within the TTL. Called only
// when the map is at capacity, so the common path stays O(1).
func (w *staleKeepaliveWatcher) sweepLocked(now time.Time) {
	for id, e := range w.entries {
		if now.Sub(e.seen) > staleKeepaliveTTL {
			delete(w.entries, id)
		}
	}
}
