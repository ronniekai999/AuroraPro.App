package api

import (
	"fmt"
	"net/http"
	"sort"
	"sync"
	"time"
)

// In-flight request tracking, for diagnosing shutdown stalls.
//
// http.Server.Shutdown waits for active handlers to return. On this server it
// timed out at exactly 10.000s on every observed occurrence (2026-07-19,
// three times), and the request log could not say what it was waiting for:
// RequestLogger emits its line AFTER the handler returns, so a request still
// running at shutdown produces no log line at all. The evidence was
// structurally absent.
//
// This registry closes that gap. It is not a fix — it is the instrument that
// tells us whether the 10s budget is simply too short for legitimate work
// (a multi-gigabyte direct-play range request is the leading hypothesis:
// those are not stopped by StopAllSessions and were observed at 31s) or
// whether some handler never returns at all. Guessing between those two
// leads to opposite fixes, so measure first.
//
// Cost is one map insert/delete and a mutex per request. Hijacked connections
// (WebSockets) are included for completeness even though Shutdown does not
// wait for them — knowing they were open is still useful context.

// InFlightRegistry tracks currently-executing HTTP handlers.
type InFlightRegistry struct {
	mu   sync.Mutex
	seq  uint64
	reqs map[uint64]inFlightReq
}

type inFlightReq struct {
	method  string
	path    string
	started time.Time
}

// NewInFlightRegistry returns an empty registry.
func NewInFlightRegistry() *InFlightRegistry {
	return &InFlightRegistry{reqs: make(map[uint64]inFlightReq)}
}

func (reg *InFlightRegistry) add(method, path string) uint64 {
	reg.mu.Lock()
	defer reg.mu.Unlock()
	reg.seq++
	id := reg.seq
	reg.reqs[id] = inFlightReq{method: method, path: path, started: time.Now()}
	return id
}

func (reg *InFlightRegistry) done(id uint64) {
	reg.mu.Lock()
	delete(reg.reqs, id)
	reg.mu.Unlock()
}

// Count returns the number of handlers currently executing.
func (reg *InFlightRegistry) Count() int {
	reg.mu.Lock()
	defer reg.mu.Unlock()
	return len(reg.reqs)
}

// Snapshot renders the outstanding requests longest-running first, for a
// single log attribute. Bounded to the worst offenders — during a shutdown
// stall the long ones are the story, and an unbounded dump could be enormous.
func (reg *InFlightRegistry) Snapshot() string {
	const maxListed = 10

	reg.mu.Lock()
	items := make([]inFlightReq, 0, len(reg.reqs))
	for _, rq := range reg.reqs {
		items = append(items, rq)
	}
	reg.mu.Unlock()

	if len(items) == 0 {
		return "none"
	}
	sort.Slice(items, func(i, j int) bool {
		return items[i].started.Before(items[j].started)
	})

	now := time.Now()
	out := fmt.Sprintf("%d in flight:", len(items))
	for i, rq := range items {
		if i >= maxListed {
			out += fmt.Sprintf(" …+%d more", len(items)-maxListed)
			break
		}
		out += fmt.Sprintf(" [%s %s %s]",
			rq.method, rq.path, now.Sub(rq.started).Round(time.Millisecond))
	}
	return out
}

// TrackInFlight is middleware that registers each request for the duration of
// its handler. Install it OUTSIDE RequestLogger so the window it measures
// covers the same span the server's shutdown is waiting on.
func TrackInFlight(reg *InFlightRegistry) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			id := reg.add(r.Method, r.URL.Path)
			defer reg.done(id)
			next.ServeHTTP(w, r)
		})
	}
}
