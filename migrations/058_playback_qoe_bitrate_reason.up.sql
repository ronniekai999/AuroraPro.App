-- Migration 058: widen the playback QoE decision_reason vocabulary with
-- 'bitrate'.
--
-- The decision engine gained a client-declared bitrate ceiling (the
-- `max_bps` parameter on stream-info and session create): a source whose
-- probed bitrate exceeds it can neither direct-play nor remux — both deliver
-- the source bitrate verbatim and a single-rendition stream has no way to
-- adapt down — so it transcodes onto a ladder capped at the ceiling. That is
-- a new cause with no existing bucket: it is not a codec, container, depth or
-- track problem, and filing it under 'unspecified' would hide the one
-- transcode reason an operator can address by changing a setting.
--
-- The CHECK is replaced rather than altered in place (Postgres has no ALTER
-- CONSTRAINT for CHECK). The constraint name is the one Postgres generated
-- for the inline column CHECK in migration 056 (<table>_<column>_check).
-- The DROP is deliberately NOT `IF EXISTS`: if the name ever differed, a
-- lenient drop would leave the old CHECK in place beside the new one and
-- every 'bitrate' row would be rejected at runtime — the exact failure the
-- vocabulary test exists to prevent — whereas a strict drop fails here, at
-- migration time, where it is seen.

ALTER TABLE playback_qoe_sessions
    DROP CONSTRAINT playback_qoe_sessions_decision_reason_check;

ALTER TABLE playback_qoe_sessions
    ADD CONSTRAINT playback_qoe_sessions_decision_reason_check
    CHECK (decision_reason IN (
        'compatible', 'container', 'video_codec', 'audio_codec',
        'bit_depth', 'audio_track', 'bitrate', 'unspecified'
    ));
