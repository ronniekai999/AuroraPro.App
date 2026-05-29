-- deep-debug carve-out C — allow the new 'pending_approval' request status.
--
-- requests.status had a CHECK constraint (migration 013) permitting only
-- pending/processing/available/failed. Quota-gated requests are now HELD as
-- 'pending_approval' until an admin approves/denies them, so the constraint
-- must be widened or every held INSERT fails with CHECK violation 23514.
-- Value list mirrors the RequestStatus constants in internal/models/models.go.
ALTER TABLE requests DROP CONSTRAINT IF EXISTS requests_status_check;
ALTER TABLE requests ADD CONSTRAINT requests_status_check
    CHECK (status IN ('pending', 'processing', 'available', 'failed', 'pending_approval'));
