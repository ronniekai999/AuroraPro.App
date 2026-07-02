-- 044 — optional deep link on notifications. First consumer: the watch-party
-- highlight reel, which is generated minutes AFTER the party UI tears down,
-- so the bell notification is the only surface that can point at the MP4.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS link TEXT;
