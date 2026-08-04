ALTER TABLE users
    DROP COLUMN IF EXISTS display_name,
    DROP COLUMN IF EXISTS bio,
    DROP COLUMN IF EXISTS social_x,
    DROP COLUMN IF EXISTS social_instagram,
    DROP COLUMN IF EXISTS social_facebook,
    DROP COLUMN IF EXISTS social_snapchat,
    DROP COLUMN IF EXISTS share_watch_history;
