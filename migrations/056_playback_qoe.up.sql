-- Playback quality-of-experience telemetry (August 2026 review, item #1).
--
-- Aurora has rich diagnostic logging and a live per-session diagnose endpoint,
-- but both are ephemeral: they describe a session happening right now and
-- retain nothing. There has been no durable answer to the questions that should
-- drive codec and buffering work — is startup getting worse, which device
-- family stalls, how often do we transcode something we could have direct
-- played.
--
-- Grain is ONE ROW PER PLAYBACK, not an event stream. A play is bounded and
-- short-lived, so counters collapse into the row that owns them and the table
-- grows with plays rather than with seconds watched.
--
-- Written in two phases, which is why most columns are nullable:
--
--   1. at first frame — the startup metrics, which are the highest-value
--      fields and must survive a session that never ends cleanly;
--   2. at terminal — the steady-state counters and the outcome, delivered by
--      navigator.sendBeacon so it survives page unload.
--
-- Privacy: coarse enumerated buckets only. No URL, token, filename, IP, raw
-- user-agent, or media identifier — this table describes DELIVERY, not what
-- anyone watched. profile_id is carried solely so rows cascade away with the
-- profile; the watch history that does describe viewing lives elsewhere and is
-- separately opt-in.
--
-- The CHECK vocabularies are deliberate. Adding a bucket costs a migration,
-- which is the right price for a schema whose entire value is that its
-- categories stay comparable across time.

CREATE TABLE playback_qoe_sessions (
    id         BIGSERIAL   PRIMARY KEY,
    profile_id BIGINT      NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,

    -- Client-generated opaque handle (32 lowercase hex). It lets the terminal
    -- beacon update the row the startup write created without a round trip,
    -- which matters because a beacon fires during unload and cannot await a
    -- response. Server-side shape validation + UNIQUE bound what a client can
    -- do with it.
    session_token VARCHAR(32) NOT NULL UNIQUE,

    -- --- Delivery decision ---
    decision        VARCHAR(16) NOT NULL
        CHECK (decision IN ('direct_play', 'direct_stream', 'transcode')),
    -- Coarse bucket of DecidePlayback's free-text reason. The prose is useful
    -- in a log line and useless in aggregate; these buckets are what answers
    -- "why are we transcoding so much".
    decision_reason VARCHAR(24) NOT NULL DEFAULT 'unspecified'
        -- No 'hdr' bucket: HDR never appears in a TranscodeReason. An HDR
        -- source transcodes because of its BIT DEPTH, and the tonemap is a
        -- consequence of that decision rather than its cause — the HDR
        -- dimension is captured properly by hdr_conversion below, which
        -- records what the pipeline did rather than guessing from prose.
        CHECK (decision_reason IN (
            'compatible', 'container', 'video_codec', 'audio_codec',
            'bit_depth', 'audio_track', 'unspecified'
        )),

    -- --- What the pipeline actually did ---
    output_codec   VARCHAR(8)  NOT NULL DEFAULT 'none'
        CHECK (output_codec IN ('none', 'copy', 'h264', 'hevc')),
    encoder_family VARCHAR(12) NOT NULL DEFAULT 'none'
        CHECK (encoder_family IN ('none', 'software', 'nvenc', 'qsv', 'vaapi', 'amf')),
    segment_format VARCHAR(8)  NOT NULL DEFAULT 'none'
        CHECK (segment_format IN ('none', 'fmp4', 'ts')),
    hdr_conversion VARCHAR(12) NOT NULL DEFAULT 'none'
        CHECK (hdr_conversion IN ('none', 'tonemap_cpu', 'tonemap_gpu', 'passthrough')),

    -- burn_in and subtitle_mode are the two fields the review's proposed schema
    -- did not have, and without them the rest is hard to interpret: subtitle
    -- burn-in forces the pipeline off the Tier-2 zero-copy GPU path
    -- (PlanDecode refuses it — the subtitles/overlay filters need CPU frames),
    -- so a burn-in session's startup and CPU cost look nothing like a plain
    -- transcode's. Absent this column a p95 regression concentrated in burn-in
    -- sessions has no dimension to show up in.
    burn_in       VARCHAR(8)  NOT NULL DEFAULT 'none'
        CHECK (burn_in IN ('none', 'text', 'bitmap')),
    subtitle_mode VARCHAR(12) NOT NULL DEFAULT 'none'
        CHECK (subtitle_mode IN ('none', 'external', 'embedded', 'burned')),

    -- Whether the detail-page hover pre-warm was adopted. The pre-warm exists
    -- to attack cold-transcode startup, and this is the column that says
    -- whether it works.
    prewarm VARCHAR(8) NOT NULL DEFAULT 'none'
        CHECK (prewarm IN ('none', 'hit', 'miss')),

    -- --- Startup (phase 1) ---
    -- Bounded at 10 minutes: anything beyond that is a client that slept, not a
    -- startup measurement, and letting it in would wreck the percentiles.
    click_to_first_frame_ms    INTEGER CHECK (click_to_first_frame_ms    BETWEEN 0 AND 600000),
    manifest_to_first_frame_ms INTEGER CHECK (manifest_to_first_frame_ms BETWEEN 0 AND 600000),

    -- --- Steady state (phase 2) ---
    -- Bounded above as well as below, for the same reason the startup columns
    -- are: rebuffer_ms is summed into the dashboard's rebuffer ratio, so a
    -- single absurd value distorts every window that contains it for the whole
    -- retention period. 86400000 ms is 24 hours, past any real playback.
    rebuffer_count     INTEGER NOT NULL DEFAULT 0 CHECK (rebuffer_count     BETWEEN 0 AND 100000),
    rebuffer_ms        INTEGER NOT NULL DEFAULT 0 CHECK (rebuffer_ms        BETWEEN 0 AND 86400000),
    rendition_switches INTEGER NOT NULL DEFAULT 0 CHECK (rendition_switches BETWEEN 0 AND 100000),
    -- How many times the DELIVERY was rebuilt underneath one viewing: a seek
    -- that re-anchors the server session, an audio-track switch, a fallback to
    -- transcode. The row stays open across these (one row per viewing, not per
    -- delivery), so this is what makes the churn visible instead of silently
    -- fragmenting one playback into several rows.
    delivery_rebuilds  INTEGER NOT NULL DEFAULT 0 CHECK (delivery_rebuilds  BETWEEN 0 AND 100000),
    watched_ms         INTEGER CHECK (watched_ms BETWEEN 0 AND 86400000),

    -- Coarse classes, never raw values: a raw throughput figure plus a
    -- timestamp is closer to a network fingerprint than to an operational
    -- metric, and the buckets answer the same questions.
    throughput_class VARCHAR(12) NOT NULL DEFAULT 'unknown'
        CHECK (throughput_class IN ('unknown', 'under_2m', '2m_5m', '5m_10m', '10m_25m', 'over_25m')),
    viewport_class   VARCHAR(12) NOT NULL DEFAULT 'unknown'
        CHECK (viewport_class IN ('unknown', 'sd', 'hd', 'fhd', 'qhd', 'uhd')),

    -- NULL until the session ends. A row that keeps a NULL terminal forever is
    -- itself a signal — the beacon never arrived, usually a hard kill.
    terminal VARCHAR(16)
        CHECK (terminal IN ('ended', 'user_exit', 'media_error', 'network_error', 'transcode_error', 'unknown')),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at   TIMESTAMPTZ
);

-- Retention sweep (the prune deletes by age).
CREATE INDEX idx_playback_qoe_retention ON playback_qoe_sessions (created_at);

-- NOTE: a (created_at DESC, decision) index was considered for the dashboard's
-- window queries and deliberately left out. Their predicate is a plain
-- created_at range, which idx_playback_qoe_retention above already satisfies at
-- a smaller size — the planner picks it every time and the composite went
-- unused, costing an extra index write on the playback hot path for nothing.

-- Per-profile insert-rate guard: the ingest endpoint counts a profile's recent
-- rows before accepting another, so this partial index keeps that check cheap.
CREATE INDEX idx_playback_qoe_profile_recent ON playback_qoe_sessions (profile_id, created_at DESC);
