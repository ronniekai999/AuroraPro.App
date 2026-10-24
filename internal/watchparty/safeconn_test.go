package watchparty

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// A party socket has two writers: its write pump (ticks, broadcasts) and the
// handler's read loop, which answers time-sync probes and errors with a
// direct write. Both set a write deadline first, and gorilla stores the
// deadline in a plain field that WriteMessage reads, so the deadline must be
// set under the same mutex as the writes or the two goroutines race on it.
// A running party exercises this constantly: ticks every 250ms against the
// time-sync burst on every sync connect and a probe every 30s.
//
// This test guards the fix ONLY under the race detector. Without -race it
// passes whether or not SetWriteDeadline takes the lock: a torn deadline read
// is possible but nothing here can observe it. CI pins the fix through its
// "Race (watchparty)" step (.github/workflows/ci.yml), not the plain
// `go test ./...` step. Run it locally as:
//
//	go test -race -count=1 -run TestSafeConn_DeadlineDoesNotRaceConcurrentWrites ./internal/watchparty/
//
// With the lock removed, that reports a data race in gorilla's
// SetWriteDeadline against a concurrent WriteMessage.
func TestSafeConn_DeadlineDoesNotRaceConcurrentWrites(t *testing.T) {
	upgrader := websocket.Upgrader{}
	accepted := make(chan *websocket.Conn, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		accepted <- c
	}))
	defer srv.Close()

	client, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer client.Close()
	go func() {
		for {
			if _, _, err := client.ReadMessage(); err != nil {
				return
			}
		}
	}()

	var sc *SafeConn
	select {
	case c := <-accepted:
		sc = NewSafeConn(c)
	case <-time.After(5 * time.Second):
		t.Fatal("no server connection")
	}
	defer sc.Close()

	const rounds = 200
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { // the write pump's traffic
		defer wg.Done()
		for i := 0; i < rounds; i++ {
			if err := sc.Send([]byte(`{"type":"tick"}`)); err != nil {
				t.Errorf("send %d: %v", i, err)
				return
			}
			time.Sleep(100 * time.Microsecond)
		}
	}()
	go func() { // the read loop's direct replies (sendErr, time-sync-response)
		defer wg.Done()
		for i := 0; i < rounds; i++ {
			_ = sc.SetWriteDeadline(time.Now().Add(partyTestWriteWait))
			if err := sc.WriteMessage(websocket.TextMessage, []byte(`{"type":"time-sync-response"}`)); err != nil {
				t.Errorf("direct write %d: %v", i, err)
				return
			}
		}
	}()
	wg.Wait()
}

const partyTestWriteWait = 10 * time.Second

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
