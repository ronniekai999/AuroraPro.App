-- Phase 8 — V1 retirement cleanup.
--
-- Drops the `ui_version` row from `server_settings`. Nothing reads
-- it after V1's removal (router.go's readUIVersion + admin's
-- ui_version validator are both gone). Leaving the row would mean
-- it shows up in `GET /api/admin/settings` responses indefinitely;
-- dropping it now makes the settings list reflect actual surface.
--
-- Safe to no-op: `DELETE WHERE key=...` matches zero rows on a
-- fresh install that never had V1 turned on. No constraints or
-- cascades depend on this row.

DELETE FROM server_settings WHERE key = 'ui_version';
