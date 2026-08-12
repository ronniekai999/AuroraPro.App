package db

// Playback quality-of-experience telemetry (August 2026 review, item #1).
//
// One row per playback, written in two phases: the startup metrics land at
// first frame so they survive a session that never ends cleanly, and the
// steady-state counters land at terminal via a beacon. See migration 056 for
// the schema's reasoning and its privacy posture.

import (
	"context"
	"fmt"
	"regexp"
	"time"
)

// PlaybackQoERetention bounds how long raw QoE rows are kept.
//
// Deliberately shorter than the 90 days recommendation impressions get: this
// data answers "is startup regressing" and "which delivery path stalls", both
// of which are questions about the recent past. A longer window would carry
// more per-profile history for no additional operational answer.
const PlaybackQoERetention = 30 * 24 * time.Hour

// playbackSettleWindow is how long a session is given to report its terminal
// before its silence counts as abandonment. Longer than any plausible movie, so
// an in-progress playback is never mistaken for a lost beacon.
const playbackSettleWindow = 6 * time.Hour

// MaxPlaybackQoEPerProfilePerHour bounds how many rows one profile may create
// per hour. Normal use is a handful; the ceiling exists so a looping or
// malicious client cannot inflate the table (and skew the percentiles) without
// bound. Chosen well above any plausible human rate.
const MaxPlaybackQoEPerProfilePerHour = 240

// sessionTokenPattern is the client-generated handle's required shape.
// Exactly 32 lowercase hex characters — enough entropy that tokens don't
// collide, narrow enough that nothing else can be smuggled through the column.
var sessionTokenPattern = regexp.MustCompile(`^[0-9a-f]{32}$`)

// ValidPlaybackQoESessionToken reports whether a client-supplied token is
// well-formed.
func ValidPlaybackQoESessionToken(token string) bool {
	return sessionTokenPattern.MatchString(token)
}

// The enumerated vocabularies, mirroring the CHECK constraints in migration
// 056. They exist so an unrecognized value is normalized in Go before it
// reaches Postgres: a constraint violation would surface as a 500 and lose the
// whole row, where normalizing keeps the rest of a still-useful sample.
// TestPlaybackQoEVocabulariesMatchMigration asserts the two never drift, since
// a Go-side list that outgrew the CHECK would reintroduce exactly that 500.
var (
	PlaybackQoEDecisions       = []string{"direct_play", "direct_stream", "transcode"}
	PlaybackQoEDecisionReasons = []string{
		"compatible", "container", "video_codec", "audio_codec",
		"bit_depth", "audio_track", "unspecified",
	}
	PlaybackQoEOutputCodecs    = []string{"none", "copy", "h264", "hevc"}
	PlaybackQoEEncoderFamilies = []string{"none", "software", "nvenc", "qsv", "vaapi", "amf"}
	PlaybackQoESegmentFormats  = []string{"none", "fmp4", "ts"}
	PlaybackQoEHDRConversions  = []string{"none", "tonemap_cpu", "tonemap_gpu", "passthrough"}
	PlaybackQoEBurnIn          = []string{"none", "text", "bitmap"}
	PlaybackQoESubtitleModes   = []string{"none", "external", "embedded", "burned"}
	PlaybackQoEPrewarm         = []string{"none", "hit", "miss"}
	PlaybackQoEThroughput      = []string{"unknown", "under_2m", "2m_5m", "5m_10m", "10m_25m", "over_25m"}
	PlaybackQoEViewports       = []string{"unknown", "sd", "hd", "fhd", "qhd", "uhd"}
	PlaybackQoETerminals       = []string{
		"ended", "user_exit", "media_error", "network_error", "transcode_error", "unknown",
	}
)

// normalizeEnum returns value when it is in allowed, and fallback otherwise.
// Normalizing rather than erroring keeps one stale field from discarding an
// otherwise-useful row: an older SPA build that learns a new bucket later still
// contributes its startup timing today.
func normalizeEnum(value string, allowed []string, fallback string) string {
	for _, a := range allowed {
		if value == a {
			return value
		}
	}
	return fallback
}

// PlaybackQoEStart is the first-frame write: what the pipeline decided and how
// long it took to produce a picture.
type PlaybackQoEStart struct {
	SessionToken   string
	Decision       string
	DecisionReason string
	OutputCodec    string
	EncoderFamily  string
	SegmentFormat  string
	HDRConversion  string
	BurnIn         string
	SubtitleMode   string
	Prewarm        string
	ViewportClass  string
	// Nil when the client could not measure the interval (for example a
	// resumed session that never had a click).
	ClickToFirstFrameMS    *int
	ManifestToFirstFrameMS *int
}

// PlaybackQoEFinish is the terminal write: how the playback actually went.
type PlaybackQoEFinish struct {
	SessionToken      string
	RebufferCount     int
	RebufferMS        int
	RenditionSwitches int
	WatchedMS         int
	ThroughputClass   string
	Terminal          string
}

// startupBoundMs is the schema's ceiling on the startup timings. A value past
// it means a client that slept rather than a slow start, and admitting it would
// distort exactly the percentiles this table exists to report.
const startupBoundMs = 600_000

// clampStartupMs drops an out-of-range timing rather than clamping it TO the
// bound: a synthetic 600000 at p95 would read as a real ten-minute startup,
// whereas a NULL is honestly "not measured".
func clampStartupMs(v *int) *int {
	if v == nil {
		return nil
	}
	if *v < 0 || *v > startupBoundMs {
		return nil
	}
	return v
}

// Ceilings for the steady-state counters.
//
// Flooring at zero was not enough. These columns are int4, so a client that
// sends a value past int32 makes the whole terminal UPDATE fail at parameter
// encoding — the outcome, watch time and throughput class of that session are
// all lost, the handler swallows the error at Debug, and the row then counts as
// "abandoned", pointing any investigation at the wrong layer.
//
// A merely large value is worse, because it succeeds: rebuffer_ms is summed
// into RebufferRatio, so one request with 2147483647 poisons the dashboard's
// headline metric for every window containing it — up to the full retention
// period. The startup columns already had both a Go clamp and a SQL bound with
// a comment explaining exactly this; phase 2 had neither.
//
// 24 hours bounds any plausible single playback. Values are CLAMPED rather than
// dropped because these columns are NOT NULL accumulators with no "not measured"
// representation; clamping keeps the row's other fields usable and bounds the
// distortion to something physically possible.
const (
	maxPlaybackDurationMs = 24 * 60 * 60 * 1000 // 86_400_000
	maxPlaybackEventCount = 100_000
)

func clampRange(v, max int) int {
	if v < 0 {
		return 0
	}
	if v > max {
		return max
	}
	return v
}

// RecordPlaybackQoEStart inserts the first-frame row.
//
// A repeated token is a no-op rather than an error: beacons and retries can
// duplicate, and the first write is the accurate one.
func (q *Queries) RecordPlaybackQoEStart(ctx context.Context, profileID int64, rec PlaybackQoEStart) error {
	if profileID <= 0 || !ValidPlaybackQoESessionToken(rec.SessionToken) {
		return fmt.Errorf("invalid playback qoe start")
	}

	_, err := q.pool.Exec(ctx, `
		INSERT INTO playback_qoe_sessions (
			profile_id, session_token,
			decision, decision_reason,
			output_codec, encoder_family, segment_format, hdr_conversion,
			burn_in, subtitle_mode, prewarm, viewport_class,
			click_to_first_frame_ms, manifest_to_first_frame_ms
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
		ON CONFLICT (session_token) DO NOTHING`,
		profileID,
		rec.SessionToken,
		normalizeEnum(rec.Decision, PlaybackQoEDecisions, "transcode"),
		normalizeEnum(rec.DecisionReason, PlaybackQoEDecisionReasons, "unspecified"),
		normalizeEnum(rec.OutputCodec, PlaybackQoEOutputCodecs, "none"),
		normalizeEnum(rec.EncoderFamily, PlaybackQoEEncoderFamilies, "none"),
		normalizeEnum(rec.SegmentFormat, PlaybackQoESegmentFormats, "none"),
		normalizeEnum(rec.HDRConversion, PlaybackQoEHDRConversions, "none"),
		normalizeEnum(rec.BurnIn, PlaybackQoEBurnIn, "none"),
		normalizeEnum(rec.SubtitleMode, PlaybackQoESubtitleModes, "none"),
		normalizeEnum(rec.Prewarm, PlaybackQoEPrewarm, "none"),
		normalizeEnum(rec.ViewportClass, PlaybackQoEViewports, "unknown"),
		clampStartupMs(rec.ClickToFirstFrameMS),
		clampStartupMs(rec.ManifestToFirstFrameMS),
	)
	if err != nil {
		return fmt.Errorf("record playback qoe start: %w", err)
	}
	return nil
}

// FinishPlaybackQoE applies the terminal write to a row this profile owns.
//
// The profile_id predicate is the authorization check: a token is an opaque
// handle, not a capability, so knowing one must not let a different account
// write through it. A row that does not match is silently skipped — by the time
// a beacon fires there is nobody left to report an error to.
func (q *Queries) FinishPlaybackQoE(ctx context.Context, profileID int64, rec PlaybackQoEFinish) error {
	if profileID <= 0 || !ValidPlaybackQoESessionToken(rec.SessionToken) {
		return fmt.Errorf("invalid playback qoe finish")
	}

	_, err := q.pool.Exec(ctx, `
		UPDATE playback_qoe_sessions
		   SET rebuffer_count     = $3,
		       rebuffer_ms        = $4,
		       rendition_switches = $5,
		       watched_ms         = $6,
		       throughput_class   = $7,
		       terminal           = $8,
		       ended_at           = NOW()
		 WHERE session_token = $2
		   AND profile_id    = $1
		   AND terminal IS NULL`,
		profileID,
		rec.SessionToken,
		clampRange(rec.RebufferCount, maxPlaybackEventCount),
		clampRange(rec.RebufferMS, maxPlaybackDurationMs),
		clampRange(rec.RenditionSwitches, maxPlaybackEventCount),
		clampRange(rec.WatchedMS, maxPlaybackDurationMs),
		normalizeEnum(rec.ThroughputClass, PlaybackQoEThroughput, "unknown"),
		normalizeEnum(rec.Terminal, PlaybackQoETerminals, "unknown"),
	)
	if err != nil {
		return fmt.Errorf("finish playback qoe: %w", err)
	}
	return nil
}

// CountRecentPlaybackQoE reports how many rows a profile has created since the
// cutoff, backing the ingest endpoint's rate guard.
func (q *Queries) CountRecentPlaybackQoE(ctx context.Context, profileID int64, since time.Time) (int, error) {
	var n int
	err := q.pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM playback_qoe_sessions WHERE profile_id = $1 AND created_at >= $2`,
		profileID, since).Scan(&n)
	if err != nil {
		return 0, fmt.Errorf("count recent playback qoe: %w", err)
	}
	return n, nil
}

// PlaybackQoEDecisionStat is one decision bucket's slice of the summary.
type PlaybackQoEDecisionStat struct {
	Decision string `json:"decision"`
	Count    int    `json:"count"`
	P50MS    *int   `json:"p50_first_frame_ms"`
	P95MS    *int   `json:"p95_first_frame_ms"`
}

// PlaybackQoEReasonStat counts one transcode-reason bucket.
type PlaybackQoEReasonStat struct {
	Reason string `json:"reason"`
	Count  int    `json:"count"`
}

// PlaybackQoESummary is the admin dashboard's view: the percentiles and ratios
// the review asked for, over a recent window.
type PlaybackQoESummary struct {
	WindowHours int `json:"window_hours"`
	Sessions    int `json:"sessions"`

	P50FirstFrameMS *int `json:"p50_first_frame_ms"`
	P95FirstFrameMS *int `json:"p95_first_frame_ms"`

	// DirectPlayRatio is direct_play as a share of all sessions — the single
	// number that says how much work the server is doing that it need not.
	DirectPlayRatio float64 `json:"direct_play_ratio"`
	// RebufferRatio is total rebuffer time over total watch time.
	RebufferRatio float64 `json:"rebuffer_ratio"`
	// ErrorRate is failed terminals over sessions that reported any terminal.
	ErrorRate float64 `json:"error_rate"`
	// AbandonedRatio is sessions that never reported a terminal at all. High
	// values mean the beacon is not landing, which makes every other
	// terminal-derived number here suspect — so it is reported rather than
	// quietly excluded.
	//
	// Only sessions old enough to have finished are counted. A playback still
	// in progress has a NULL terminal too, so counting every NULL made a
	// healthy server at peak report a ratio near 1.0 on a short window — a
	// false alarm raised exactly when someone opens a narrow window to
	// investigate a live problem.
	AbandonedRatio float64 `json:"abandoned_ratio"`

	ByDecision []PlaybackQoEDecisionStat `json:"by_decision"`
	// BurnInSessions is the count with subtitle burn-in active. Burn-in forces
	// the pipeline off the Tier-2 zero-copy GPU path, so it is the first thing
	// to check when transcode startup regresses.
	BurnInSessions int                     `json:"burn_in_sessions"`
	TopReasons     []PlaybackQoEReasonStat `json:"top_reasons"`
}

// PlaybackQoESummaryStats computes the admin summary over the given window.
func (q *Queries) PlaybackQoESummaryStats(ctx context.Context, window time.Duration) (*PlaybackQoESummary, error) {
	if window <= 0 {
		window = 24 * time.Hour
	}
	seconds := int64(window.Seconds())
	out := &PlaybackQoESummary{WindowHours: int(window.Hours())}

	// Scan targets stay function-local: two admins loading the dashboard
	// concurrently would race on anything shared.
	var (
		p50Scan, p95Scan                                        *float64
		directPlays, rebufferMS, watchedMS, terminated, errored int64
		settled, settledAbandoned                               int64
	)

	// Headline aggregates in one pass. FILTER keeps each ratio's denominator
	// explicit rather than folding NULLs into an average silently.
	err := q.pool.QueryRow(ctx, `
		SELECT
			COUNT(*),
			percentile_cont(0.5) WITHIN GROUP (ORDER BY click_to_first_frame_ms)
				FILTER (WHERE click_to_first_frame_ms IS NOT NULL),
			percentile_cont(0.95) WITHIN GROUP (ORDER BY click_to_first_frame_ms)
				FILTER (WHERE click_to_first_frame_ms IS NOT NULL),
			COUNT(*) FILTER (WHERE decision = 'direct_play'),
			COALESCE(SUM(rebuffer_ms), 0),
			COALESCE(SUM(watched_ms), 0),
			COUNT(*) FILTER (WHERE terminal IS NOT NULL),
			COUNT(*) FILTER (WHERE terminal IN ('media_error','network_error','transcode_error')),
			COUNT(*) FILTER (WHERE burn_in <> 'none'),
			COUNT(*) FILTER (WHERE created_at < NOW() - make_interval(secs => $2)),
			COUNT(*) FILTER (WHERE terminal IS NULL
			                   AND created_at < NOW() - make_interval(secs => $2))
		FROM playback_qoe_sessions
		WHERE created_at >= NOW() - make_interval(secs => $1)`,
		seconds, int64(playbackSettleWindow.Seconds())).
		Scan(&out.Sessions, &p50Scan, &p95Scan,
			&directPlays, &rebufferMS, &watchedMS, &terminated, &errored, &out.BurnInSessions,
			&settled, &settledAbandoned)
	if err != nil {
		return nil, fmt.Errorf("playback qoe summary: %w", err)
	}

	out.P50FirstFrameMS = roundedMS(p50Scan)
	out.P95FirstFrameMS = roundedMS(p95Scan)
	if out.Sessions > 0 {
		out.DirectPlayRatio = float64(directPlays) / float64(out.Sessions)
	}
	if settled > 0 {
		out.AbandonedRatio = float64(settledAbandoned) / float64(settled)
	}
	if watchedMS > 0 {
		out.RebufferRatio = float64(rebufferMS) / float64(watchedMS)
	}
	if terminated > 0 {
		out.ErrorRate = float64(errored) / float64(terminated)
	}

	// Non-nil so an empty window marshals as [] rather than null — the SPA tab
	// that will read this should not have to special-case both.
	out.ByDecision = []PlaybackQoEDecisionStat{}
	out.TopReasons = []PlaybackQoEReasonStat{}
	if err := q.playbackQoEByDecision(ctx, seconds, out); err != nil {
		return nil, err
	}
	if err := q.playbackQoETopReasons(ctx, seconds, out); err != nil {
		return nil, err
	}
	return out, nil
}

func (q *Queries) playbackQoEByDecision(ctx context.Context, seconds int64, out *PlaybackQoESummary) error {
	rows, err := q.pool.Query(ctx, `
		SELECT decision,
		       COUNT(*),
		       percentile_cont(0.5) WITHIN GROUP (ORDER BY click_to_first_frame_ms)
		           FILTER (WHERE click_to_first_frame_ms IS NOT NULL),
		       percentile_cont(0.95) WITHIN GROUP (ORDER BY click_to_first_frame_ms)
		           FILTER (WHERE click_to_first_frame_ms IS NOT NULL)
		  FROM playback_qoe_sessions
		 WHERE created_at >= NOW() - make_interval(secs => $1)
		 GROUP BY decision
		 ORDER BY COUNT(*) DESC`, seconds)
	if err != nil {
		return fmt.Errorf("playback qoe by decision: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var s PlaybackQoEDecisionStat
		var p50, p95 *float64
		if err := rows.Scan(&s.Decision, &s.Count, &p50, &p95); err != nil {
			return fmt.Errorf("scan playback qoe decision: %w", err)
		}
		s.P50MS, s.P95MS = roundedMS(p50), roundedMS(p95)
		out.ByDecision = append(out.ByDecision, s)
	}
	return rows.Err()
}

func (q *Queries) playbackQoETopReasons(ctx context.Context, seconds int64, out *PlaybackQoESummary) error {
	rows, err := q.pool.Query(ctx, `
		SELECT decision_reason, COUNT(*)
		  FROM playback_qoe_sessions
		 WHERE created_at >= NOW() - make_interval(secs => $1)
		   AND decision <> 'direct_play'
		 GROUP BY decision_reason
		 ORDER BY COUNT(*) DESC
		 LIMIT 10`, seconds)
	if err != nil {
		return fmt.Errorf("playback qoe reasons: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var s PlaybackQoEReasonStat
		if err := rows.Scan(&s.Reason, &s.Count); err != nil {
			return fmt.Errorf("scan playback qoe reason: %w", err)
		}
		out.TopReasons = append(out.TopReasons, s)
	}
	return rows.Err()
}

// roundedMS converts a percentile result to whole milliseconds.
func roundedMS(v *float64) *int {
	if v == nil {
		return nil
	}
	ms := int(*v + 0.5)
	return &ms
}

// PrunePlaybackQoE enforces the retention bound, returning rows removed.
func (q *Queries) PrunePlaybackQoE(ctx context.Context, retention time.Duration) (int64, error) {
	if retention <= 0 {
		return 0, nil
	}
	tag, err := q.pool.Exec(ctx,
		`DELETE FROM playback_qoe_sessions WHERE created_at < NOW() - make_interval(secs => $1)`,
		int64(retention.Seconds()))
	if err != nil {
		return 0, fmt.Errorf("prune playback qoe: %w", err)
	}
	return tag.RowsAffected(), nil
}
