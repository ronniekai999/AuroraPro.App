package watchparty

import (
	"errors"
	"testing"
)

// Zero-value SafeConn (what tests construct as &SafeConn{}) must be safe:
// Send discards, Close is a no-op, and both are idempotent.
func TestSafeConn_ZeroValueIsSafe(t *testing.T) {
	sc := &SafeConn{}
	if err := sc.Send([]byte("x")); err != nil {
		t.Errorf("zero-value Send should discard and return nil, got %v", err)
	}
	if err := sc.Close(); err != nil {
		t.Errorf("zero-value Close should be a no-op, got %v", err)
	}
	if err := sc.Close(); err != nil {
		t.Errorf("second Close should be a no-op, got %v", err)
	}
	if err := sc.Send([]byte("x")); err != nil {
		t.Errorf("Send after Close on zero-value conn should still discard, got %v", err)
	}
}

// Send must never block: when the outbox is full (peer not draining), the
// conn is closed and ErrConnClosed returned, so broadcast loops holding
// ps.mu can't be stalled by one slow peer.
func TestSafeConn_SendOverflowClosesConn(t *testing.T) {
	// Hand-built conn with a tiny queue and NO pump goroutine — simulates
	// a peer whose pump is wedged on a dead socket (nothing drains).
	sc := &SafeConn{
		outbox: make(chan []byte, 2),
		done:   make(chan struct{}),
	}

	if err := sc.Send([]byte("1")); err != nil {
		t.Fatalf("send 1: %v", err)
	}
	if err := sc.Send([]byte("2")); err != nil {
		t.Fatalf("send 2: %v", err)
	}
	// Queue full — this Send must not block; it closes the conn instead.
	if err := sc.Send([]byte("3")); !errors.Is(err, ErrConnClosed) {
		t.Fatalf("overflow Send = %v, want ErrConnClosed", err)
	}

	// The conn is now closed: subsequent sends fail fast.
	if err := sc.Send([]byte("4")); !errors.Is(err, ErrConnClosed) {
		t.Errorf("Send after overflow-close = %v, want ErrConnClosed", err)
	}
	select {
	case <-sc.done:
		// closed as expected
	default:
		t.Error("overflow should have closed the done channel")
	}
}

// Send after an explicit Close returns ErrConnClosed without panicking,
// and Close stays idempotent.
func TestSafeConn_SendAfterCloseFails(t *testing.T) {
	sc := &SafeConn{
		outbox: make(chan []byte, 4),
		done:   make(chan struct{}),
	}
	if err := sc.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	if err := sc.Close(); err != nil {
		t.Errorf("second close should be a no-op, got %v", err)
	}
	if err := sc.Send([]byte("x")); !errors.Is(err, ErrConnClosed) {
		t.Errorf("Send after Close = %v, want ErrConnClosed", err)
	}
}
