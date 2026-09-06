#!/usr/bin/env bash
#
# Aurora — will the next scan delete anything?
#
# Compares every path Aurora has RECORDED against what its scanner will
# actually FIND on disk, per library. Anything recorded but not found is
# pruned on the next scan, and a title left with no files is then deleted by
# the empty-item sweep, cascading its watch progress, ratings, feedback,
# taste seeds, collections and embedding.
#
# NOTE the sweep is NOT conditional on the prune having removed anything.
# DeleteEmptyMediaItems runs on every scan that walks cleanly and discovers a
# file, so a media_items row that ALREADY has no file rows is deleted with its
# cascade even on a run this script calls clean. That is outside what this can
# predict — it compares recorded paths against the disk, and such a row has no
# recorded path left to compare.
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
# without -L declines directory symlinks exactly as WalkDir does.
#
# The RECORDED side is deliberately NOT normalised — see the comment above
# db_list. Normalising it would make the second case above compare equal and
# vanish, which is the catalog-wiping false all-clear this script exists to
# catch. Only the ROOT is normalised, and it is normalised TWICE, because the
# scanner uses two different forms of it: `realpath -ms` (lexical, filepath.
# Clean's behaviour) for the prefix the walk labels children with, and
# `realpath -e` (symlink-resolving, EvalSymlinks' behaviour) for the root the
# symlink-escape guard tests containment against.
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

# A literal newline, for the disk-side filename check. Written once so the
# `case` pattern below cannot be mistaken for a two-character escape.
NL='
'

info() { printf '\033[1;34m[INFO]\033[0m  %s\n' "$1"; }
warn() { printf '\033[1;33m[WARN]\033[0m  %s\n' "$1"; }
ok()   { printf '\033[1;32m[ OK ]\033[0m  %s\n' "$1"; }
die()  { printf '\033[1;31m[FAIL]\033[0m %s\n' "$1" >&2; exit 2; }

# Every external this script's ANSWER depends on. A missing one is not a
# degraded check, it is a wrong one: `comm` failing leaves `missing` empty,
# which reads as "nothing is missing" and prints the all-clear. There is no
# `set -e` here (deliberately — the per-library loop must survive one library
# failing), so nothing else catches it.
for tool in realpath psql comm sort find grep sed wc; do
    command -v "$tool" >/dev/null 2>&1 \
        || die "$tool not found — this check cannot run, and a missing one of these does not fail loudly: an empty result from it reads as 'nothing would be pruned'"
done

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

# first_untraversable PATH — prints the first component of PATH, walking down
# from /, that EXISTS but this user cannot traverse; returns 1 if there is none.
#
# This exists because `realpath -e` collapses two states the scanner treats as
# OPPOSITES. It fails with ENOENT for a root that is genuinely gone — which is
# EvalSymlinks failing, hence walkFailed, hence no prune at all — and it fails
# identically with EACCES when a PARENT of the root is not traversable by us,
# which the service user may well traverse fine. Reading the second as the
# first reports "the path does not exist, nothing will be deleted" and exits 0
# while the scan walks the root, discovers files, and prunes every recorded row
# it does not find. Reproduced with a 0750 parent owned by the service user —
# the ordinary way media is set up — run by an operator not in its group.
#
# Component-at-a-time with parameter expansion rather than IFS splitting: no
# globbing, no IFS to restore, and `..` is already refused before we get here.
first_untraversable() {
    local acc="" rest="${1#/}" seg
    while [ -n "$rest" ]; do
        seg="${rest%%/*}"
        acc="$acc/$seg"
        # A component that cannot be stat'd ends the walk. Its parent WAS
        # traversable (or we would have returned above), so this is a genuine
        # ENOENT — the caller's realpath -e will agree, and that is walkFailed.
        [ -e "$acc" ] || return 1
        [ -x "$acc" ] || { printf '%s\n' "$acc"; return 0; }
        [ "$rest" = "$seg" ] && break
        rest="${rest#*/}"
    done
    return 1
}

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
    # The third newline vector, after recorded paths and on-disk filenames.
    # It has to be asked of SQL: `roots` is consumed by `while IFS= read -r r`,
    # so by the time a root is in hand it has ALREADY been split into two and
    # both halves would be walked as separate roots. A check on $r inside that
    # loop cannot fire — it was written that way first, and was dead code.
    n_badroot="$(q "SELECT count(*) FROM libraries, unnest(paths) AS p WHERE id = $LIB AND (p = '' OR p LIKE E'%\\n%')")" \
        || die "query failed for library $LIB"
    if [ "$n_badroot" != "0" ]; then
        die "library $LIB ($name): $n_badroot entry in libraries.paths is empty or contains a newline. A newline is read here as two separate roots and an empty entry makes the SCAN's own EvalSymlinks fail (skipping its prune entirely), so nothing this check reported about this library would be meaningful. Inspect it with:
        SELECT id, name, paths FROM libraries WHERE id = $LIB;"
    fi
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

    # Everything below is line-oriented — psql -qtA and find both emit records
    # separated by newlines — so a path CONTAINING a newline arrives as two
    # lines and is compared as two paths. That is not merely an over-report: a
    # row spelling two real filenames in one value has both halves matched and
    # is declared safe, while the scanner keys on the whole string and prunes
    # it. An empty path is the same shape (dropped by the blank-line filter,
    # so never reported missing at all).
    #
    # ASK THE DATABASE, do not infer it from a line count. Comparing
    # count(DISTINCT path) against the number of lines looks equivalent and is
    # not: the line side is de-duplicated by `sort -u`, so rows 'A' and
    # 'A\nB' give 2 distinct paths AND 2 lines (A, B) and the check passes —
    # while the scan prunes the second row. That is the exact false all-clear
    # the count was added to close, reintroduced by the de-duplication.
    n_bad="$(q "SELECT count(*) FROM ($sel) t WHERE path = '' OR path LIKE E'%\\n%'")" \
        || die "query failed for library $LIB"
    if [ "$n_bad" != "0" ]; then
        die "library $LIB ($name): $n_bad recorded path(s) are empty or contain a newline. This check is line-oriented and cannot compare those correctly, so it will not give an answer for this library. Find them with:
        SELECT id, path FROM media_files  WHERE path = '' OR path LIKE E'%\\n%';
        SELECT id, path FROM episode_files WHERE path = '' OR path LIKE E'%\\n%';"
    fi

    # Walk each root the way the scanner does, and classify WHY a root produced
    # nothing — that distinction decides whether a prune happens at all.
    #
    # The three states below are NOT interchangeable, and collapsing them was a
    # false all-clear. collectVideoFiles returns an error — the only thing that
    # sets walkFailed and skips the prune wholesale — on EXACTLY ONE condition:
    # EvalSymlinks(root) failing, i.e. the root is absent or dangling. Its walk
    # callback returns nil on every error, so `walkErr` is always nil. A root
    # that EXISTS but this user cannot read is therefore NOT walkFailed: the
    # scanner notes it unreadable and shields it — but only if the SERVICE user
    # cannot read it either. Under `sudo` on an NFS export with root_squash, or
    # run unprivileged, this check can see less than Aurora does; the scan then
    # walks the root cleanly and prunes against it. Predicting "nothing will be
    # deleted" from our own inability to look is how that becomes a wiped
    # catalog.
    #
    # rootmissing  → matches walkFailed. The prune really is skipped. Safe.
    # rootopaque   → we cannot see what Aurora will see. UNDECIDABLE, exit 2.
    #
    # These are set by a plain loop, NOT inside a command
    # substitution or a pipeline. An earlier version assigned them in a
    # subshell, so they never reached the tests below and the whole branch was
    # dead code that had never once run.
    rootmissing=0
    rootopaque=""
    unreadable=0
    : > "$WORK/disk"
    : > "$WORK/badnames"
    while IFS= read -r r; do
        [ -n "$r" ] || continue
        # A `..` component after a symlinked one resolves differently in the
        # three places that matter: `realpath -ms` collapses `..` lexically
        # BEFORE resolving symlinks, EvalSymlinks resolves it against the
        # already-resolved prefix, and WalkDir hands the raw path to the
        # kernel. For a root like /srv/link/../media those are three different
        # directories, so this check would walk a tree the scan does not.
        # Only a hand-written UPDATE can produce it (the app stores
        # EvalSymlinks output, which has no `..`), and refusing is cheap.
        # A relative root resolves against whoever is running — this check's
        # working directory, not the service's. Same provenance as `..`
        # (only a hand-written UPDATE makes one), same answer.
        case "$r" in
            /*) ;;
            *) die "library $LIB ($name): the root $r is not absolute. It would resolve against this check's working directory and against Aurora's separately, so the two would examine different trees." ;;
        esac
        case "/$r/" in
            */../*) die "library $LIB ($name): the root $r contains a '..' component. Its meaning depends on whether the preceding components are symlinks, and this check, the scanner's containment guard and the kernel would each resolve it differently — so no answer here would be trustworthy. Replace it with the path 'readlink -f' prints." ;;
        esac
        rc="$(canon "$r")"
        # EvalSymlinks-equivalent: follows symlinks and fails if the target
        # does not exist. This is the root the scanner tests CONTAINMENT
        # against; $rc is the one it PREFIXES walk output with. They differ
        # whenever a root has a symlinked component, and conflating them is
        # what let a symlinked library read as empty.
        # BEFORE realpath -e, which cannot tell "gone" from "not mine to see".
        if blocked="$(first_untraversable "$rc")"; then
            rootopaque="$rootopaque
        $r (cannot traverse $blocked as $(id -un))"
            continue
        fi
        if ! rr="$(realpath -e -- "$rc" 2>/dev/null)"; then
            rootmissing=1
            continue
        fi
        if [ ! -d "$rc" ]; then
            # A root that resolves to something other than a directory. WalkDir
            # visits it as a single entry, so if it happens to carry a video
            # extension the scan discovers exactly one file and prunes the
            # whole library against it. Too strange to model; refuse to answer.
            rootopaque="$rootopaque
        $r (not a directory)"
            continue
        fi
        if [ ! -r "$rc" ] || [ ! -x "$rc" ]; then
            rootopaque="$rootopaque
        $r (unreadable by $(id -un))"
            continue
        fi
        # `! -type d` is exactly the scanner's `!d.IsDir()`, on the same lstat
        # semantics: a directory symlink is -type l here and IsDir()==false
        # there, so both process it as a candidate rather than descending into
        # it. Narrower filters were wrong in both directions — `-type f` alone
        # dropped every symlinked file (normal in *arr layouts) and reported
        # them as about to be pruned, and requiring the target be a regular
        # file dropped the symlink-to-directory and the FIFO that the scanner
        # does accept.
        # -print0. `find -print` splits a filename containing a newline across
        # two lines, and the truncated FIRST half can collide with a recorded
        # path whose file is genuinely gone — reporting it found. That is the
        # DB-side newline hazard (closed by the n_bad query above) mirrored on
        # the disk side, and leaving it open while the comments claimed
        # newlines were handled was worse than not claiming it.
        find "$rc" ! -type d -print0 2>"$WORK/finderr" \
        | while IFS= read -r -d '' f; do
            case "$f" in
                *"$NL"*)
                    # Only a video-extension name can affect the comparison;
                    # anything else is filtered out below regardless.
                    printf '%s' "$f" | grep -qEi "$VIDEO_RE" \
                        && printf '%s\n' "$f" >> "$WORK/badnames"
                    continue ;;
            esac
            if [ -L "$f" ]; then
                # The scanner's symlink-escape guard, on ITS roots: resolve the
                # link and require the result at or under the RESOLVED root.
                t="$(realpath -e -- "$f" 2>/dev/null)" || continue
                case "$t/" in "$rr"/*) ;; *) [ "$t" = "$rr" ] || continue ;; esac
            fi
            printf '%s\n' "$f"
          done >> "$WORK/disk"
        [ -s "$WORK/finderr" ] && unreadable=1
    done <<< "$roots"

    # rootmissing DOMINATES rootopaque, and is therefore tested first (below,
    # after the disk list is built). In Go, ANY root failing EvalSymlinks makes
    # collectVideoFiles error, which sets walkFailed for the WHOLE library and
    # skips both the prune and the sweep — so a library with one absent root
    # and one unreadable root is not going to be pruned whatever we can or
    # cannot read. Dying here would be an over-report the operator cannot
    # drive to zero, under an instruction not to start the server until they do.
    if [ -s "$WORK/badnames" ] && [ "$rootmissing" -eq 0 ]; then
        die "library $LIB ($name): $(wc -l < "$WORK/badnames") file(s) on disk have a newline in their name. This check is line-oriented and would compare a truncated half of each, which can read as a match for a recorded path whose file is gone. Rename them, or check this library by hand:
$(sed 's/^/        /' "$WORK/badnames" | head -10)"
    fi

    if [ -n "$rootopaque" ] && [ "$rootmissing" -eq 0 ]; then
        die "library $LIB ($name): cannot inspect these roots:$rootopaque
    Aurora may well be able to read it, in which case the next scan WILL walk it and prune against what it finds — so this check cannot tell you it is safe. Re-run as the user Aurora runs as."
    fi

    # Status-checked, both stages. An empty disk_list is the input to the
    # zero-discovered branch, which answers "the scan will prune nothing" and
    # exits 0 — so a `sort` that exists and FAILS (a full /tmp, a corrupt
    # binary, an aborted collation) produces the one answer that must never be
    # produced by accident. `command -v` does not see that; only the status
    # does. grep's status is deliberately NOT fatal on 1, which just means no
    # video files matched.
    grep -Ei "$VIDEO_RE" "$WORK/disk" > "$WORK/disk.video"
    gs=$?
    [ "$gs" -le 1 ] || die "library $LIB ($name): grep failed while filtering the discovered files (status $gs). No answer was produced, and an empty result here reads as 'no media found, nothing will be pruned'."
    if ! disk_list="$(sort -u "$WORK/disk.video")"; then
        die "library $LIB ($name): sort failed while ordering the discovered files. No answer was produced, and an empty result here reads as 'no media found, nothing will be pruned'."
    fi

    # NOT canonicalised. The scanner compares its walk output against the RAW
    # recorded string by exact equality, so normalising this side would hide
    # precisely the disagreement that gets a row pruned: a recorded
    # "/srv//media/x.mkv" can never equal the walk's "/srv/media/x.mkv",
    # however equivalent they look. The ROOT is canonicalised above instead,
    # because filepath.Join cleans as it builds each child — which is what
    # makes the walk output canonical in the first place.
    if ! db_list="$(printf '%s\n' "$recorded" | sed '/^$/d' | sort -u)"; then
        die "library $LIB ($name): sort or sed failed while ordering the recorded paths. An empty result here reads as 'this library records no files'."
    fi
    n_db=0; [ -n "$db_list" ] && n_db="$(printf '%s\n' "$db_list" | wc -l)"

    # ── The scanner's own two escape hatches, before any diff ──────
    # Reporting rows as "will be pruned" when the scan is not going to prune at
    # all is not a harmless over-report: it is a FAIL the operator cannot drive
    # to zero, under an instruction not to start the server until they do.
    if [ "$rootmissing" -eq 1 ]; then
        # walkFailed — EvalSymlinks fails on a root, so collectVideoFiles
        # errors and ScanLibrary skips the prune AND the sweep entirely.
        # Nothing is deleted; the library is also not really being scanned,
        # which is worth saying.
        warn "library $LIB ($name): a configured path does not exist, so the scan will SKIP its prune — nothing will be deleted, but this library is not being scanned either"
        while IFS= read -r r; do
            [ -n "$r" ] || continue
            realpath -e -- "$(canon "$r")" >/dev/null 2>&1 \
                || printf '        missing root: %s\n' "$r"
        done <<< "$roots"
        continue
    fi
    if [ -z "$disk_list" ]; then
        # The unreadable latch has to be consulted HERE, not only where missing
        # rows are counted. "I found nothing" and "I could not look" produce the
        # same empty disk list and mean opposite things: the first is
        # pruneDeletedFiles' zero-discovered guard and really does prune
        # nothing; the second is our own blindness, and if the SERVICE user can
        # read what we could not, the scan discovers files, walkFailed stays
        # false, and the prune runs against every recorded row — with nothing
        # shielding them, because underAnyPrefix is passed the SCAN's empty
        # unreadable list, not ours.
        #
        # This is the root-level defect one directory deeper, and it was left
        # open when that one was fixed. Reproduced as an unprivileged user with
        # a 0000 subdirectory holding the library's only media: exit 0,
        # "the scan will prune nothing", while the scan pruned a missing row
        # and swept its title.
        if [ "$unreadable" -eq 1 ]; then
            die "library $LIB ($name): found no media, but part of this library was unreadable by $(id -un) — so 'no media' may be this check's blindness rather than the truth. If Aurora can read what this could not, the next scan WILL discover files and prune every recorded row it does not find. Re-run as the user Aurora runs as."
        fi
        # pruneDeletedFiles' zero-discovered guard: a walk that finds nothing
        # is treated as suspect (the classic present-but-empty NFS mount) and
        # prunes nothing. Common mid-move, when the new root exists but the
        # copy has not started.
        warn "library $LIB ($name): no media found under its paths, so the scan will prune nothing — but it will also show an empty library"
        continue
    fi

    # comm's exit status is checked. An empty `missing` is the ALL-CLEAR, so a
    # comm that dies for any reason (a corrupt binary, a full /tmp, an
    # unexpected locale abort) silently produces the one answer that must
    # never be produced by accident. The process substitutions are not part of
    # the pipeline's status, so this is the only place it can be caught.
    if ! missing="$(comm -23 <(printf '%s\n' "$db_list") <(printf '%s\n' "$disk_list"))"; then
        die "library $LIB ($name): comm failed while comparing the recorded paths against the disk. No answer was produced, and an empty result here would have read as an all-clear."
    fi
    if ! unknown="$(comm -13 <(printf '%s\n' "$db_list") <(printf '%s\n' "$disk_list"))"; then
        die "library $LIB ($name): comm failed while comparing the disk against the recorded paths."
    fi
    missing="$(printf '%s\n' "$missing" | sed '/^$/d')"
    unknown="$(printf '%s\n' "$unknown" | sed '/^$/d')"

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
ok "nothing would be pruned. $TOTAL_UNKNOWN new file(s) would be added."
# Said on the all-clear, not only in the header, because the exit code is what
# the runbook tells the operator to act on and this is the one deletion it does
# not cover.
info "This does not cover the empty-item sweep: a title whose file rows were ALREADY gone is deleted on the next clean scan regardless. See docs/moving-media-paths.md, step 6b."
if [ "$CHECKED_FULLY" -ne "$CHECKED" ]; then
    # Exit 0 is still correct — every skipped library was skipped because the
    # SCAN will not prune it either (no paths, a missing root, or a walk that
    # discovers nothing). But "nothing would be pruned" and "I compared every
    # recorded row against the disk" are different statements, and the runbook
    # tells the operator to act on exit 0. Say which one they got.
    warn "$CHECKED_FULLY of $CHECKED librarie(s) were compared row by row. The rest were skipped above, each because the scan will not prune them either — read those warnings before starting Aurora."
fi
