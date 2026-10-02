package watchparty

// Tests for scheduled-party durability (rehydrate.go).
//
// The unit cases pin fireScheduledReminder's self-validation even when a
// timer has fired concurrently with cancellation. The target comparison
// prevents stale pings and reminderSentFor prevents duplicate delivery.
//
// The integration case (TEST_DATABASE_URL opt-in, own pool for raw seeding)
// drives the real loop: CreateParty persists a scheduled party, Shutdown
// closes it, then a fresh manager rehydrates it and re-arms the
// countdown, and leaves started parties alone.

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/aurora-media/aurora/internal/db"
	"github.com/gorilla/websocket"
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
	t.Cleanup(m1.Shutdown)
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM watch_parties WHERE party_code = $1`, code) })
	if _, err := m1.JoinPartyV3Room(code, hostID, "host", &SafeConn{}); err != nil {
		t.Fatalf("join host: %v", err)
	}

	// A client retains this revision floor through a reconnect. A host can
	// seek while the lobby is paused without starting the scheduled party.
	if err := m1.HandleRequestSeek(code, hostID, 0); err != nil {
		t.Fatalf("pre-start seek: %v", err)
	}
	ps.mu.Lock()
	preRestart := m1.BuildPartyStateMessage(ps)
	ps.mu.Unlock()
	oldParty := preRestart["payload"].(map[string]interface{})["party"].(map[string]interface{})
	clientRevisionFloor := oldParty["revision"].(uint64)
	roomConn, roomClient := shutdownTestConn(t)
	ps.mu.Lock()
	ps.roomConns[hostID] = roomConn
	roomID := ps.roomDBID
	ps.mu.Unlock()

	// Exercise the updater's GRACEFUL restart, not merely a new manager.
	m1.Shutdown()
	assertShutdownSocket(t, roomClient, false)
	if m1.GetPartyState(code) != nil {
		t.Fatal("shutdown left the scheduled party live in the old manager")
	}
	ps.mu.Lock()
	timersRemain := ps.scheduleCancel != nil || ps.reminderCancel != nil || ps.tickCancel != nil
	ps.mu.Unlock()
	if timersRemain {
		t.Fatal("shutdown did not cancel the scheduled party's timers")
	}
	var active, roomDeleted bool
	if err := pool.QueryRow(ctx, `SELECT p.is_active, r.deleted_at IS NOT NULL
		FROM watch_parties p JOIN watch_party_rooms r ON r.id = p.room_id WHERE p.party_code = $1`, code).
		Scan(&active, &roomDeleted); err != nil {
		t.Fatalf("read durable party after shutdown (room %d): %v", roomID, err)
	}
	if !active || roomDeleted {
		t.Fatalf("shutdown killed a scheduled promise: active=%t roomDeleted=%t", active, roomDeleted)
	}

	// "After the restart": a fresh manager rehydrates from Postgres alone.
	m2 := NewManager(q, nil)
	t.Cleanup(m2.Shutdown)
	if m2.GetPartyState(code) != nil {
		t.Fatal("fresh manager unexpectedly knows the party before rehydration")
	}
	m2.RehydrateScheduledParties(ctx)

	got := m2.GetPartyState(code)
	if got == nil {
		t.Fatal("scheduled party not rehydrated after restart")
	}
	got.mu.Lock()
	newParty := m2.BuildPartyStateMessage(got)["payload"].(map[string]interface{})["party"].(map[string]interface{})
	got.mu.Unlock()
	if restoredRev := newParty["revision"].(uint64); restoredRev >= clientRevisionFloor {
		t.Fatalf("regression did not exercise a retained high client floor: old=%d restored=%d", clientRevisionFloor, restoredRev)
	}
	// The hook regression exercises these exact protocol semantics: the
	// first snapshot on the replacement room socket replaces the old floor,
	// then the sync hello and scheduled-start tick follow its new revisions.
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

	// 2026-08 review (critical): the stale-party reaper runs 60s after
	// boot, and a rehydrated party is empty with an old CreatedAt — the
	// scheduled exemption is what keeps rehydration from being a
	// one-minute stay of execution.
	m2.cleanupOnce()
	if m2.GetPartyState(code) == nil {
		t.Fatal("cleanupOnce reaped the rehydrated scheduled party; rehydration must survive the reaper")
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

func shutdownTestConn(t *testing.T) (*SafeConn, *websocket.Conn) {
	t.Helper()
	accepted := make(chan *SafeConn, 1)
	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err == nil {
			accepted <- NewSafeConn(conn)
		}
	}))
	t.Cleanup(server.Close)
	client, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatalf("dial shutdown test socket: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })
	conn := <-accepted
	t.Cleanup(func() { _ = conn.Close() })
	return conn, client
}

func assertShutdownSocket(t *testing.T, client *websocket.Conn, ended bool) {
	t.Helper()
	_ = client.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, data, err := client.ReadMessage()
	if ended {
		if err != nil || !strings.Contains(string(data), `"party-ended"`) {
			t.Fatalf("active shutdown message = %s, %v; want party-ended", data, err)
		}
	} else if !websocket.IsCloseError(err, websocket.CloseGoingAway) {
		t.Fatalf("scheduled shutdown message = %s, %v; want GoingAway without party-ended", data, err)
	}
}

func TestShutdown_ActivePartyStillEnds(t *testing.T) {
	m := NewManager(nil, nil)
	ps := v3TestParty(m, "SHUT01", 1)
	conn, client := shutdownTestConn(t)
	ps.mu.Lock()
	ps.roomConns[1] = conn
	ps.mu.Unlock()
	m.Shutdown()
	assertShutdownSocket(t, client, true)
	if m.GetPartyState(ps.Code) != nil {
		t.Fatal("active party remains after shutdown")
	}
}

func TestScheduledShutdown_ClosingPartyCannotRearm(t *testing.T) {
	m := NewManager(nil, nil)
	ps := v3TestParty(m, "SHUT02", 1)
	// An operation that resolved ps before suspension can acquire its mutex
	// during socket teardown. This represents that already-claimed state.
	ps.mu.Lock()
	ps.ending = true
	ps.mu.Unlock()
	when := time.Now().Add(time.Hour)
	if err := m.SchedulePartyStart(context.Background(), ps.Code, &when); err == nil {
		t.Error("closing party accepted a schedule")
	}
	if _, err := m.JoinPartyV3Room(ps.Code, 1, "host", &SafeConn{}); err == nil {
		t.Error("closing party accepted a room connection")
	}
	if err := m.JoinPartyV3Sync(ps.Code, 1, &SafeConn{}); err == nil {
		t.Error("closing party accepted a sync connection")
	}
	if err := m.HandleRequestPlay(ps.Code, 1); err == nil {
		t.Error("closing party accepted playback")
	}
	ps.mu.Lock()
	defer ps.mu.Unlock()
	if ps.scheduleCancel != nil || ps.tickCancel != nil || len(ps.roomConns)+len(ps.syncConns) != 0 {
		t.Error("closing party acquired live resources")
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
