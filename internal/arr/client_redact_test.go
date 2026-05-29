package arr

import (
	"context"
	"net"
	"strconv"
	"strings"
	"testing"
)

// TestDoRequest_TransportErrorRedactsURL covers MED finding 2: a transport
// failure must not leak the internal ARR host:port to the caller, because that
// error reaches a non-admin requester via request.error_message. The detailed
// URL is logged server-side instead.
func TestDoRequest_TransportErrorRedactsURL(t *testing.T) {
	// Bind a loopback listener to grab a free port, then close it so the port
	// is refused immediately — a deterministic, fast transport failure that
	// doesn't depend on DNS or the client's 30s timeout.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("failed to reserve a loopback port: %v", err)
	}
	addr := ln.Addr().(*net.TCPAddr)
	host := "127.0.0.1"
	port := strconv.Itoa(addr.Port)
	if cerr := ln.Close(); cerr != nil {
		t.Fatalf("failed to close listener: %v", cerr)
	}

	c := NewClient("http://"+host+":"+port, "secret-key")

	_, err = c.Get(context.Background(), "/api/v3/movie?tmdbId=123")
	if err == nil {
		t.Fatal("expected a transport error, got nil")
	}

	msg := err.Error()
	if strings.Contains(msg, port) {
		t.Errorf("client-facing error leaks internal port %q: %q", port, msg)
	}
	if strings.Contains(msg, host) {
		t.Errorf("client-facing error leaks internal host %q: %q", host, msg)
	}
	// The path could in principle be considered less sensitive, but the generic
	// message must not echo it either.
	if strings.Contains(msg, "/api/v3/movie") {
		t.Errorf("client-facing error leaks request path: %q", msg)
	}
	if !strings.Contains(msg, "could not reach media service") {
		t.Errorf("expected the generic transport message, got: %q", msg)
	}
}
