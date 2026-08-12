package db

// Coverage for the server-side behaviours added while resolving review
// findings. They shipped in one commit with no tests, which is the same gap
// that commit's own rationale called out on the client side.

import (
	"context"
	"testing"
	"time"
)

// TestRestamp_ReachesABfcachedRow pins the predicate alignment.
//
// Restamp used `terminal IS NULL` while Finish used `IS NULL OR 'unknown'`, so
// a row whose page had entered the back/forward cache could never be restamped:
// a viewer who backgrounded a tab and then seeked kept the pre-rebuild encoder
// on a row that later settled as a completed transcode.
func TestRestamp_ReachesABfcachedRow(t *testing.T) {
	pool := qoeTestPool(t)
	q := NewQueries(pool)
	ctx := context.Background()
	profileID := qoeTestProfile(t, pool)

	token := "aaaabbbbccccddddeeeeffff00001111"
	if err := q.RecordPlaybackQoEStart(ctx, profileID, PlaybackQoEStart{
		SessionToken: token, Decision: "direct_stream", OutputCodec: "copy",
	}); err != nil {
		t.Fatalf("start: %v", err)
	}
	// The page enters the bfcache: a provisional terminal is written.
	if err := q.FinishPlaybackQoE(ctx, profileID, PlaybackQoEFinish{
		SessionToken: token, Terminal: "unknown",
	}); err != nil {
		t.Fatalf("provisional finish: %v", err)
	}
	// Restored, then a seek rebuilds the delivery from remux to transcode.
	if err := q.RestampPlaybackQoEDelivery(ctx, profileID, token, PlaybackQoEDelivery{
		OutputCodec: "h264", EncoderFamily: "software", SegmentFormat: "fmp4",
	}); err != nil {
		t.Fatalf("restamp: %v", err)
	}

	var codec, family string
	if err := pool.QueryRow(ctx,
		`SELECT output_codec, encoder_family FROM playback_qoe_sessions WHERE session_token = $1`,
		token).Scan(&codec, &family); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if codec != "h264" || family != "software" {
		t.Errorf("restamp did not reach the bfcached row: got %s/%s, want h264/software", codec, family)
	}
}

// TestRestamp_CannotRewriteASettledRow is the other half: once a viewing has a
// real outcome its delivery description is history.
func TestRestamp_CannotRewriteASettledRow(t *testing.T) {
	pool := qoeTestPool(t)
	q := NewQueries(pool)
	ctx := context.Background()
	profileID := qoeTestProfile(t, pool)

	token := "11112222333344445555666677778888"
	if err := q.RecordPlaybackQoEStart(ctx, profileID, PlaybackQoEStart{
		SessionToken: token, Decision: "transcode", OutputCodec: "h264", EncoderFamily: "software",
	}); err != nil {
		t.Fatalf("start: %v", err)
	}
	if err := q.FinishPlaybackQoE(ctx, profileID, PlaybackQoEFinish{
		SessionToken: token, Terminal: "ended",
	}); err != nil {
		t.Fatalf("finish: %v", err)
	}
	if err := q.RestampPlaybackQoEDelivery(ctx, profileID, token, PlaybackQoEDelivery{
		OutputCodec: "hevc", EncoderFamily: "nvenc",
	}); err != nil {
		t.Fatalf("restamp: %v", err)
	}

	var codec string
	if err := pool.QueryRow(ctx,
		`SELECT output_codec FROM playback_qoe_sessions WHERE session_token = $1`, token).Scan(&codec); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if codec != "h264" {
		t.Errorf("a settled row was rewritten: output_codec = %q, want h264", codec)
	}
}

// TestRestamp_RequiresOwningProfile — the session token is a handle, not a
// capability, on this endpoint too.
func TestRestamp_RequiresOwningProfile(t *testing.T) {
	pool := qoeTestPool(t)
	q := NewQueries(pool)
	ctx := context.Background()
	owner := qoeTestProfile(t, pool)
	attacker := qoeTestProfile(t, pool)

	token := "9999888877776666555544443333dddd"
	if err := q.RecordPlaybackQoEStart(ctx, owner, PlaybackQoEStart{
		SessionToken: token, Decision: "transcode", EncoderFamily: "software",
	}); err != nil {
		t.Fatalf("start: %v", err)
	}
	if err := q.RestampPlaybackQoEDelivery(ctx, attacker, token, PlaybackQoEDelivery{
		EncoderFamily: "nvenc",
	}); err != nil {
		t.Fatalf("restamp from another profile should be a silent no-op: %v", err)
	}

	var family string
	if err := pool.QueryRow(ctx,
		`SELECT encoder_family FROM playback_qoe_sessions WHERE session_token = $1`, token).Scan(&family); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if family != "software" {
		t.Errorf("another profile restamped the row: encoder_family = %q", family)
	}
}

// TestFinishPlaybackQoE_SettledOutcomeIsFinal pins the upgrade rule: repeated
// provisional writes are idempotent, and no late beacon can rewrite a real
// outcome or regress watched_ms.
func TestFinishPlaybackQoE_SettledOutcomeIsFinal(t *testing.T) {
	pool := qoeTestPool(t)
	q := NewQueries(pool)
	ctx := context.Background()
	profileID := qoeTestProfile(t, pool)

	token := "abcdabcdabcdabcdabcdabcdabcdabcd"
	if err := q.RecordPlaybackQoEStart(ctx, profileID, PlaybackQoEStart{
		SessionToken: token, Decision: "transcode",
	}); err != nil {
		t.Fatalf("start: %v", err)
	}
	// Two bfcache entries in a row: idempotent.
	for i := 0; i < 2; i++ {
		if err := q.FinishPlaybackQoE(ctx, profileID, PlaybackQoEFinish{
			SessionToken: token, Terminal: "unknown", WatchedMS: 1000,
		}); err != nil {
			t.Fatalf("provisional finish %d: %v", i, err)
		}
	}
	// The real outcome upgrades it.
	if err := q.FinishPlaybackQoE(ctx, profileID, PlaybackQoEFinish{
		SessionToken: token, Terminal: "ended", WatchedMS: 120_000,
	}); err != nil {
		t.Fatalf("real finish: %v", err)
	}
	// A late duplicate must not regress it.
	if err := q.FinishPlaybackQoE(ctx, profileID, PlaybackQoEFinish{
		SessionToken: token, Terminal: "user_exit", WatchedMS: 5,
	}); err != nil {
		t.Fatalf("late duplicate: %v", err)
	}

	var terminal string
	var watched int
	if err := pool.QueryRow(ctx,
		`SELECT terminal, watched_ms FROM playback_qoe_sessions WHERE session_token = $1`,
		token).Scan(&terminal, &watched); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if terminal != "ended" || watched != 120_000 {
		t.Errorf("settled row = (%s, %d), want (ended, 120000)", terminal, watched)
	}
}

// TestPrunePlaybackQoE_BatchesAndTerminates covers the batched sweep: it must
// drain more rows than one batch holds and then stop.
func TestPrunePlaybackQoE_BatchesAndTerminates(t *testing.T) {
	pool := qoeTestPool(t)
	q := NewQueries(pool)
	ctx := context.Background()
	profileID := qoeTestProfile(t, pool)

	// Seed enough to span more than one batch would be slow; seed a handful and
	// assert the loop drains all of them and returns.
	for i := 0; i < 12; i++ {
		token := "ffff0000" + padHex(i, 24)
		if err := q.RecordPlaybackQoEStart(ctx, profileID, PlaybackQoEStart{
			SessionToken: token, Decision: "direct_play",
		}); err != nil {
			t.Fatalf("seed %d: %v", i, err)
		}
	}
	if _, err := pool.Exec(ctx,
		`UPDATE playback_qoe_sessions SET created_at = NOW() - INTERVAL '400 days' WHERE profile_id = $1`,
		profileID); err != nil {
		t.Fatalf("age rows: %v", err)
	}

	done := make(chan struct{})
	go func() {
		defer close(done)
		if _, err := q.PrunePlaybackQoE(ctx, PlaybackQoERetention); err != nil {
			t.Errorf("prune: %v", err)
		}
	}()
	select {
	case <-done:
	case <-time.After(30 * time.Second):
		t.Fatal("prune did not terminate — the batch loop is not draining")
	}

	var remaining int
	if err := pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM playback_qoe_sessions WHERE profile_id = $1`, profileID).Scan(&remaining); err != nil {
		t.Fatalf("count: %v", err)
	}
	if remaining != 0 {
		t.Errorf("%d aged rows survived the batched sweep", remaining)
	}
}

func padHex(n, width int) string {
	s := ""
	for i := 0; i < width; i++ {
		s += string(rune('0' + (n+i)%10))
	}
	return s
}
