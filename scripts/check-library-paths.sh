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

# EXACTLY the extensions IsVideoFile accepts (videoExtensions in
# internal/library/parser.go). Not a superset: an extra entry here is a FALSE
# ALL-CLEAR — a recorded row the scanner will never rediscover, reported as
# "will be found" while the scan prunes it and the sweep takes its title.
# TestCheckScriptExtensionsMatchIsVideoFile pins the two lists together.
VIDEO_RE='\.(mkv|mp4|avi|mov|wmv|flv|webm|m4v|mpg|mpeg|ts|m2ts)$'

# Byte collation. sort -u and comm both honour LC_COLLATE, and under a UTF-8
# locale two byte-distinct paths that strcoll ranks equal are treated as
# common by comm — dropping a genuinely-missing row and reporting all-clear.
# GNU sort also aborts on invalid UTF-8, which would silently truncate the
# disk side.
export LC_ALL=C

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

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

TOTAL_MISSING=0
TOTAL_UNKNOWN=0
CHECKED=0
CHECKED_FULLY=0
LIBS_MISSING=0

while IFS= read -r LIB; do
    [ -n "$LIB" ] || continue
    # Every query is checked. A psql that starts failing mid-run — the cluster
    # going away, a permission change — must not leave this reporting a green
    # all-clear on the libraries it never managed to read. "Could not check" is
    # not the same answer as "nothing to fix".
    exists="$(q "SELECT count(*) FROM libraries WHERE id = $LIB")" \
        || die "query failed for library $LIB — cannot say whether a scan would prune anything"
    if [ "$exists" != "1" ]; then
        # Not a skip. An id that does not exist is an operator error, and
        # answering it with a green summary is how a typo reads as safety.
        die "library $LIB does not exist"
    fi
    name="$(q "SELECT name FROM libraries WHERE id = $LIB")" || die "query failed for library $LIB"
    [ -n "$name" ] || name="(unnamed)"
    CHECKED=$((CHECKED + 1))

    ltype="$(q "SELECT type FROM libraries WHERE id = $LIB")" || die "query failed for library $LIB"
    roots="$(q "SELECT unnest(paths) FROM libraries WHERE id = $LIB")" || die "query failed for library $LIB"
    if [ -z "$roots" ]; then
        warn "library $LIB ($name) has no paths — it is not scanned at all"
        continue
    fi

    # ONE table, chosen by library type — pruneDeletedFiles branches on
    # `lib.Type == LibraryShows` and reads either GetEpisodeFilePathsForLibrary
    # or GetMediaFilePathsForLibrary, never both. Unioning them would report a
    # stray row of the other kind as prunable when the scan will not look at
    # it. The episode side joins through tv_seasons because that is the join
    # GetEpisodeFilePathsForLibrary uses; going via tv_episodes.media_item_id
    # would agree with this script and disagree with the scan wherever the two
    # have drifted.
    if [ "$ltype" = "show" ]; then
        sel="SELECT ef.path FROM episode_files ef
              JOIN tv_episodes te ON te.id = ef.episode_id
              JOIN tv_seasons  ts ON ts.id = te.season_id
              JOIN media_items mi ON mi.id = ts.media_item_id
             WHERE mi.library_id = $LIB"
    else
        sel="SELECT mf.path FROM media_files mf
              JOIN media_items mi ON mi.id = mf.media_item_id
             WHERE mi.library_id = $LIB"
    fi
    recorded="$(q "$sel")" || die "query failed for library $LIB"
    # How many paths SQL says there are, versus how many lines came back.
    # Everything below is line-oriented — psql -qtA and find both emit records
    # separated by newlines — so a path CONTAINING a newline arrives as two
    # lines and is compared as two paths. That is not merely an over-report: a
    # row spelling two real filenames in one value has both halves matched and
    # is declared safe, while the scanner compares the whole string and prunes
    # it. An empty path is the same shape (dropped by the blank-line filter,
    # so never reported missing at all). Neither can be handled by a
    # line-oriented diff, so refuse to answer rather than answer wrongly.
    n_rows="$(q "SELECT count(DISTINCT path) FROM ($sel) t")" \
        || die "query failed for library $LIB"

    # Walk each root the way the scanner does, and record WHY a root produced
    # nothing — that distinction decides whether a prune happens at all.
    #
    # unwalkable and unreadable are set by a plain loop, NOT inside a command
    # substitution or a pipeline. An earlier version assigned them in a
    # subshell, so they never reached the tests below and the whole branch was
    # dead code that had never once run.
    unwalkable=0
    unreadable=0
    : > "$WORK/disk"
    while IFS= read -r r; do
        [ -n "$r" ] || continue
        rc="$(canon "$r")"
        if [ ! -d "$rc" ] || [ ! -r "$rc" ]; then
            unwalkable=1
            continue
        fi
        # -type f, OR a symlink whose target resolves to a file under this
        # root. The scanner accepts a symlinked FILE as long as EvalSymlinks
        # lands inside the root and rejects it otherwise, so `find -type f`
        # alone missed every one and reported them as about to be pruned — an
        # unresolvable failure for the *arr-style layouts where symlinked media
        # is normal. Directory symlinks are still not followed: no -L, and the
        # resolved target must be a regular file.
        find "$rc" \( -type f -o -type l \) -print 2>"$WORK/finderr" \
        | while IFS= read -r f; do
            if [ -L "$f" ]; then
                t="$(realpath -e -- "$f" 2>/dev/null)" || continue
                case "$t/" in "$rc"/*) ;; *) continue ;; esac
                [ -f "$t" ] || continue
            fi
            printf '%s\n' "$f"
          done >> "$WORK/disk"
        [ -s "$WORK/finderr" ] && unreadable=1
    done <<< "$roots"

    disk_list="$(grep -Ei "$VIDEO_RE" "$WORK/disk" | sort -u)"

    # NOT canonicalised. The scanner compares its walk output against the RAW
    # recorded string by exact equality, so normalising this side would hide
    # precisely the disagreement that gets a row pruned: a recorded
    # "/srv//media/x.mkv" can never equal the walk's "/srv/media/x.mkv",
    # however equivalent they look. The ROOT is canonicalised above instead,
    # because filepath.Join cleans as it builds each child — which is what
    # makes the walk output canonical in the first place.
    db_list="$(printf '%s\n' "$recorded" | sed '/^$/d' | sort -u)"

    n_db=0; [ -n "$db_list" ] && n_db="$(printf '%s\n' "$db_list" | wc -l)"
    if [ "$n_db" != "$n_rows" ]; then
        die "library $LIB ($name): the database holds $n_rows distinct path(s) but they arrive as $n_db line(s) — at least one path contains a newline or is empty. This check is line-oriented and cannot compare those correctly, so it will not give an answer for this library. Find them with:
        SELECT id, path FROM media_files WHERE path = '' OR path LIKE E'%\\n%';
        SELECT id, path FROM episode_files WHERE path = '' OR path LIKE E'%\\n%';"
    fi

    # ── The scanner's own two escape hatches, before any diff ──────
    # Reporting rows as "will be pruned" when the scan is not going to prune at
    # all is not a harmless over-report: it is a FAIL the operator cannot drive
    # to zero, under an instruction not to start the server until they do.
    if [ "$unwalkable" -eq 1 ]; then
        # walkFailed — collectVideoFiles errors on a root, so ScanLibrary skips
        # the prune AND the sweep entirely. Nothing is deleted; the library is
        # also not really being scanned, which is worth saying.
        warn "library $LIB ($name): a configured path is missing or unreadable, so the scan will SKIP its prune — nothing will be deleted, but this library is not being scanned either"
        while IFS= read -r r; do
            [ -n "$r" ] || continue
            [ -d "$(canon "$r")" ] || printf '        missing root: %s\n' "$r"
        done <<< "$roots"
        continue
    fi
    if [ -z "$disk_list" ]; then
        # pruneDeletedFiles' zero-discovered guard: a walk that finds nothing
        # is treated as suspect (the classic present-but-empty NFS mount) and
        # prunes nothing. Common mid-move, when the new root exists but the
        # copy has not started.
        warn "library $LIB ($name): no media found under its paths, so the scan will prune nothing — but it will also show an empty library"
        continue
    fi

    missing="$(comm -23 <(printf '%s\n' "$db_list") <(printf '%s\n' "$disk_list") | sed '/^$/d')"
    unknown="$(comm -13 <(printf '%s\n' "$db_list") <(printf '%s\n' "$disk_list") | sed '/^$/d')"

    n_missing=0; [ -n "$missing" ] && n_missing="$(printf '%s\n' "$missing" | wc -l)"
    n_unknown=0; [ -n "$unknown" ] && n_unknown="$(printf '%s\n' "$unknown" | wc -l)"

    if [ "$n_missing" -gt 0 ]; then
        TOTAL_MISSING=$((TOTAL_MISSING + n_missing))
        LIBS_MISSING=$((LIBS_MISSING + 1))
        printf '\n'
        warn "library $LIB ($name): $n_missing recorded file(s) the scanner will NOT find."
        warn "These rows are pruned on the next scan, and any title left with no files is deleted with its watch history."
        if [ "$unreadable" -eq 1 ]; then
            # This is the one case where the count above can be too HIGH, and
            # saying only "re-run as root" understates it. pruneDeletedFiles
            # scopes the prune AROUND unreadable subtrees (underAnyPrefix), so
            # a row Aurora also cannot read is shielded, not pruned. This check
            # cannot reproduce that split without knowing what the SERVICE user
            # can read — which is not the user running this — so it counts them
            # as missing, because over-reporting is the safe direction and a
            # false all-clear here is a deleted catalog.
            warn "NOTE: part of this library was unreadable by $(id -un). Rows under an unreadable subtree are SHIELDED from the prune, not deleted — so some of the paths below may be counted here and left alone by the scan. Re-run as the user Aurora runs as (or root) to get an exact count."
        fi
        printf '%s\n' "$missing" | head -20 | sed 's/^/        /'
        [ "$n_missing" -gt 20 ] && printf '        … and %d more\n' "$((n_missing - 20))"
    else
        ok "library $LIB ($name): all $n_db recorded file(s) will be found"
    fi

    CHECKED_FULLY=$((CHECKED_FULLY + 1))
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
        "$TOTAL_MISSING recorded file(s) across $LIBS_MISSING librarie(s) would be PRUNED by the next scan. Do not start Aurora until this is 0." >&2
    exit 1
fi
ok "$CHECKED_FULLY of $CHECKED librarie(s) fully checked; nothing would be pruned. $TOTAL_UNKNOWN new file(s) would be added."
