-- A session bound to a deleted profile is deleted with it. Migration 055 made
-- the binding ON DELETE SET NULL, and an unbound session acts as the account
-- default, so a kid's session would wake up on the parent's profile past its
-- PIN. DeleteProfile deleted the bound rows first, but a row bound to the
-- profile in between (a token refresh, or a switch) still had its binding
-- nulled by the profile's delete. With CASCADE the profile's delete takes
-- every bound row with it, whenever it was bound.
ALTER TABLE refresh_tokens DROP CONSTRAINT IF EXISTS refresh_tokens_active_profile_id_fkey;
ALTER TABLE refresh_tokens ADD CONSTRAINT refresh_tokens_active_profile_id_fkey
    FOREIGN KEY (active_profile_id) REFERENCES user_profiles(id) ON DELETE CASCADE;
