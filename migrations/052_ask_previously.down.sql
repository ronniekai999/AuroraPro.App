DROP TABLE IF EXISTS recap_question_rate_events;
DROP TRIGGER IF EXISTS trg_recap_conversation_requests_updated_at ON recap_conversation_requests;
DROP TABLE IF EXISTS recap_conversation_requests;
DROP TABLE IF EXISTS recap_conversation_turns;
DROP TRIGGER IF EXISTS trg_recap_conversations_updated_at ON recap_conversations;
DROP TABLE IF EXISTS recap_conversations;

ALTER TABLE episode_recaps
    DROP COLUMN IF EXISTS suggested_questions;
