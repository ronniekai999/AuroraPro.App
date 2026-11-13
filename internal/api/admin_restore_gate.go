package api

// The routes that make or change sessions and credentials are closed while a
// restore's transaction may run.
//
// The transaction holds a lock on every table it dropped, and a query that
// meets one waits; once the restore commits it goes on, against the RESTORED
// data, with whatever it read before (PostgreSQL looks the table up again
// after the wait). A sign-in that read its user before the wipe and inserted
// its session after the commit got a working session in the restored database
// under the OLD database's user id, which after a restore from another
// install's backup can be someone else; a password change, a PIN write or a
// role change by id would land the same way. The restore ends the sessions
// waiting on it just before its COMMIT (restoreEndWaitersSQL), but one that
// starts waiting in the moment between would still land, so these routes do
// not wait at all: from just before the transaction begins until the restore
// ends they answer 503 `restore_running`, and the restore first waits (at
// most restoreSessionDrain) for the requests already past this gate.
//
// Closed: password sign-in, registration, refresh, the OAuth callback (sign-in
// and linking), the device pairing poll (which inserts the device's session)
// and approval, password change, unlinking a sign-in identity, PIN writes and
// role changes. Other writes keyed by ids (progress, lists, a scan's inserts)
// are left to the end-of-restore termination; see docs/backup-restore.md.

import (
	"context"
	"net/http"
	"sync"
	"time"
)

// restoreSessionDrain bounds the restore's wait for the requests already past
// the gate. An OAuth callback's provider round trip is the slow one.
const restoreSessionDrain = 10 * time.Second

// restoreRunningReason is the `error.reason` of a refusal while a restore
// runs; the web app words it (lib/failureWords, AuthView).
const restoreRunningReason = "restore_running"

// restoreSessionGate counts the requests that are past it and refuses new
// ones while it is shut. The zero value is open.
type restoreSessionGate struct {
	mu       sync.Mutex
	shut     bool
	inFlight int
	// drained, while the gate is shutting with requests still past it, is
	// closed when the last of them leaves.
	drained chan struct{}
}

// enter lets a request past the gate, or answers false while it is shut.
func (g *restoreSessionGate) enter() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.shut {
		return false
	}
	g.inFlight++
	return true
}

func (g *restoreSessionGate) leave() {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.inFlight--
	if g.inFlight == 0 && g.drained != nil {
		close(g.drained)
		g.drained = nil
	}
}

// shutAndDrain shuts the gate and waits, up to wait or until ctx ends, for
// the requests already past it. It answers whether they all left; the gate
// stays shut either way until open.
func (g *restoreSessionGate) shutAndDrain(ctx context.Context, wait time.Duration) bool {
	g.mu.Lock()
	g.shut = true
	if g.inFlight == 0 {
		g.mu.Unlock()
		return true
	}
	if g.drained == nil {
		g.drained = make(chan struct{})
	}
	drained := g.drained
	g.mu.Unlock()
	timer := time.NewTimer(wait)
	defer timer.Stop()
	select {
	case <-drained:
		return true
	case <-timer.C:
	case <-ctx.Done():
	}
	return false
}

// open lets requests past again.
func (g *restoreSessionGate) open() {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.shut = false
}

// guard is middleware for a route the gate closes: refuse answers a request
// that comes while it is shut.
func (g *restoreSessionGate) guard(refuse http.HandlerFunc) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !g.enter() {
				refuse(w, r)
				return
			}
			defer g.leave()
			next.ServeHTTP(w, r)
		})
	}
}

// guardJSON is guard with the API's JSON refusal.
func (g *restoreSessionGate) guardJSON() func(http.Handler) http.Handler {
	return g.guard(refuseWhileRestoring)
}

// refuseWhileRestoring is the JSON answer of a closed route.
func refuseWhileRestoring(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Retry-After", "60")
	writeErrorReason(w, http.StatusServiceUnavailable, restoreRunningReason,
		"a database restore is running; signing in and changes to sign-in details are paused until it ends")
}
