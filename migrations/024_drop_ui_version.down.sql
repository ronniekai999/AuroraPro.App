-- Re-insert a default ui_version row in case of rollback. V1 was
-- the historical default — but nothing reads this row anymore, so
-- the value is purely informational.
INSERT INTO server_settings (key, value) VALUES ('ui_version', 'v1')
  ON CONFLICT (key) DO NOTHING;
