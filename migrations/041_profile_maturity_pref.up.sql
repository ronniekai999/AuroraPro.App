-- Per-profile content-tone preference: a SOFT recall bias (distinct from the
-- HARD max_age_rating ceiling). The recommender adds a small cosine-distance
-- penalty proportional to how far an item's maturity tier sits from this
-- preference, so a profile can lean toward family or mature content without
-- excluding anything.
--
--   -1 = off (no bias, the default)
--    0 = family   (G, TV-Y/Y7, TV-G, PG, TV-PG)
--    1 = teen     (PG-13, TV-14)
--    2 = mature   (R, TV-MA, NC-17)
--
-- NOT NULL DEFAULT -1 keeps the recall penalty math NULL-free (off is just -1,
-- which NULLIF(...,-1) maps to "no penalty").
ALTER TABLE user_profiles
    ADD COLUMN IF NOT EXISTS maturity_pref SMALLINT NOT NULL DEFAULT -1
    CHECK (maturity_pref BETWEEN -1 AND 2);
