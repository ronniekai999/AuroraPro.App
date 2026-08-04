-- Member profiles (social phase 1): account-level identity card fields.
--
-- These live on users (not user_profiles) deliberately — user_profiles are
-- the Netflix-style sub-profiles WITHIN one account; the member profile is
-- the account's single outward face shown to other signed-in members.
--
-- share_watch_history is the privacy gate for the profile page's
-- "Recently Watched" strip (and, next migration, the followed-members home
-- rail). Opt-in: defaults FALSE so nobody's history becomes visible by the
-- mere act of upgrading.
--
-- Social columns store bare handles (no "@", no URL) — per-network shape is
-- enforced at the API; the frontend composes links against fixed domains.
-- All columns NOT NULL DEFAULT '' matching the avatar_url convention set by
-- migration 009 (empty string = unset; no NULL tri-state to scan around).

ALTER TABLE users
    ADD COLUMN display_name        VARCHAR(80)  NOT NULL DEFAULT '',
    ADD COLUMN bio                 VARCHAR(500) NOT NULL DEFAULT '',
    ADD COLUMN social_x            VARCHAR(30)  NOT NULL DEFAULT '',
    ADD COLUMN social_instagram    VARCHAR(40)  NOT NULL DEFAULT '',
    ADD COLUMN social_facebook     VARCHAR(60)  NOT NULL DEFAULT '',
    ADD COLUMN social_snapchat     VARCHAR(30)  NOT NULL DEFAULT '',
    ADD COLUMN share_watch_history BOOLEAN      NOT NULL DEFAULT FALSE;
