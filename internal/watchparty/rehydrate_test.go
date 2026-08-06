package watchparty

// Tests for scheduled-party durability (rehydrate.go).
//
// The unit cases pin fireScheduledReminder's self-validation — reminder
// goroutines have no cancel hook, so the ONLY thing standing between a
// reschedule and a wrong-time ping is the target comparison, and the only
// thing preventing double-sends is the reminderSentFor guard.
//
// The integration case (TEST_DATABASE_URL opt-in, own pool for raw seeding)
// drives the real loop: CreateParty persists a scheduled party, a FRESH
// manager — simulating the post-update restart — rehydrates it, re-arms the
// countdown, and leaves started parties alone.

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/aurora-media/aurora/internal/db"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestFireScheduledReminder_StaleTargetIsNoop(t *testing.T) {
	m := NewManager(nil, nil)
	ps := v3TestParty(m, "REMIND", 1)

	target := time.Now().Add(30 * time.Minute).Truncate(time.Second)
	rescheduled := target.Add(45 * time.Minute)
	ps.mu.Lock()
	ps.ScheduledStartAt = &rescheduled // party moved after the timer armed
	ps.mu.Unlock()

	m.fireScheduledReminder("REMIND", target) // stale target

	ps.mu.Lock()
	defer ps.mu.Unlock()
	if ps.reminderSentFor != nil {
		t.Error("stale-target reminder marked itself sent; want silent no-op")
	}
}

func TestFireScheduledReminder_SendsOncePerTarget(t *testing.T) {
	m := NewManager(nil, nil)
	ps := v3TestParty(m, "REMIN2", 1)

	target := time.Now().Add(30 * time.Minute).Truncate(time.Second)
	ps.mu.Lock()
	ps.ScheduledStartAt = &target
	ps.mu.Unlock()

	// First fire claims the target (dispatcher is nil, so no delivery —
	// the guard is what's under test).
	m.fireScheduledReminder("REMIN2", target)
	ps.mu.Lock()
	first := ps.reminderSentFor
	ps.mu.Unlock()
	if first == nil || !first.Equal(target) {
		t.Fatalf("reminderSentFor = %v; want the target", first)
	}

	// A concurrent same-target arm fires again: pointer identity proves
	// the guard short-circuited rather than re-claiming.
	m.fireScheduledReminder("REMIN2", target)
	ps.mu.Lock()
	defer ps.mu.Unlock()
	if ps.reminderSentFor != first {
		t.Error("second same-target fire re-claimed the guard; want at-most-once")
	}
}

func TestFireScheduledReminder_StartedPartyIsNoop(t *testing.T) {
	m := NewManager(nil, nil)
	ps := v3TestParty(m, "REMIN3", 1)

	target := time.Now().Add(30 * time.Minute)
	started := time.Now()
	ps.mu.Lock()
	ps.ScheduledStartAt = &target
	ps.StartedAt = &started // host started early
	ps.mu.Unlock()

	m.fireScheduledReminder("REMIN3", target)

	ps.mu.Lock()
	defer ps.mu.Unlock()
	if ps.reminderSentFor != nil {
		t.Error("reminder claimed a party that already started; want no-op")
	}
}

// ─── integration ─────────────────────────────────────────────────────

func requireRehydrateDB(t *testing.T) (*db.Queries, *pgxpool.Pool) {
	t.Helper()
	dbURL := os.Getenv("TEST_DATABASE_URL")
	if dbURL == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping rehydrate integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		t.Fatalf("ping: %v", err)
	}
	t.Cleanup(pool.Close)
	return db.NewQueries(pool), pool
}

func TestRehydrateScheduledParties_RestartSurvival(t *testing.T) {
	q, pool := requireRehydrateDB(t)
	ctx := context.Background()

	// Raw seeds (users → library → media) — user delete cascades the rest.
	var hostID int64
	if err := pool.QueryRow(ctx,
		`INSERT INTO users (username, email, password_hash)
		 VALUES ('rehydrate_t_'||md5(random()::text), md5(random()::text)||'@example.com', 'x')
		 RETURNING id`,
	).Scan(&hostID); err != nil {
		t.Fatalf("seed host: %v", err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, hostID) })

	var libID, mediaID int64
	if err := pool.QueryRow(ctx,
		`INSERT INTO libraries (name, type, paths, owner_id)
		 VALUES ('rehydrate_lib_'||md5(random()::text), 'movie', '{"/tmp/rehydrate"}', $1) RETURNING id`,
		hostID,
	).Scan(&libID); err != nil {
		t.Fatalf("seed library: %v", err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM libraries WHERE id = $1`, libID) })
	if err := pool.QueryRow(ctx,
		`INSERT INTO media_items (library_id, type, title, sort_title, year, overview, rating, runtime_minutes)
		 VALUES ($1, 'movie', 'Halloweentown', 'halloweentown', 1998, '', 0, 84) RETURNING id`,
		libID,
	).Scan(&mediaID); err != nil {
		t.Fatalf("seed media: %v", err)
	}

	// "Before the restart": a real scheduled party, persisted by CreateParty.
	m1 := NewManager(q, nil)
	scheduledAt := time.Now().Add(2 * time.Hour).Truncate(time.Second)
	ps, err := m1.CreateParty(ctx, hostID, "host", mediaID, nil, "Movie Night",
		"Halloweentown", "", 8, PartySettings{AllowPause: true, AllowChat: true}, 0, &scheduledAt)
	if err != nil {
		t.Fatalf("create party: %v", err)
	}
	code := ps.Code
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM watch_parties WHERE party_code = $1`, code) })

	// "After the restart": a fresh manager rehydrates from Postgres alone.
	m2 := NewManager(q, nil)
	if m2.GetPartyState(code) != nil {
		t.Fatal("fresh manager unexpectedly knows the party before rehydration")
	}
	m2.RehydrateScheduledParties(ctx)

	got := m2.GetPartyState(code)
	if got == nil {
		t.Fatal("scheduled party not rehydrated after restart")
	}
	got.mu.Lock()
	sched := got.ScheduledStartAt
	timerArmed := got.scheduleCancel != nil
	settings := got.Settings
	host := got.HostUserID
	title := got.MediaTitle
	got.mu.Unlock()

	if sched == nil || !sched.Equal(scheduledAt) {
		t.Errorf("rehydrated schedule = %v; want %v", sched, scheduledAt)
	}
	if !timerArmed {
		t.Error("countdown timer not re-armed after rehydration")
	}
	if !settings.AllowPause || !settings.AllowChat {
		t.Errorf("settings lost in round-trip: %+v", settings)
	}
	if host != hostID || title != "Halloweentown" {
		t.Errorf("identity lost: host=%d title=%q", host, title)
	}

	// Idempotence: a second rehydrate (or a same-code row) must not
	// double-register.
	if restored := m2.RehydrateScheduledParties(ctx); restored != 0 {
		t.Errorf("second rehydrate restored %d parties; want 0 (code already live)", restored)
	}

	// A started party stays dead: mark it started, restart again, gone.
	if err := q.MarkPartyStarted(ctx, partyDBID(t, pool, code), time.Now()); err != nil {
		t.Fatalf("mark started: %v", err)
	}
	m3 := NewManager(q, nil)
	m3.RehydrateScheduledParties(ctx)
	if m3.GetPartyState(code) != nil {
		t.Error("started party was rehydrated; want left alone")
	}
}

func partyDBID(t *testing.T, pool *pgxpool.Pool, code string) int64 {
	t.Helper()
	var id int64
	if err := pool.QueryRow(context.Background(),
		`SELECT id FROM watch_parties WHERE party_code = $1 AND is_active = TRUE`, code,
	).Scan(&id); err != nil {
		t.Fatalf("resolve party id: %v", err)
	}
	return id
}
