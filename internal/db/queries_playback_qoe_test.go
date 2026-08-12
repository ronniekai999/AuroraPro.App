package db

import (
	"context"
	"fmt"
	"os"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestValidPlaybackQoESessionToken(t *testing.T) {
	cases := []struct {
		token string
		want  bool
	}{
		{"0123456789abcdef0123456789abcdef", true},
		{"", false},
		{"0123456789abcdef0123456789abcde", false},  // 31 chars
		{"0123456789abcdef0123456789abcdef0", false}, // 33 chars
		{"0123456789ABCDEF0123456789ABCDEF", false}, // uppercase
		{"0123456789abcdef0123456789abcdeg", false}, // non-hex
		{"'; DROP TABLE playback_qoe_sessions--", false},
	}
	for _, tc := range cases {
		if got := ValidPlaybackQoESessionToken(tc.token); got != tc.want {
			t.Errorf("ValidPlaybackQoESessionToken(%q) = %t, want %t", tc.token, got, tc.want)
		}
	}
}

func TestNormalizeEnum(t *testing.T) {
	allowed := []string{"none", "text", "bitmap"}
	if got := normalizeEnum("text", allowed, "none"); got != "text" {
		t.Errorf("known value = %q, want text", got)
	}
	if got := normalizeEnum("scribbles", allowed, "none"); got != "none" {
		t.Errorf("unknown value = %q, want the fallback none", got)
	}
	if got := normalizeEnum("", allowed, "none"); got != "none" {
		t.Errorf("empty value = %q, want the fallback none", got)
	}
}

// TestClampStartupMsDropsRatherThanClamps pins a decision that matters for the
// percentiles this table exists to report: an out-of-range timing becomes NULL,
// not the bound. Clamping a 40-minute "startup" (a laptop that slept) to 600000
// would plant a synthetic ten-minute sample right where p95 reads it.
func TestClampStartupMsDropsRatherThanClamps(t *testing.T) {
	ok := 4200
	if got := clampStartupMs(&ok); got == nil || *got != ok {
		t.Errorf("in-range value was not preserved: %v", got)
	}
	for _, bad := range []int{-1, startupBoundMs + 1, 60 * 60 * 1000} {
		if got := clampStartupMs(&bad); got != nil {
			t.Errorf("clampStartupMs(%d) = %d, want nil (dropped, not clamped)", bad, *got)
		}
	}
	if got := clampStartupMs(nil); got != nil {
		t.Error("nil input should stay nil")
	}
}

// TestPlaybackQoEVocabulariesMatchMigration is the drift guard.
//
// Every enumerated column is constrained twice: a CHECK in migration 056 and a
// Go allowlist used to normalize input. If the Go list ever grew a value the
// CHECK does not accept, normalization would pass it straight through to a
// constraint violation — a 500 on the ingest path and a lost row, which is
// precisely what the Go list exists to prevent. So the two are compared
// directly against the migration file.
func TestPlaybackQoEVocabulariesMatchMigration(t *testing.T) {
	source, err := os.ReadFile("../../migrations/056_playback_qoe.up.sql")
	if err != nil {
		t.Fatalf("read migration 056: %v", err)
	}
	sql := string(source)

	columns := map[string][]string{
		"decision":         PlaybackQoEDecisions,
		"decision_reason":  PlaybackQoEDecisionReasons,
		"output_codec":     PlaybackQoEOutputCodecs,
		"encoder_family":   PlaybackQoEEncoderFamilies,
		"segment_format":   PlaybackQoESegmentFormats,
		"hdr_conversion":   PlaybackQoEHDRConversions,
		"burn_in":          PlaybackQoEBurnIn,
		"subtitle_mode":    PlaybackQoESubtitleModes,
		"prewarm":          PlaybackQoEPrewarm,
		"throughput_class": PlaybackQoEThroughput,
		"viewport_class":   PlaybackQoEViewports,
		"terminal":         PlaybackQoETerminals,
	}

	for column, goValues := range columns {
		t.Run(column, func(t *testing.T) {
			sqlValues, ok := checkConstraintValues(sql, column)
			if !ok {
				t.Fatalf("no CHECK (%s IN (...)) found in migration 056 — either the "+
					"column lost its constraint or this test's parser needs updating", column)
			}
			got, want := append([]string(nil), goValues...), append([]string(nil), sqlValues...)
			sort.Strings(got)
			sort.Strings(want)
			if strings.Join(got, ",") != strings.Join(want, ",") {
				t.Errorf("Go allowlist and SQL CHECK disagree for %s:\n  go:  %v\n  sql: %v",
					column, got, want)
			}
		})
	}
}

// checkConstraintValues pulls the quoted values out of a
// `CHECK (<column> IN ('a', 'b', ...))` clause, tolerating the line wrapping the
// migration uses.
func checkConstraintValues(sql, column string) ([]string, bool) {
	re := regexp.MustCompile(`(?s)CHECK\s*\(\s*` + regexp.QuoteMeta(column) + `\s+IN\s*\((.*?)\)\s*\)`)
	m := re.FindStringSubmatch(sql)
	if m == nil {
		return nil, false
	}
	var out []string
	for _, v := range regexp.MustCompile(`'([^']*)'`).FindAllStringSubmatch(m[1], -1) {
		out = append(out, v[1])
	}
	return out, len(out) > 0
}

// --- Integration coverage (opt-in via TEST_DATABASE_URL) ---

func qoeTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dbURL := os.Getenv("TEST_DATABASE_URL")
	if dbURL == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	if err := RunMigrations(ctx, pool, "../../migrations"); err != nil {
		t.Fatalf("migrations: %v", err)
	}
	return pool
}

// qoeTestProfile creates a throwaway user + profile and returns the profile id.
// Rows cascade away with the user, so cleanup is one delete.
func qoeTestProfile(t *testing.T, pool *pgxpool.Pool) int64 {
	t.Helper()
	ctx := context.Background()
	suffix := fmt.Sprintf("%d", time.Now().UnixNano())

	var userID int64
	err := pool.QueryRow(ctx, `
		INSERT INTO users (username, email, password_hash, role)
		VALUES ($1, $2, 'x', 'user') RETURNING id`,
		"qoe_"+suffix, "qoe_"+suffix+"@example.test").Scan(&userID)
	if err != nil {
		t.Fatalf("create user: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, userID)
	})

	var profileID int64
	err = pool.QueryRow(ctx, `
		INSERT INTO user_profiles (user_id, name, is_default)
		VALUES ($1, 'Default', TRUE) RETURNING id`, userID).Scan(&profileID)
	if err != nil {
		t.Fatalf("create profile: %v", err)
	}
	return profileID
}

func TestPlaybackQoE_TwoPhaseWrite(t *testing.T) {
	pool := qoeTestPool(t)
	q := NewQueries(pool)
	ctx := context.Background()
	profileID := qoeTestProfile(t, pool)

	token := "aaaaaaaabbbbbbbbccccccccdddddddd"
	firstFrame := 1234
	err := q.RecordPlaybackQoEStart(ctx, profileID, PlaybackQoEStart{
		SessionToken:        token,
		Decision:            "transcode",
		DecisionReason:      "video_codec",
		OutputCodec:         "h264",
		EncoderFamily:       "software",
		SegmentFormat:       "fmp4",
		HDRConversion:       "tonemap_cpu",
		BurnIn:              "bitmap",
		SubtitleMode:        "burned",
		Prewarm:             "hit",
		ViewportClass:       "fhd",
		ClickToFirstFrameMS: &firstFrame,
	})
	if err != nil {
		t.Fatalf("start write: %v", err)
	}

	// Terminal beacon lands later and fills the counters.
	if err := q.FinishPlaybackQoE(ctx, profileID, PlaybackQoEFinish{
		SessionToken:      token,
		RebufferCount:     2,
		RebufferMS:        900,
		RenditionSwitches: 3,
		WatchedMS:         120_000,
		ThroughputClass:   "5m_10m",
		Terminal:          "ended",
	}); err != nil {
		t.Fatalf("finish write: %v", err)
	}

	var (
		decision, burnIn, terminal string
		clickMS, rebufferMS        int
	)
	err = pool.QueryRow(ctx, `
		SELECT decision, burn_in, terminal, click_to_first_frame_ms, rebuffer_ms
		  FROM playback_qoe_sessions WHERE session_token = $1`, token).
		Scan(&decision, &burnIn, &terminal, &clickMS, &rebufferMS)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if decision != "transcode" || burnIn != "bitmap" || terminal != "ended" {
		t.Errorf("row = (%s, %s, %s), want (transcode, bitmap, ended)", decision, burnIn, terminal)
	}
	if clickMS != firstFrame || rebufferMS != 900 {
		t.Errorf("metrics = (%d, %d), want (%d, 900)", clickMS, rebufferMS, firstFrame)
	}
}

// TestPlaybackQoE_UnknownEnumsAreNormalized proves a client sending a value the
// server has never heard of still contributes a usable row rather than tripping
// a constraint and losing the sample.
func TestPlaybackQoE_UnknownEnumsAreNormalized(t *testing.T) {
	pool := qoeTestPool(t)
	q := NewQueries(pool)
	ctx := context.Background()
	profileID := qoeTestProfile(t, pool)

	token := "11111111222222223333333344444444"
	if err := q.RecordPlaybackQoEStart(ctx, profileID, PlaybackQoEStart{
		SessionToken:  token,
		Decision:      "quantum_tunnel",
		BurnIn:        "interpretive_dance",
		ViewportClass: "enormous",
	}); err != nil {
		t.Fatalf("start write with unknown enums: %v", err)
	}

	var decision, burnIn, viewport string
	err := pool.QueryRow(ctx, `
		SELECT decision, burn_in, viewport_class FROM playback_qoe_sessions WHERE session_token = $1`,
		token).Scan(&decision, &burnIn, &viewport)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if decision != "transcode" || burnIn != "none" || viewport != "unknown" {
		t.Errorf("normalized row = (%s, %s, %s), want (transcode, none, unknown)",
			decision, burnIn, viewport)
	}
}

// TestPlaybackQoE_FinishRequiresOwningProfile is the authorization check: the
// session token is an opaque handle, not a capability. Knowing one must not let
// another account write through it.
func TestPlaybackQoE_FinishRequiresOwningProfile(t *testing.T) {
	pool := qoeTestPool(t)
	q := NewQueries(pool)
	ctx := context.Background()

	owner := qoeTestProfile(t, pool)
	attacker := qoeTestProfile(t, pool)

	token := "99999999888888887777777766666666"
	if err := q.RecordPlaybackQoEStart(ctx, owner, PlaybackQoEStart{
		SessionToken: token, Decision: "transcode",
	}); err != nil {
		t.Fatalf("start write: %v", err)
	}

	if err := q.FinishPlaybackQoE(ctx, attacker, PlaybackQoEFinish{
		SessionToken: token, Terminal: "media_error", RebufferCount: 99,
	}); err != nil {
		t.Fatalf("finish write returned an error (it should be a silent no-op): %v", err)
	}

	var terminal *string
	var rebufferCount int
	if err := pool.QueryRow(ctx,
		`SELECT terminal, rebuffer_count FROM playback_qoe_sessions WHERE session_token = $1`,
		token).Scan(&terminal, &rebufferCount); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if terminal != nil || rebufferCount != 0 {
		t.Errorf("another profile wrote through the token: terminal=%v rebuffer_count=%d",
			terminal, rebufferCount)
	}
}

// TestPlaybackQoE_DuplicateStartIsIgnored covers beacon/retry duplication.
func TestPlaybackQoE_DuplicateStartIsIgnored(t *testing.T) {
	pool := qoeTestPool(t)
	q := NewQueries(pool)
	ctx := context.Background()
	profileID := qoeTestProfile(t, pool)

	token := "abababababababababababababababab"
	first, second := 500, 9000
	for _, ms := range []int{first, second} {
		v := ms
		if err := q.RecordPlaybackQoEStart(ctx, profileID, PlaybackQoEStart{
			SessionToken: token, Decision: "direct_play", ClickToFirstFrameMS: &v,
		}); err != nil {
			t.Fatalf("start write %d: %v", ms, err)
		}
	}

	var n, clickMS int
	if err := pool.QueryRow(ctx,
		`SELECT COUNT(*), MAX(click_to_first_frame_ms) FROM playback_qoe_sessions WHERE session_token = $1`,
		token).Scan(&n, &clickMS); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if n != 1 {
		t.Errorf("duplicate start produced %d rows, want 1", n)
	}
	if clickMS != first {
		t.Errorf("duplicate start overwrote the timing: got %d, want the first write's %d", clickMS, first)
	}
}

func TestPlaybackQoE_SummaryAndPrune(t *testing.T) {
	pool := qoeTestPool(t)
	q := NewQueries(pool)
	ctx := context.Background()
	profileID := qoeTestProfile(t, pool)

	// Three direct plays and one transcode, with known startup timings.
	samples := []struct {
		token    string
		decision string
		ms       int
	}{
		{"c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1", "direct_play", 100},
		{"c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2", "direct_play", 200},
		{"c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3", "direct_play", 300},
		{"c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4", "transcode", 4000},
	}
	for _, s := range samples {
		ms := s.ms
		if err := q.RecordPlaybackQoEStart(ctx, profileID, PlaybackQoEStart{
			SessionToken: s.token, Decision: s.decision, ClickToFirstFrameMS: &ms,
		}); err != nil {
			t.Fatalf("seed %s: %v", s.token, err)
		}
	}
	// Only two of the four report a terminal, one of them an error.
	if err := q.FinishPlaybackQoE(ctx, profileID, PlaybackQoEFinish{
		SessionToken: samples[0].token, Terminal: "ended", WatchedMS: 100_000, RebufferMS: 1_000,
	}); err != nil {
		t.Fatalf("finish 0: %v", err)
	}
	if err := q.FinishPlaybackQoE(ctx, profileID, PlaybackQoEFinish{
		SessionToken: samples[3].token, Terminal: "media_error", WatchedMS: 100_000,
	}); err != nil {
		t.Fatalf("finish 3: %v", err)
	}

	summary, err := q.PlaybackQoESummaryStats(ctx, time.Hour)
	if err != nil {
		t.Fatalf("summary: %v", err)
	}
	if summary.Sessions < 4 {
		t.Fatalf("summary counted %d sessions, want at least the 4 seeded", summary.Sessions)
	}
	if summary.P50FirstFrameMS == nil || summary.P95FirstFrameMS == nil {
		t.Fatal("summary produced no percentiles despite every row carrying a timing")
	}
	if *summary.P95FirstFrameMS < *summary.P50FirstFrameMS {
		t.Errorf("p95 %d < p50 %d", *summary.P95FirstFrameMS, *summary.P50FirstFrameMS)
	}
	if summary.DirectPlayRatio <= 0 || summary.DirectPlayRatio > 1 {
		t.Errorf("direct play ratio %v out of range", summary.DirectPlayRatio)
	}
	if summary.RebufferRatio <= 0 {
		t.Errorf("rebuffer ratio = %v, want > 0 given a seeded rebuffer", summary.RebufferRatio)
	}
	if summary.ErrorRate <= 0 {
		t.Errorf("error rate = %v, want > 0 given a seeded media_error", summary.ErrorRate)
	}
	// Freshly-seeded rows are still inside the settle window, so none of them
	// counts as abandoned yet — an in-progress playback must never be reported
	// as a lost beacon.
	if summary.AbandonedRatio != 0 {
		t.Errorf("abandoned ratio = %v for rows inside the settle window, want 0",
			summary.AbandonedRatio)
	}
	// Age them past the settle window: the two that never reported a terminal
	// must now surface, rather than silently shrinking the error-rate
	// denominator.
	if _, err := pool.Exec(ctx,
		`UPDATE playback_qoe_sessions SET created_at = NOW() - INTERVAL '12 hours' WHERE profile_id = $1`,
		profileID); err != nil {
		t.Fatalf("age rows past the settle window: %v", err)
	}
	settledSummary, err := q.PlaybackQoESummaryStats(ctx, 24*time.Hour)
	if err != nil {
		t.Fatalf("summary after settle: %v", err)
	}
	if settledSummary.AbandonedRatio <= 0 {
		t.Errorf("abandoned ratio = %v after the settle window, want > 0 given two "+
			"sessions with no terminal", settledSummary.AbandonedRatio)
	}
	if len(summary.ByDecision) == 0 {
		t.Error("summary carries no per-decision breakdown")
	}

	// Retention. PrunePlaybackQoE is table-wide, so the assertions are scoped
	// to THIS profile's rows rather than to the table: asserting a global
	// count would make the test depend on — and destroy — whatever else a
	// long-lived developer database happens to hold.
	countMine := func() int {
		var n int
		if err := pool.QueryRow(ctx,
			`SELECT COUNT(*) FROM playback_qoe_sessions WHERE profile_id = $1`, profileID).Scan(&n); err != nil {
			t.Fatalf("count own rows: %v", err)
		}
		return n
	}
	if _, err := q.PrunePlaybackQoE(ctx, PlaybackQoERetention); err != nil {
		t.Fatalf("prune: %v", err)
	}
	if got := countMine(); got != len(samples) {
		t.Errorf("prune removed %d of this profile's fresh rows; they are inside retention",
			len(samples)-got)
	}
	// Age this profile's rows past the bound and re-run.
	if _, err := pool.Exec(ctx,
		`UPDATE playback_qoe_sessions SET created_at = NOW() - INTERVAL '400 days' WHERE profile_id = $1`,
		profileID); err != nil {
		t.Fatalf("age rows: %v", err)
	}
	if _, err := q.PrunePlaybackQoE(ctx, PlaybackQoERetention); err != nil {
		t.Fatalf("prune aged: %v", err)
	}
	if got := countMine(); got != 0 {
		t.Errorf("%d aged rows survived the retention sweep", got)
	}
}

func TestPlaybackQoE_CountRecent(t *testing.T) {
	pool := qoeTestPool(t)
	q := NewQueries(pool)
	ctx := context.Background()
	profileID := qoeTestProfile(t, pool)

	if err := q.RecordPlaybackQoEStart(ctx, profileID, PlaybackQoEStart{
		SessionToken: "d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1", Decision: "direct_play",
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	n, err := q.CountRecentPlaybackQoE(ctx, profileID, time.Now().Add(-time.Hour))
	if err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 1 {
		t.Errorf("CountRecentPlaybackQoE = %d, want 1", n)
	}
}

// TestClampRangeBoundsBothEnds pins the fix for a defect that reached review:
// the steady-state counters were floored at zero and bounded nowhere above.
//
// Two distinct failures came out of that. A value past int32 made the whole
// terminal UPDATE fail at parameter encoding, silently discarding the outcome,
// watch time and throughput of that session. A merely huge value succeeded and
// poisoned RebufferRatio — one request could distort the dashboard's headline
// metric for the entire retention window.
func TestClampRangeBoundsBothEnds(t *testing.T) {
	cases := []struct {
		in, max, want int
	}{
		{-1, 100, 0},
		{0, 100, 0},
		{50, 100, 50},
		{100, 100, 100},
		{101, 100, 100},
		// The values that used to break things.
		{2147483647, maxPlaybackDurationMs, maxPlaybackDurationMs},
		{3000000000, maxPlaybackDurationMs, maxPlaybackDurationMs},
	}
	for _, tc := range cases {
		if got := clampRange(tc.in, tc.max); got != tc.want {
			t.Errorf("clampRange(%d, %d) = %d, want %d", tc.in, tc.max, got, tc.want)
		}
	}
}

// TestPlaybackQoE_AbsurdCountersCannotPoisonTheSummary is the end-to-end proof,
// against a real database: a member sending int32-max counters must neither
// lose their terminal write nor move the aggregate off a sane scale.
func TestPlaybackQoE_AbsurdCountersCannotPoisonTheSummary(t *testing.T) {
	pool := qoeTestPool(t)
	q := NewQueries(pool)
	ctx := context.Background()
	profileID := qoeTestProfile(t, pool)

	token := "eeeeeeeeffffffff0000000011111111"
	if err := q.RecordPlaybackQoEStart(ctx, profileID, PlaybackQoEStart{
		SessionToken: token, Decision: "transcode",
	}); err != nil {
		t.Fatalf("start: %v", err)
	}

	// Both a value that used to overflow int4 and one that used to insert
	// cleanly and wreck the ratio.
	if err := q.FinishPlaybackQoE(ctx, profileID, PlaybackQoEFinish{
		SessionToken:  token,
		RebufferMS:    3000000000,
		RebufferCount: 2147483647,
		WatchedMS:     1,
		Terminal:      "ended",
	}); err != nil {
		t.Fatalf("finish with absurd counters must still succeed: %v", err)
	}

	var terminal *string
	var rebufferMS, rebufferCount int
	if err := pool.QueryRow(ctx,
		`SELECT terminal, rebuffer_ms, rebuffer_count FROM playback_qoe_sessions WHERE session_token = $1`,
		token).Scan(&terminal, &rebufferMS, &rebufferCount); err != nil {
		t.Fatalf("read back: %v", err)
	}
	// The terminal write must have LANDED — losing it is the silent failure.
	if terminal == nil || *terminal != "ended" {
		t.Fatalf("terminal = %v, want ended — the outcome was discarded", terminal)
	}
	if rebufferMS != maxPlaybackDurationMs {
		t.Errorf("rebuffer_ms = %d, want it clamped to %d", rebufferMS, maxPlaybackDurationMs)
	}
	if rebufferCount != maxPlaybackEventCount {
		t.Errorf("rebuffer_count = %d, want it clamped to %d", rebufferCount, maxPlaybackEventCount)
	}
}
