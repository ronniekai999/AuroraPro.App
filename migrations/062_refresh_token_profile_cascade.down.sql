ALTER TABLE refresh_tokens DROP CONSTRAINT IF EXISTS refresh_tokens_active_profile_id_fkey;
ALTER TABLE refresh_tokens ADD CONSTRAINT refresh_tokens_active_profile_id_fkey
    FOREIGN KEY (active_profile_id) REFERENCES user_profiles(id) ON DELETE SET NULL;
