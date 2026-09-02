-- Rows already filed under the new bucket must be folded back into the old
-- vocabulary before the narrower CHECK can be re-applied.
UPDATE playback_qoe_sessions SET decision_reason = 'unspecified'
    WHERE decision_reason = 'bitrate';

ALTER TABLE playback_qoe_sessions
    DROP CONSTRAINT playback_qoe_sessions_decision_reason_check;

ALTER TABLE playback_qoe_sessions
    ADD CONSTRAINT playback_qoe_sessions_decision_reason_check
    CHECK (decision_reason IN (
        'compatible', 'container', 'video_codec', 'audio_codec',
        'bit_depth', 'audio_track', 'unspecified'
    ));
