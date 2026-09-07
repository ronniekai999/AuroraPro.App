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
#
# THIS IS A SECOND OPINION, NOT A GATE. Nine independent adversarial reviews
# of this file found FOURTEEN states where it reported "nothing would be pruned"
# while the scan would have deleted rows. Five were one class — a permission
# failure it could not tell apart from "the path is gone", which is the one
# state it treats as safe — and five were something failing quietly (comm,
# sort, find, the pipeline that RECORDS what find found, sed and wc), each
# leaving a variable empty, which reads the same way — and the eleventh was
# inside the fix for the tenth: the recording guard read the loop's exit
# status, which is whatever its LAST body command returned, so a run where
# every write failed but the final entry was a dangling symlink reported
# success. All are fixed and each is pinned by a test that fails if the fix
# is reverted. That record is why
# the wording here is what it is: exit 0 is evidence, not permission. Take the
# backup regardless.
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
die()  {
    printf '\033[1;31m[FAIL]\033[0m %s\n' "$1" >&2
    # A die aborts the whole run, so every library after this one is
    # unexamined. Exit 2 is never an all-clear, but silence about the
    # remainder invites "it only complained about library 3, so the rest
    # are fine".
    [ -n "${LIB:-}" ] && printf '\033[1;31m[FAIL]\033[0m %s\n' \
        "Stopped at library $LIB. Any library after it was NOT examined." >&2
    exit 2
}

# Every external this script's ANSWER depends on. A missing one is not a
# degraded check, it is a wrong one: `comm` failing leaves `missing` empty,
# which reads as "nothing is missing" and prints the all-clear. There is no
# `set -e` here (deliberately — the per-library loop must survive one library
# failing), so nothing else catches it.
# NOTE this loop and the grep-status check below are EQUIVALENT MUTANTS in any
# environment where the tools work — removing either leaves the suite green,
# because the suite cannot un-install coreutils. They are kept because the
# states they cover (a stripped container, a shadowed binary on PATH) are real
# and produce the all-clear rather than an error. Recorded so the next review
# does not spend a round rediscovering that they survive mutation.
for tool in realpath psql comm sort find grep sed wc readlink mktemp tr; do
    command -v "$tool" >/dev/null 2>&1 \
        || die "$tool not found — this check cannot run, and a missing one of these does not fail loudly: an empty result from it reads as 'nothing would be pruned'"
done

# ── Database access ───────────────────────────────────────────────
# -n: never prompt. The runbook suggests running this as the service user,
# and a nested sudo password prompt whose text went to /dev/null reads as a
# hang. Failing fast falls through to the DATABASE_URL path below.
PSQL=(sudo -n -u postgres psql -qtA -v ON_ERROR_STOP=1 "$DB_NAME")
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

# classify_root PATH — decides why a path could not be resolved, and is the
# single most dangerous function in this file.
#
# Prints one of:
#   absent          the path provably does not exist  → matches walkFailed,
#                   so the scan skips its prune and NOTHING is deleted
#   blocked <what>  we could not determine that       → exit 2, cannot answer
#
# WHY THIS IS NOT `test -e` OR `realpath -e`. Four consecutive review rounds
# each found a false all-clear here, and after the third the reviewer named the
# cause: BOTH of those collapse ENOENT and EACCES into one "it failed", and
# only ENOENT is walkFailed. Any classification phrased as "did that call
# succeed" therefore inherits the bug, which is why the fourth round found it
# again one indirection further out — `test -e` FOLLOWS symlinks, so a
# symlinked component whose target chain contains an untraversable directory
# fails with EACCES while the lexical parent was perfectly traversable.
#
# So this never asks "did it fail". It requires POSITIVE PROOF of absence and
# treats everything else as blocked:
#
#   - A component is proven absent only when we can read AND traverse its
#     lexical parent (so we would have seen the entry had it existed) and
#     lstat finds no entry there. `-e || -L` is the lstat test: a dangling
#     symlink is an entry that exists, and `-e` alone says it does not.
#   - A symlink whose target will not resolve is NOT decided here. Its target
#     is read one level and classified recursively, because "dangling" (absent)
#     and "target behind a wall" (blocked) are the two states `-e` conflates.
#   - Anything else — a parent we cannot read, a symlink loop, a chain deeper
#     than the cap — is blocked. Unknown is never absent.
classify_root() {
    local path="$1" depth="${2:-0}" parentdir
    # ELOOP guard. Linux gives up at 40; well under that is fine, and a chain
    # this deep is not something to answer confidently about anyway.
    if [ "$depth" -gt 16 ]; then
        printf 'blocked %s (symlink chain too deep to follow)\n' "$path"
        return
    fi
    local acc="" rest="${path#/}" seg parent
    while [ -n "$rest" ]; do
        seg="${rest%%/*}"
        parent="${acc:-/}"
        acc="$acc/$seg"

        if [ -e "$acc" ] || [ -L "$acc" ]; then
            # The entry exists. A symlink that does not resolve is the one
            # case `-e` cannot decide; hand its target to a fresh walk.
            if [ -L "$acc" ] && [ ! -e "$acc" ]; then
                local tgt
                tgt="$(readlink -- "$acc" 2>/dev/null)" \
                    || { printf 'blocked %s (symlink unreadable)\n' "$acc"; return; }
                case "$tgt" in
                    /*) ;;
                    # Parameter expansion, not `dirname`. A dirname that is
                    # merely BROKEN rather than absent — shadowed on PATH, a
                    # bad coreutils build — returns empty here, the recursion
                    # runs on the wrong path, and a blocked target comes back
                    # `absent`: the whole class this function closes,
                    # reintroduced through an external binary. `command -v`
                    # cannot see that, so the dependency goes instead.
                    # $acc is always absolute, so it always contains a slash.
                    *)  parentdir="${acc%/*}"
                        tgt="${parentdir:-}/$tgt" ;;
                esac
                # realpath -m is lexical and never fails, so it cannot
                # reintroduce the conflation this function exists to avoid.
                classify_root "$(realpath -m -- "$tgt")" "$((depth + 1))"
                return
            fi
            # Resolvable. Every component but the last must be traversable.
            if [ "$rest" != "$seg" ] && [ ! -x "$acc" ]; then
                printf 'blocked %s (cannot traverse, as %s)\n' "$acc" "$(id -un)"
                return
            fi
        else
            # No entry. That is proof of absence only if the lookup itself was
            # conclusive, which needs SEARCH permission on the parent — `x`,
            # not `r`. `r` grants enumeration, and we are not enumerating: we
            # asked for one named path, and with `x` the kernel answers ENOENT
            # authoritatively. Requiring `r` here looked more careful and was
            # simply wrong: 0711 is the ordinary mode of /home/<user> on Debian
            # and Ubuntu, so it turned every genuinely-absent root under a home
            # directory into an exit 2 the operator could not clear.
            # BELT AND BRACES, not the primary rule: the loop above already
            # refuses to advance past a non-final component that is not -x, so
            # by construction the parent is searchable here and this test
            # cannot currently decide anything (mutating it to `true` is an
            # equivalent mutant, and no test can kill it — recorded rather than
            # chased). It stays because the invariant it depends on lives in a
            # different branch of the same loop, and if that branch is ever
            # relaxed this is what stops an unproven absence reading as safe.
            if [ -x "$parent" ]; then
                printf 'absent\n'
            else
                printf 'blocked %s (cannot search, as %s)\n' "$parent" "$(id -un)"
            fi
            return
        fi

        [ "$rest" = "$seg" ] && break
        rest="${rest#*/}"
    done
    # Every component resolved and was traversable.
    #
    # Note the caller's `case` lists absent) and blocked*) BEFORE resolved), so
    # widening the resolved) arm to also match absent is an equivalent mutant —
    # unreachable, and no test can kill it. Recorded rather than chased.
    printf 'resolved\n'
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

WORK="$(mktemp -d)" || die "mktemp -d failed — nowhere to work"
# An empty $WORK is not merely useless: under the documented `sudo` invocation
# every scratch file would be written to the filesystem ROOT (/disk, /finderr,
# …), observed. Refuse rather than litter.
[ -n "$WORK" ] && [ -d "$WORK" ] || die "mktemp -d produced no usable directory"
trap 'rm -rf "$WORK"' EXIT

# ── The tools actually WORK, not merely exist ─────────────────────
# `command -v` sees absence; it cannot see a binary that runs and produces
# nothing. For most tools here that shows up as a contradiction the script can
# test (a non-empty input yielding empty output). For `find` and `grep` it
# cannot: producing nothing is a legitimate, common answer — an empty root, or
# a root holding no video files — and it is also exactly what the scanner's
# zero-discovered guard means. So those two are the one pair where a broken
# binary is indistinguishable from the truth AT THE CALL SITE, and the
# all-clear it yields is the dangerous one.
#
# A known-answer probe moves the check off the call site. Both of these have
# one right answer, and a tool that gets them wrong cannot be trusted for the
# real question.
probe_video="$(printf 'probe.mkv\n' | grep -Ei "$VIDEO_RE" || true)"
[ "$probe_video" = "probe.mkv" ] \
    || die "grep did not match a known video filename ('probe.mkv' against the extension pattern). A grep that silently matches nothing would empty the discovered-file list, which reads as 'no media found, so the scan will prune nothing'."
probe_find="$(find "$WORK" -maxdepth 0 -print 2>/dev/null || true)"
[ "$probe_find" = "$WORK" ] \
    || die "find did not report a directory that exists ($WORK). A find that silently produces nothing would empty the discovered-file list, which reads as 'no media found, so the scan will prune nothing'."
# WHAT THIS DOES NOT CLOSE, stated plainly: the probes prove these two tools
# worked ONCE. A binary that answers the probe and then returns nothing for the
# real walk is still indistinguishable from an empty root — because for `find`
# and `grep`, "nothing" IS a legitimate answer, and it is precisely the answer
# the scanner's own zero-discovered guard is built around. A consistently
# broken or shadowed binary (the realistic shape, and the one the tool-presence
# loop above is aimed at) is caught here; an intermittently broken one is not,
# and cannot be at this layer.

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
    # false all-clear. collectVideoFiles returns an error on EXACTLY ONE
    # condition:
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
    # NOTE returning an error is not the ONLY thing that sets walkFailed:
    # ScanLibrary also sets it when len(unreadablePaths) >= maxTrackedUnreadable
    # (1000). This check does not model that, so a library with a thousand or
    # more unreadable entries is over-reported — it exits 1 while the scan skips
    # its prune entirely. Documented in the runbook and CLAUDE.md; stated here
    # too, because this comment used to say "the only thing" and that was wrong.
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
    findfail=""
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
        # classify_root decides absent-vs-blocked; `realpath -e` is used ONLY
        # after it has said the path resolves, where it can no longer conflate
        # the two. Doing it the other way round is how four rounds of false
        # all-clears happened.
        verdict="$(classify_root "$rc")"
        case "$verdict" in
            absent)
                rootmissing=1
                continue ;;
            blocked*)
                rootopaque="$rootopaque
        $r — ${verdict#blocked }"
                continue ;;
            resolved) ;;
            *)  # classify_root returns exactly three words. Anything else is a
                # bug in it, and a bug here must not resolve to "safe".
                rootopaque="$rootopaque
        $r (could not be classified: $verdict)"
                continue ;;
        esac
        if ! rr="$(realpath -e -- "$rc" 2>/dev/null)"; then
            # classify_root said resolved, so this should be unreachable. If it
            # ever fires, the two disagree and we do not know which is right.
            rootopaque="$rootopaque
        $r (resolves component by component but not as a whole)"
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
        # find's status is checked too — it was the one tool in this pipeline
        # left out, while grep, sort and comm all gained a check for exactly
        # this reason. A find that produces nothing AND says nothing (shadowed
        # or broken binary, killed at startup, the stderr redirect itself
        # failing) empties the disk list, which reads as "no media found, so
        # the scan will prune nothing" and exits 0. Reproduced.
        #
        # Gated on `finderr` being EMPTY: GNU find exits 1 on an ordinary
        # permission error too, and that case is already handled by the
        # unreadable latch below. Only a silent non-zero exit is unexplained.
        find "$rc" ! -type d -print0 2>"$WORK/finderr" \
        | while IFS= read -r -d '' f; do
            case "$f" in
                *"$NL"*)
                    # Only a video-extension name can affect the comparison;
                    # anything else is filtered out below regardless.
                    printf '%s' "$f" | grep -qEi "$VIDEO_RE" \
                        && { printf '%s\n' "$f" >> "$WORK/badnames" || exit 9; }
                    continue ;;
            esac
            if [ -L "$f" ]; then
                # The scanner's symlink-escape guard, on ITS roots: resolve the
                # link and require the result at or under the RESOLVED root.
                t="$(realpath -e -- "$f" 2>/dev/null)" || continue
                case "$t/" in "$rr"/*) ;; *) [ "$t" = "$rr" ] || continue ;; esac
            fi
            # `|| exit 9`, not a status check after the loop. A while loop's
            # exit status is whatever its LAST body command returned, and three
            # paths in this body end in `continue`, which returns 0 — so a run
            # where every write failed but the final entry was a dangling
            # symlink (or a newline name, or an escaping symlink) reported
            # ${fs[1]} = 0, left the disk list empty, and answered "no media
            # found, so the scan will prune nothing". A dangling symlink under
            # a library root is the most ordinary artefact of the half-finished
            # move this script exists for, so the ordering was not exotic.
            # Failing HERE removes the ordering from the question entirely.
            printf '%s\n' "$f" || exit 9
          done >> "$WORK/disk"
        fs=("${PIPESTATUS[@]}")
        [ -s "$WORK/finderr" ] && unreadable=1
        if [ "${fs[0]}" -ne 0 ] && [ ! -s "$WORK/finderr" ]; then
            findfail="find failed on $r with status ${fs[0]} and no error output"
        fi
        # BOTH halves. fs[1] is the reader — the loop that writes $WORK/disk —
        # and a write failure there empties the disk list just as thoroughly as
        # a failed find, with every downstream guard satisfied: grep exits 1 on
        # an empty file, sort succeeds on it, and the run reports "no media
        # found, so the scan will prune nothing", exit 0. Reproduced on a full
        # tmpfs with no stubbing at all — mktemp -d and `: > disk` both still
        # succeed there, so nothing earlier notices. Unlike find, this half has
        # no legitimate non-zero: it is 0 on every case in the suite, including
        # the four where find itself exits 1 on permission errors.
        if [ "${fs[1]}" -ne 0 ]; then
            findfail="could not record what find discovered under $r (status ${fs[1]}) — a write to $WORK failed, most likely a full filesystem"
        fi
    done <<< "$roots"

    # rootmissing DOMINATES rootopaque, and is therefore tested first (below,
    # after the disk list is built). In Go, ANY root failing EvalSymlinks makes
    # collectVideoFiles error, which sets walkFailed for the WHOLE library and
    # skips both the prune and the sweep — so a library with one absent root
    # and one unreadable root is not going to be pruned whatever we can or
    # cannot read. Dying here would be an over-report the operator cannot
    # drive to zero, under an instruction not to start the server until they do.
    # Deferred behind rootmissing like the other two dies: any root failing
    # EvalSymlinks sets walkFailed for the WHOLE library, so the scan prunes
    # nothing and exit 2 would be an over-report nobody can clear.
    if [ -n "$findfail" ] && [ "$rootmissing" -eq 0 ]; then
        die "library $LIB ($name): $findfail. Nothing was discovered and nothing said why, which would read here as 'no media found, so the scan will prune nothing'."
    fi

    if [ -s "$WORK/badnames" ] && [ "$rootmissing" -eq 0 ]; then
        die "library $LIB ($name): at least one file on disk has a newline in its name (the halves are listed below; a single name spans two lines here, which is the whole problem). This check is line-oriented and would compare a truncated half of each, which can read as a match for a recorded path whose file is gone. Rename them, or check this library by hand:
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
    # STATUS is not enough. A tool that exits 0 and prints nothing defeats it,
    # and this exact reasoning was applied to wc and mktemp one round earlier
    # without being carried to the three siblings on the same decision path.
    # Here the contradiction is already in hand: disk.video has content, so an
    # empty disk_list is impossible from a working sort.
    if [ -s "$WORK/disk.video" ] && [ -z "$disk_list" ]; then
        die "library $LIB ($name): sort returned nothing from a non-empty file. An empty result here reads as 'no media found, so the scan will prune nothing'."
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
    if [ -n "$(printf '%s' "$recorded" | tr -d '[:space:]')" ] && [ -z "$db_list" ]; then
        die "library $LIB ($name): the recorded-path list came back non-empty from the database but empty after sorting. An empty result here reads as 'this library records no files', which is the all-clear."
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
            # classify_root, NOT realpath -e. Re-testing with realpath here
            # reintroduced the exact ENOENT/EACCES conflation this file spends
            # eighty lines explaining: with one absent root and one merely
            # blocked, it labelled the blocked one "missing root".
            case "$(classify_root "$(canon "$r")")" in
                absent) printf '        missing root: %s\n' "$r" ;;
            esac
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
    # comm is the one site with no contradiction to test — an empty `missing`
    # IS the all-clear, so emptiness proves nothing on its own. Use arithmetic
    # instead: every recorded path is either present on disk or missing from
    # it, so the two sets must account for all of them exactly.
    if ! common="$(comm -12 <(printf '%s\n' "$db_list") <(printf '%s\n' "$disk_list"))"; then
        die "library $LIB ($name): comm failed while cross-checking the comparison."
    fi
    n_common=0; [ -n "$common" ] && n_common="$(printf '%s\n' "$common" | grep -c . || true)"
    n_miss_raw=0; [ -n "$missing" ] && n_miss_raw="$(printf '%s\n' "$missing" | grep -c . || true)"
    n_db_raw=0;  [ -n "$db_list" ] && n_db_raw="$(printf '%s\n' "$db_list" | grep -c . || true)"
    if [ "$((n_common + n_miss_raw))" -ne "$n_db_raw" ]; then
        die "library $LIB ($name): the comparison does not add up — $n_db_raw recorded path(s), $n_common found on disk, $n_miss_raw reported missing. Something in the comparison produced a partial result, and a short 'missing' list is the all-clear."
    fi
    # sed and wc are status-checked too. Both leave a variable EMPTY on
    # failure, which is the all-clear — and the sed one produced it with no
    # diagnostic on stdout or stderr at all, the worst shape in this file. An
    # always-failing sed is caught upstream by the db_list pipeline, which is
    # why shadowing the tool globally could not see this; it needs the
    # per-invocation shape.
    missing_before="$missing"
    if ! missing="$(printf '%s\n' "$missing" | sed '/^$/d')"; then
        die "library $LIB ($name): sed failed while trimming the missing-file list. An empty result here is the all-clear."
    fi
    if [ -n "$(printf '%s' "$missing_before" | tr -d '[:space:]')" ] && [ -z "$missing" ]; then
        die "library $LIB ($name): the missing-file list was non-empty before trimming and empty after. That result IS the all-clear, so it is not one this check will report."
    fi
    if ! unknown="$(printf '%s\n' "$unknown" | sed '/^$/d')"; then
        die "library $LIB ($name): sed failed while trimming the unknown-file list."
    fi

    # Status AND value. `wc -l` on a non-empty input can never legitimately
    # print nothing, and an empty count falls straight through the `-gt 0`
    # test below into the all-clear — with only a `[: : integer expression
    # expected` on stderr to show for it. The guard said this in its own
    # message while checking only the status.
    n_missing=0
    if [ -n "$missing" ]; then
        n_missing="$(printf '%s\n' "$missing" | wc -l)" \
            || die "library $LIB ($name): wc failed while counting the missing files. An empty count here falls through to the all-clear."
        n_missing="${n_missing#"${n_missing%%[![:space:]]*}"}"
        n_missing="${n_missing%"${n_missing##*[![:space:]]}"}"
        case "$n_missing" in
            ''|*[!0-9]*) die "library $LIB ($name): wc produced '$n_missing' counting the missing files, which is not a number. An unusable count here falls through to the all-clear." ;;
        esac
    fi
    n_unknown=0
    if [ -n "$unknown" ]; then
        n_unknown="$(printf '%s\n' "$unknown" | wc -l)" \
            || die "library $LIB ($name): wc failed while counting the new files."
        n_unknown="${n_unknown#"${n_unknown%%[![:space:]]*}"}"
        n_unknown="${n_unknown%"${n_unknown##*[![:space:]]}"}"
        # Display-only, so it degrades to 0 rather than dying — unlike
        # n_missing, which feeds the exit code.
        case "$n_unknown" in
            ''|*[!0-9]*) n_unknown=0 ;;
        esac
    fi

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
ok "nothing would be pruned by this check's reckoning. $TOTAL_UNKNOWN new file(s) would be added."
# The hedge goes HERE, on the line the operator actually reads, not only in
# the file header they will never open. Nine reviews found fourteen states
# where this line appeared while the scan would have deleted rows.
info "This is a second opinion, not a gate: exit 0 is evidence, not permission. Take the backup in step 1 regardless."
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
