-- Rollback 047: drop Web Push subscriptions. Devices re-subscribe on next
-- app boot if the feature returns; nothing else references this table.
DROP TABLE IF EXISTS push_subscriptions;
