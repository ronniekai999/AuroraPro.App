package llm

import (
	"bytes"
	"context"
	"log/slog"
	"strings"
	"testing"
	"time"
)

func TestPrivatePayloadRedactsDebugBodies(t *testing.T) {
	var logs bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })

	client := &Client{}
	client.SetDebug(true)
	ctx := WithPrivatePayload(context.Background())
	client.logRequest(ctx, "request-id", "https://example.test/chat", "model", []byte(`{"question":"private question"}`))
	client.logResponseChat(ctx, "request-id", 200, time.Millisecond, []byte(`{"answer":"private answer"}`))

	output := logs.String()
	if strings.Contains(output, "private question") || strings.Contains(output, "private answer") {
		t.Fatalf("private payload leaked into debug logs: %s", output)
	}
	if strings.Count(output, "body_redacted=true") != 2 {
		t.Fatalf("redaction markers missing from debug logs: %s", output)
	}
}
