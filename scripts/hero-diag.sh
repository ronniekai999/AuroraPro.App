#!/usr/bin/env bash
#
# hero-diag.sh — dump everything that decides what the Featured hero rail shows.
#
# The hero pipeline is: taste signals → centroid → vector recall → age filter →
# LLM rerank → 5 picks. A bad hero is almost never "the LLM chose badly"; it is
# usually that the candidates it had to choose FROM were already wrong. This
# reports each stage's inputs so the failure can be located instead of guessed.
#
# READ ONLY. Runs every statement under default_transaction_read_only=on, so it
# cannot modify the database even if a query here is wrong.
#
# Usage:
#   sudo bash scripts/hero-diag.sh                # list profiles, then exit
#   sudo bash scripts/hero-diag.sh <profile_id>   # full report for one profile
#
# Output goes to a report file; the path is printed at the end.
#
# PRIVACY: the report lists titles this profile has watched, rated and been
# recommended. That is the point — the diagnosis is about taste — but read it
# before sharing. It never contains DATABASE_URL, passwords or tokens.

set -euo pipefail

ENV_FILE="${AURORA_ENV_FILE:-/etc/aurora/aurora.env}"
OUT="${AURORA_DIAG_OUT:-/tmp/hero-diag-$(date -u +%Y%m%dT%H%M%SZ).txt}"

die() { printf 'error: %s\n' "$1" >&2; exit 1; }

# ── Connection ────────────────────────────────────────────────────────
# Read DATABASE_URL from the service's env file. Never echoed.
if [ -n "${DATABASE_URL:-}" ]; then
    :
elif [ -r "$ENV_FILE" ]; then
    DATABASE_URL=$(grep -E '^DATABASE_URL=' "$ENV_FILE" | head -1 | cut -d= -f2-) || true
    [ -n "${DATABASE_URL:-}" ] || die "no DATABASE_URL in $ENV_FILE"
else
    die "cannot read $ENV_FILE (try sudo), and DATABASE_URL is not set"
fi
export DATABASE_URL

command -v psql >/dev/null 2>&1 || die "psql not found (apt-get install -y postgresql-client)"

# default_transaction_read_only makes this script structurally incapable of
# writing, rather than merely intending not to.
export PGOPTIONS='-c default_transaction_read_only=on'

psql_q() { psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=0 "$@"; }

# ── No profile given: list them and stop ──────────────────────────────
if [ $# -lt 1 ]; then
    echo "Profiles on this server:"
    echo
    psql_q -P pager=off -c "
        SELECT p.id AS profile_id,
               u.username,
               p.name AS profile,
               p.is_default,
               COALESCE(NULLIF(p.max_age_rating,''),'(none — NO age filter)') AS max_age_rating,
               CASE p.maturity_pref
                    WHEN -1 THEN '-1 off (no tone bias)'
                    WHEN  0 THEN '0 family'
                    WHEN  1 THEN '1 teen'
                    WHEN  2 THEN '2 mature'
               END AS maturity_pref
        FROM user_profiles p
        JOIN users u ON u.id = p.user_id
        ORDER BY p.id;"
    echo
    echo "Re-run with a profile id, e.g.:  sudo bash $0 1"
    exit 0
fi

PID="$1"
case "$PID" in ''|*[!0-9]*) die "profile id must be a number, got '$PID'";; esac

exists=$(psql_q -tAc "SELECT 1 FROM user_profiles WHERE id = $PID") || true
[ "$exists" = "1" ] || die "no profile with id $PID (run with no arguments to list them)"

# ── Report ────────────────────────────────────────────────────────────
{
echo "=============================================================="
echo " Aurora hero diagnostics — profile $PID"
echo " generated $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "=============================================================="

echo
echo "## 1. The two knobs that decide whether maturity is considered at all"
echo
echo "max_age_rating is the HARD ceiling. When it is empty the server's"
echo "AllowedRatingsForMax() returns nil, which means NO age filtering — an"
echo "R-rated title is as eligible as a G one."
echo
echo "maturity_pref is the SOFT tone lean (-1 off, 0 family, 1 teen, 2 mature)."
echo "At -1 there is no distance penalty either."
echo
echo "If both are unset, recall is pure cosine similarity with zero maturity"
echo "awareness — which is the usual reason a family-taste profile is offered"
echo "hard-R crime drama."
psql_q -P pager=off -c "
    SELECT p.id, u.username, p.name,
           COALESCE(NULLIF(p.max_age_rating,''),'(none — NO hard filter)') AS max_age_rating,
           p.maturity_pref,
           CASE p.maturity_pref WHEN -1 THEN 'off — no tone bias' ELSE 'active' END AS soft_bias
    FROM user_profiles p JOIN users u ON u.id = p.user_id
    WHERE p.id = $PID;"

echo
echo "## 2. Signal inventory — what the taste centroid is built from"
echo
echo "Every source below is gated on the item having an embedding. Rows"
echo "without one are invisible to the recommender no matter how they were"
echo "rated. 'usable' is the count that actually reaches the centroid."
psql_q -P pager=off -c "
    SELECT 'watch_progress'  AS source,
           COUNT(*)          AS rows,
           COUNT(m.embedding) AS usable
      FROM watch_progress wp JOIN media_items m ON m.id = wp.media_item_id
     WHERE wp.profile_id = $PID
    UNION ALL
    SELECT 'watch_progress (completed)', COUNT(*), COUNT(m.embedding)
      FROM watch_progress wp JOIN media_items m ON m.id = wp.media_item_id
     WHERE wp.profile_id = $PID AND wp.completed
    UNION ALL
    SELECT 'taste_seeds (onboarding)', COUNT(*), COUNT(m.embedding)
      FROM taste_seeds ts JOIN media_items m ON m.id = ts.media_item_id
     WHERE ts.profile_id = $PID
    UNION ALL
    SELECT 'user_ratings 4-5 stars', COUNT(*), COUNT(m.embedding)
      FROM user_ratings ur JOIN media_items m ON m.id = ur.media_item_id
     WHERE ur.profile_id = $PID AND ur.stars >= 4
    UNION ALL
    SELECT 'user_ratings 1-2 stars (anti-taste)', COUNT(*), COUNT(m.embedding)
      FROM user_ratings ur JOIN media_items m ON m.id = ur.media_item_id
     WHERE ur.profile_id = $PID AND ur.stars BETWEEN 1 AND 2
    UNION ALL
    SELECT 'item_feedback thumbs-up', COUNT(*), COUNT(m.embedding)
      FROM item_feedback fb JOIN media_items m ON m.id = fb.media_item_id
     WHERE fb.profile_id = $PID AND fb.feedback = 'up';"

echo
echo "## 3. The recency slice — the ACTUAL input to the centroid"
echo
echo "The server takes the top 20 embedded items by recency across all four"
echo "sources and clusters them into taste modes. This is that slice. If it"
echo "does not look like this profile's taste, nothing downstream can recover."
echo
echo "Watch the 'via' column. Onboarding seeds are stamped completed=TRUE"
echo "unconditionally, so they outrank any watch still in progress no matter"
echo "how recent it is. A slice that is mostly seeds means the hero is still"
echo "recommending against what was clicked once during setup rather than"
echo "against what this profile actually watches."
psql_q -P pager=off -c "
    WITH slice AS (
      SELECT m.id, m.title, m.type::text AS type, m.year,
             COALESCE(NULLIF(m.content_rating,''),'?') AS rating,
             wp.completed, wp.updated_at AS ts, 'watched' AS via
        FROM watch_progress wp JOIN media_items m ON m.id = wp.media_item_id
       WHERE wp.profile_id = $PID AND m.embedding IS NOT NULL
      UNION ALL
      SELECT m.id, m.title, m.type::text, m.year,
             COALESCE(NULLIF(m.content_rating,''),'?'),
             TRUE, ts.created_at, 'onboarding seed'
        FROM taste_seeds ts JOIN media_items m ON m.id = ts.media_item_id
       WHERE ts.profile_id = $PID AND m.embedding IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM watch_progress w2
                          WHERE w2.profile_id = $PID AND w2.media_item_id = ts.media_item_id)
      UNION ALL
      SELECT m.id, m.title, m.type::text, m.year,
             COALESCE(NULLIF(m.content_rating,''),'?'),
             TRUE, fb.created_at, 'thumbs up'
        FROM item_feedback fb JOIN media_items m ON m.id = fb.media_item_id
       WHERE fb.profile_id = $PID AND fb.feedback = 'up' AND m.embedding IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM watch_progress w3
                          WHERE w3.profile_id = $PID AND w3.media_item_id = fb.media_item_id)
      UNION ALL
      SELECT m.id, m.title, m.type::text, m.year,
             COALESCE(NULLIF(m.content_rating,''),'?'),
             TRUE, ur.updated_at, 'rated ' || ur.stars || 'star'
        FROM user_ratings ur JOIN media_items m ON m.id = ur.media_item_id
       WHERE ur.profile_id = $PID AND ur.stars >= 4 AND m.embedding IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM watch_progress w4
                          WHERE w4.profile_id = $PID AND w4.media_item_id = ur.media_item_id)
    )
    SELECT s.title, s.type, s.year, s.rating, s.completed, s.via,
           COALESCE((SELECT string_agg(g.name, ', ' ORDER BY g.name)
                       FROM media_genres mg JOIN genres g ON g.id = mg.genre_id
                      WHERE mg.media_item_id = s.id), '') AS genres
      FROM slice s
     WHERE NOT EXISTS (SELECT 1 FROM user_ratings ur
                        WHERE ur.profile_id = $PID AND ur.media_item_id = s.id
                          AND ur.stars BETWEEN 1 AND 2)
     ORDER BY s.completed DESC, s.ts DESC
     LIMIT 20;"

echo
echo "## 4. Maturity mismatch — the headline number"
echo
echo "Left: the tone of what this profile actually likes. Right: the tone of"
echo "the library the recall draws from. A family-leaning taste inside a"
echo "mostly-mature library, with no filter set, gets a mature hero every"
echo "time — the LLM is picking the least-bad of a bad list."
psql_q -P pager=off -c "
    WITH liked AS (
      SELECT DISTINCT m.id, m.content_rating
        FROM watch_progress wp JOIN media_items m ON m.id = wp.media_item_id
       WHERE wp.profile_id = $PID AND m.embedding IS NOT NULL
      UNION
      SELECT DISTINCT m.id, m.content_rating
        FROM user_ratings ur JOIN media_items m ON m.id = ur.media_item_id
       WHERE ur.profile_id = $PID AND ur.stars >= 4
      UNION
      SELECT DISTINCT m.id, m.content_rating
        FROM taste_seeds ts JOIN media_items m ON m.id = ts.media_item_id
       WHERE ts.profile_id = $PID
    ), tier AS (
      SELECT CASE
               WHEN content_rating IN ('G','TV-Y','TV-G','TV-Y7','PG','TV-PG') THEN '0 family'
               WHEN content_rating IN ('PG-13','TV-14')                        THEN '1 teen'
               WHEN content_rating IN ('R','TV-MA','NC-17')                    THEN '2 mature'
               ELSE '? unrated/unknown'
             END AS tier
        FROM liked
    ), lib AS (
      SELECT CASE
               WHEN content_rating IN ('G','TV-Y','TV-G','TV-Y7','PG','TV-PG') THEN '0 family'
               WHEN content_rating IN ('PG-13','TV-14')                        THEN '1 teen'
               WHEN content_rating IN ('R','TV-MA','NC-17')                    THEN '2 mature'
               ELSE '? unrated/unknown'
             END AS tier
        FROM media_items WHERE embedding IS NOT NULL
    )
    SELECT COALESCE(t.tier, l.tier) AS tier,
           COALESCE(t.n,0)          AS profile_likes,
           COALESCE(l.n,0)          AS library_items,
           ROUND(100.0*COALESCE(l.n,0)/NULLIF(SUM(COALESCE(l.n,0)) OVER (),0),1) AS library_pct
      FROM (SELECT tier, COUNT(*) n FROM tier GROUP BY tier) t
      FULL JOIN (SELECT tier, COUNT(*) n FROM lib GROUP BY tier) l USING (tier)
     ORDER BY 1;"

echo
echo "## 5. Embedding coverage — what the recall can even see"
echo
echo "Unembedded items are unreachable by the hero, permanently. If coverage"
echo "is low the candidate pool is drawn from a fraction of the library."
psql_q -P pager=off -c "
    SELECT l.name AS library,
           COUNT(*)                                        AS items,
           COUNT(m.embedding)                              AS embedded,
           COUNT(*) - COUNT(m.embedding)                   AS missing,
           ROUND(100.0*COUNT(m.embedding)/NULLIF(COUNT(*),0),1) AS pct
      FROM media_items m
      LEFT JOIN libraries l ON l.id = m.library_id
     GROUP BY l.name
     UNION ALL
    SELECT '— TOTAL —', COUNT(*), COUNT(embedding),
           COUNT(*)-COUNT(embedding),
           ROUND(100.0*COUNT(embedding)/NULLIF(COUNT(*),0),1)
      FROM media_items
     ORDER BY 1;"

echo
echo "## 6. Anything the profile has already been shown"
echo
echo "The recommender DEMOTES picks it has shown recently rather than excluding"
echo "them, so this cannot starve the pool — it only rotates what leads."
psql_q -P pager=off -c "
    SELECT surface, COUNT(*) AS remembered, MIN(surfaced_at) AS oldest, MAX(surfaced_at) AS newest
      FROM recently_surfaced_items WHERE profile_id = $PID GROUP BY surface ORDER BY 1;"

echo
echo "## 7. Library size available to recall"
echo
echo "Unwatched + embedded is the true candidate universe. If this is small,"
echo "the hero is choosing from very little."
psql_q -P pager=off -c "
    SELECT COUNT(*) AS unwatched_and_embedded
      FROM media_items m
     WHERE m.embedding IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM watch_progress wp
                        WHERE wp.profile_id = $PID AND wp.media_item_id = m.id);"

echo
echo "=============================================================="
echo " end of report"
echo "=============================================================="
} > "$OUT" 2>&1

echo "Report written to: $OUT"
echo
echo "Review it (it lists this profile's viewing history), then share it."
