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
type RingBufferHandler struct {
	inner  slog.Handler
	state  *ringState
	attrs  []slog.Attr
	groups []string
}

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

	s := h.state
	s.mu.Lock()
	s.buf[s.head] = entry
	s.head = (s.head + 1) % s.size
	if s.count < s.size {
		s.count++
	}
	s.mu.Unlock()

	return h.inner.Handle(ctx, r)
}

func (h *RingBufferHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	combined := make([]slog.Attr, len(h.attrs), len(h.attrs)+len(attrs))
	copy(combined, h.attrs)
	combined = append(combined, attrs...)

	return &RingBufferHandler{
		inner:  h.inner.WithAttrs(attrs),
		state:  h.state, // shared pointer — same lock and buffer
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
		attrs:  h.attrs,
		groups: groups,
	}
}

// Entries returns log entries from the ring buffer, newest first.
// limit controls the maximum number of entries returned.
// offset skips that many of the newest entries before collecting.
func (h *RingBufferHandler) Entries(limit, offset int) []models.LogEntry {
	s := h.state
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
