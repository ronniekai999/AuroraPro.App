-- Revert the requests.status CHECK to the original four-value set.
-- Operator-only: this ADD CONSTRAINT will FAIL if any rows still have
-- status='pending_approval' — approve or deny all held requests first.
ALTER TABLE requests DROP CONSTRAINT IF EXISTS requests_status_check;
ALTER TABLE requests ADD CONSTRAINT requests_status_check
    CHECK (status IN ('pending', 'processing', 'available', 'failed'));
