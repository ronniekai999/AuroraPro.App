#!/usr/bin/env bash
#
# Aurora — will the next scan delete anything?
#
# Compares every path Aurora has RECORDED against what its scanner will
# actually FIND on disk, per library. Anything recorded but not found is
# pruned on the next scan, and if that empties a title, the empty-item sweep
# deletes the catalog row and cascades its watch progress, ratings, feedback,
# taste seeds, collections and embedding.
#
# Run it after moving media (see docs/moving-media-paths.md), after restoring a
# backup, or any time you want to know what a scan is about to do. It only
# reads.
#
# WHY THIS EXISTS AND NOT A SQL QUERY
#
# The obvious check — "is every recorded path under its library's root, and
# does it exist?" — is a string test plus a stat, and the scanner does neither.
# It matches recorded paths against filepath.WalkDir output by exact string
# equality, so two states pass that check and are then pruned wholesale:
#
#   - A DIRECTORY SYMLINK inside a root. WalkDir does not descend into one;
#     `test -e` follows it happily. This is the natural shape of a staged move
#     ("copy most of it, symlink the rest in for now").
#   - A NON-CANONICAL path. WalkDir builds children with filepath.Join, which
#     cleans, so a doubled slash or a "/./" in a recorded path can never equal
#     what the walk produces — while comparing that path against a root spelled
#     the same way looks perfectly consistent.
#
# Both were demonstrated to wipe an entire catalog while the string check
# reported clean. So this reproduces the walk instead of modelling it: `find`
# without -L declines directory symlinks exactly as WalkDir does, and both
# sides are lexically normalised (realpath -ms — no symlink resolution, which
# is filepath.Clean's exact behaviour) before they are compared.
#
# Usage:
#   sudo ./scripts/check-library-paths.sh            # all libraries
#   sudo ./scripts/check-library-paths.sh 1 3        # only these library ids
#   AURORA_DB=aurora ./scripts/check-library-paths.sh
#
# Exit: 0 = nothing would be pruned. 1 = something would. 2 = could not check.
set -uo pipefail

DB_NAME="${AURORA_DB:-aurora}"

# Extensions the scanner treats as video. Keep in step with IsVideoFile in
# internal/library/scanner.go — a missing one here shows up as a false alarm
# (a file on disk that the DB does not have), never as a false all-clear.
VIDEO_RE='\.(mkv|mp4|m4v|avi|mov|wmv|flv|webm|mpg|mpeg|m2ts|ts|vob|ogv|3gp|mts)$'

info() { printf '\033[1;34m[INFO]\033[0m  %s\n' "$1"; }
warn() { printf '\033[1;33m[WARN]\033[0m  %s\n' "$1"; }
ok()   { printf '\033[1;32m[ OK ]\033[0m  %s\n' "$1"; }
die()  { printf '\033[1;31m[FAIL]\033[0m %s\n' "$1" >&2; exit 2; }

command -v realpath >/dev/null 2>&1 || die "realpath not found (coreutils)"
command -v psql     >/dev/null 2>&1 || die "psql not found"

# ── Database access ───────────────────────────────────────────────
PSQL=(sudo -u postgres psql -qtA -v ON_ERROR_STOP=1 "$DB_NAME")
if ! "${PSQL[@]}" -c 'SELECT 1' >/dev/null 2>&1; then
    DB_URL="$(grep -oP '(?<=^DATABASE_URL=).*' /etc/aurora/aurora.env 2>/dev/null || true)"
    [ -n "$DB_URL" ] || die "cannot reach the database as the postgres user, and no DATABASE_URL in /etc/aurora/aurora.env"
    PSQL=(psql -qtA -v ON_ERROR_STOP=1 "$DB_URL")
    "${PSQL[@]}" -c 'SELECT 1' >/dev/null 2>&1 || die "cannot reach the database with DATABASE_URL either"
fi
q() { "${PSQL[@]}" -c "$1"; }

# canon: lexical normalisation only — no symlink resolution. This is what
# filepath.Clean does, and resolving symlinks here would hide the very case
# this script exists to catch.
canon() { realpath -ms -- "$1"; }

# ── Which libraries ───────────────────────────────────────────────
if [ "$#" -gt 0 ]; then
    for arg in "$@"; do
        case "$arg" in ''|*[!0-9]*) die "library ids must be numeric, got: $arg" ;; esac
    done
    LIB_IDS="$(printf '%s\n' "$@")"
else
    LIB_IDS="$(q 'SELECT id FROM libraries ORDER BY id')" || die "could not list libraries"
fi
[ -n "$LIB_IDS" ] || die "no libraries found in $DB_NAME"

TOTAL_MISSING=0
TOTAL_UNKNOWN=0
CHECKED=0

while IFS= read -r LIB; do
    [ -n "$LIB" ] || continue
    name="$(q "SELECT name FROM libraries WHERE id = $LIB")"
    [ -n "$name" ] || { warn "library $LIB does not exist — skipping"; continue; }
    CHECKED=$((CHECKED + 1))

    roots="$(q "SELECT unnest(paths) FROM libraries WHERE id = $LIB")"
    if [ -z "$roots" ]; then
        warn "library $LIB ($name) has no paths — skipping"
        continue
    fi

    # Recorded: movie rows hang off media_items; episode rows reach the
    # library through tv_seasons, which is the join the scanner's own
    # GetEpisodeFilePathsForLibrary uses. Going via tv_episodes.media_item_id
    # instead would agree with this script and disagree with the scan on any
    # row where the two have drifted.
    recorded="$(q "
        SELECT mf.path FROM media_files mf
          JOIN media_items mi ON mi.id = mf.media_item_id
         WHERE mi.library_id = $LIB
        UNION
        SELECT ef.path FROM episode_files ef
          JOIN tv_episodes te ON te.id = ef.episode_id
          JOIN tv_seasons  ts ON ts.id = te.season_id
          JOIN media_items mi ON mi.id = ts.media_item_id
         WHERE mi.library_id = $LIB")" || die "query failed for library $LIB"

    unwalkable=0
    disk_list="$(
        while IFS= read -r r; do
            [ -n "$r" ] || continue
            rc="$(canon "$r")"
            if [ ! -d "$rc" ]; then
                unwalkable=1
                continue
            fi
            # No -L: WalkDir does not follow directory symlinks, and neither
            # must this.
            find "$rc" -type f 2>/dev/null
        done <<< "$roots" | grep -Ei "$VIDEO_RE" | sort -u
    )"

    # NOT canonicalised. The scanner compares its walk output against the
    # RAW recorded string by exact equality (pruneDeletedFiles builds a set of
    # discovered paths and asks whether each DB path is in it), so normalising
    # this side would hide precisely the disagreement that gets a row pruned:
    # a recorded "/srv//media/x.mkv" can never equal the walk's
    # "/srv/media/x.mkv", however equivalent they look. The ROOT is
    # canonicalised above instead, because filepath.Join cleans as it builds
    # each child — which is what makes the walk output canonical in the first
    # place.
    db_list="$(printf '%s\n' "$recorded" | sed '/^$/d' | sort -u)"

    missing="$(comm -23 <(printf '%s\n' "$db_list") <(printf '%s\n' "$disk_list") | sed '/^$/d')"
    unknown="$(comm -13 <(printf '%s\n' "$db_list") <(printf '%s\n' "$disk_list") | sed '/^$/d')"

    n_missing=0; [ -n "$missing" ] && n_missing="$(printf '%s\n' "$missing" | wc -l)"
    n_unknown=0; [ -n "$unknown" ] && n_unknown="$(printf '%s\n' "$unknown" | wc -l)"

    if [ "$n_missing" -gt 0 ]; then
        TOTAL_MISSING=$((TOTAL_MISSING + n_missing))
        printf '\n'
        warn "library $LIB ($name): $n_missing recorded file(s) the scanner will NOT find."
        warn "These rows are pruned on the next scan, and any title left with no files is deleted with its watch history."
        printf '%s\n' "$missing" | head -20 | sed 's/^/        /'
        [ "$n_missing" -gt 20 ] && printf '        … and %d more\n' "$((n_missing - 20))"
    elif [ "$unwalkable" -eq 1 ]; then
        # A root that cannot be walked trips the scanner's own walkFailed
        # guard, so nothing is pruned — but the library is not being scanned
        # either, and that is worth saying out loud.
        warn "library $LIB ($name): every recorded file was found, but a configured path is missing or unreadable — that root is not being scanned"
    else
        ok "library $LIB ($name): all $( [ -n "$db_list" ] && printf '%s\n' "$db_list" | wc -l || echo 0) recorded file(s) will be found"
    fi

    if [ "$n_unknown" -gt 0 ]; then
        TOTAL_UNKNOWN=$((TOTAL_UNKNOWN + n_unknown))
        info "library $LIB ($name): $n_unknown file(s) on disk are not in the catalog yet — the next scan will add them (this is not a problem)"
    fi
done <<< "$LIB_IDS"

printf '\n'
if [ "$TOTAL_MISSING" -gt 0 ]; then
    # Exit 1, not 2: this is a successful check with a bad answer, which is
    # different from being unable to check at all.
    printf '\033[1;31m[FAIL]\033[0m %s\n' \
        "$TOTAL_MISSING recorded file(s) across $CHECKED librarie(s) would be PRUNED by the next scan. Do not start Aurora until this is 0." >&2
    exit 1
fi
ok "checked $CHECKED librarie(s); nothing would be pruned. $TOTAL_UNKNOWN new file(s) would be added."
