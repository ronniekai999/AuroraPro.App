package logging

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/aurora-media/aurora/internal/models"
)

// ringState holds the shared mutable state for the ring buffer.
// All RingBufferHandler instances derived via WithAttrs/WithGroup share
// a single *ringState, ensuring they use the same lock and position data.
type ringState struct {
	mu    sync.Mutex
	buf   []models.LogEntry
	size  int
	head  int // next write position
	count int // number of entries currently stored
}

// RingBufferHandler wraps another slog.Handler and stores log entries
// in a bounded ring buffer for the admin API to serve.
//
// There are TWO rings, and the second one is the point.
//
// The single 1000-entry ring could only ever show the most recent slice of
// history, and at Aurora's log rate that slice is tiny: measured against two
// weeks of production logs, 1000 entries covered 17 minutes when idle and
// 3.6 minutes at its busiest. Since ~95% of lines are INFO request logs, any
// WARN or ERROR scrolled out of reach within minutes — the admin Logs page
// essentially could not show you an error unless you happened to be looking
// when it happened.
//
// Filtering the main ring by level does not fix that: the entries are already
// gone. So problem lines get their own ring, which they fill far more slowly.
// The same two weeks produced 1,290 WARN + 70 ERROR = 1,360 entries total, so
// a ring of warnRingSize holds roughly the whole retention window rather than
// minutes of it.
type RingBufferHandler struct {
	inner slog.Handler
	state *ringState
	// warn holds only WARN and above. Same structure, separate residency.
	warn   *ringState
	attrs  []slog.Attr
	groups []string
}

// warnRingSize is deliberately generous relative to the main ring: WARN+ERROR
// is a small fraction of total volume (0.26% in the observed window), so this
// buys days-to-weeks of problem history for a fraction of a megabyte.
const warnRingSize = 2000

func NewRingBufferHandler(inner slog.Handler, size int) *RingBufferHandler {
	if size <= 0 {
		size = 1000
	}
	return &RingBufferHandler{
		inner: inner,
		state: &ringState{
			buf:  make([]models.LogEntry, size),
			size: size,
		},
		warn: &ringState{
			buf:  make([]models.LogEntry, warnRingSize),
			size: warnRingSize,
		},
	}
}

func (h *RingBufferHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.inner.Enabled(ctx, level)
}

func (h *RingBufferHandler) Handle(ctx context.Context, r slog.Record) error {
	attrs := make(map[string]interface{})

	// Collect pre-set attrs from WithAttrs/WithGroup calls
	for _, g := range h.groups {
		attrs["group"] = g
	}
	for _, a := range h.attrs {
		attrs[a.Key] = serializeAttrValue(a.Value.Any())
	}

	// Collect attrs from the record itself
	r.Attrs(func(a slog.Attr) bool {
		attrs[a.Key] = serializeAttrValue(a.Value.Any())
		return true
	})

	if len(attrs) == 0 {
		attrs = nil
	}

	entry := models.LogEntry{
		Time:    r.Time.UTC().Truncate(time.Millisecond),
		Level:   r.Level.String(),
		Message: r.Message,
		Attrs:   attrs,
	}

	appendEntry(h.state, entry)
	// Problem lines land in BOTH rings: the main one keeps chronological
	// context (what happened right before), the warn ring keeps them
	// reachable long after INFO volume has flushed the main ring.
	if r.Level >= slog.LevelWarn {
		appendEntry(h.warn, entry)
	}

	return h.inner.Handle(ctx, r)
}

func (h *RingBufferHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	combined := make([]slog.Attr, len(h.attrs), len(h.attrs)+len(attrs))
	copy(combined, h.attrs)
	combined = append(combined, attrs...)

	return &RingBufferHandler{
		inner:  h.inner.WithAttrs(attrs),
		state:  h.state, // shared pointer — same lock and buffer
		warn:   h.warn,  // ditto: a derived handler must feed the same rings
		attrs:  combined,
		groups: h.groups,
	}
}

func (h *RingBufferHandler) WithGroup(name string) slog.Handler {
	groups := make([]string, len(h.groups), len(h.groups)+1)
	copy(groups, h.groups)
	groups = append(groups, name)

	return &RingBufferHandler{
		inner:  h.inner.WithGroup(name),
		state:  h.state, // shared pointer — same lock and buffer
		warn:   h.warn,  // ditto: a derived handler must feed the same rings
		attrs:  h.attrs,
		groups: groups,
	}
}

// appendEntry pushes one entry into a ring. Split out so both rings share
// exactly one implementation of the wraparound bookkeeping.
func appendEntry(s *ringState, entry models.LogEntry) {
	s.mu.Lock()
	s.buf[s.head] = entry
	s.head = (s.head + 1) % s.size
	if s.count < s.size {
		s.count++
	}
	s.mu.Unlock()
}

// Entries returns log entries from the main ring, newest first.
// limit controls the maximum number of entries returned.
// offset skips that many of the newest entries before collecting.
func (h *RingBufferHandler) Entries(limit, offset int) []models.LogEntry {
	return readRing(h.state, limit, offset)
}

// ProblemEntries returns WARN-and-above entries, newest first, from the
// dedicated ring. Not a filtered view of Entries: by the time an operator
// goes looking, INFO volume has usually already evicted the problem lines
// from the main ring, so filtering it would return an empty list for
// incidents that are only minutes old.
func (h *RingBufferHandler) ProblemEntries(limit, offset int) []models.LogEntry {
	return readRing(h.warn, limit, offset)
}

func readRing(s *ringState, limit, offset int) []models.LogEntry {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.count == 0 || offset >= s.count {
		return nil
	}

	available := s.count - offset
	if limit <= 0 || limit > available {
		limit = available
	}

	result := make([]models.LogEntry, limit)
	// head-1 is the newest entry; walk backwards
	idx := (s.head - 1 - offset + s.size) % s.size
	for i := 0; i < limit; i++ {
		result[i] = s.buf[idx]
		idx = (idx - 1 + s.size) % s.size
	}

	return result
}

// serializeAttrValue converts slog attribute values into a form that
// JSON-encodes usefully on the API boundary. The default Value.Any()
// returns the bare Go type — for `error` interfaces that means the
// JSON encoder sees an interface with no exported fields and emits
// `{}`, dropping the actual message. QA BUG-011 fix: stringify
// errors here so the admin Logs UI can render them.
//
// Only the error case is touched; primitives and structs with
// exported fields keep their native shape so the UI can render
// them as it sees fit.
func serializeAttrValue(v interface{}) interface{} {
	if v == nil {
		return nil
	}
	if err, ok := v.(error); ok {
		return err.Error()
	}
	return v
}
