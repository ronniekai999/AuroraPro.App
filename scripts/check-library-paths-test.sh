#!/usr/bin/env bash
#
# Tests for scripts/check-library-paths.sh.
#
# That script is the only thing standing between an operator who has moved
# their media and a scan that prunes the rows the move orphaned — taking watch
# history, ratings, taste seeds and embeddings with them through
# ON DELETE CASCADE. It shipped with no tests of its own, and an independent
# review then found TWO states in which it printed "nothing would be pruned"
# while the scan would delete rows. Neither was visible to the Go contract
# tests, which pin the extension list and two properties of WalkDir but never
# run the script. This runs it.
#
# Each case builds a real directory tree and stubs `psql` to return a scripted
# answer, then asserts the script's exit code and output. The stub is a real
# file on PATH, so the script under test is unmodified — what runs here is what
# an operator runs.
#
# THE ASYMMETRY THAT MATTERS: a FAIL where the scan would prune nothing costs
# an operator an afternoon. An OK where the scan WOULD prune costs them their
# catalog. Every case below states which side it is guarding.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/check-library-paths.sh"
PASS=0
FAIL=0

ok()  { printf '  \033[32mok\033[0m   %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAIL=$((FAIL + 1)); }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ── The psql stub ─────────────────────────────────────────────────
# The script issues its queries through one `q()` helper, always as
# `psql ... -c "<sql>"`. The stub matches on a distinctive fragment of each
# query and prints the fixture's answer. Anything unmatched exits non-zero, so
# a query the fixture forgot shows up as "could not check" rather than as a
# silent empty result that would read as an all-clear.
mkdir -p "$TMP/bin"
cat > "$TMP/bin/psql" <<'STUB'
#!/usr/bin/env bash
sql=""
while [ $# -gt 0 ]; do
    case "$1" in -c) sql="$2"; shift 2 ;; *) shift ;; esac
done
# lib_answer <fixture> — print "<fixture>.<id>" if the case supplied one for
# the library this query names, else the plain fixture.
lib_answer() {
    local id
    id="$(printf '%s' "$sql" | grep -oE 'library_id = [0-9]+|id = [0-9]+' | head -1 | grep -oE '[0-9]+')"
    if [ -n "$id" ] && [ -f "$FIX/$1.$id" ]; then cat "$FIX/$1.$id"; else cat "$FIX/$1"; fi
}
case "$sql" in
    "SELECT 1")                 exit 0 ;;
    # fail_all: every query after the connectivity probe fails, i.e. the
    # cluster going away mid-run. A flag rather than a replacement stub —
    # the replacement had to be undone by a later `cp`, and deleting that
    # `cp` as dead scaffolding left every subsequent case running against
    # a stub that answered nothing.
    *) [ -f "$FIX/fail_all" ] && exit 1 ;;&
    *"FROM libraries ORDER BY id"*) cat "$FIX/lib_ids" ;;
    # BEFORE both the count arm and the plain unnest arm: the bad-root query is
    # ALSO a `count(*) FROM libraries` AND contains `unnest(paths)`, so placed
    # after either one it never matches and the library-exists answer (1) is
    # returned as a bad-root count, failing every case in the file.
    # The PREDICATE is checked, not just that a bad-root query was sent.
    # Routing on a substring and answering from a fixture leaves the WHERE
    # clause entirely unexercised: dropping the newline arm restores the
    # false all-clear the count exists to close, and the suite stayed green.
    *"unnest(paths) AS p"*)
        case "$sql" in
            *"p = ''"*) ;;
            *) echo "STUB: bad-root query lost its empty-string arm" >&2; exit 1 ;;
        esac
        case "$sql" in
            *"p LIKE E'%\\n%'"*) ;;
            *) echo "STUB: bad-root query lost its newline arm" >&2; exit 1 ;;
        esac
        cat "$FIX/n_badroot" ;;
    *"count(*) FROM libraries"*)    cat "$FIX/lib_exists" ;;
    # Per-library answers when a case supplies them (roots.2, recorded.3, …),
    # falling back to the single-library fixture otherwise. Without this the
    # whole file could only ever drive ONE library, leaving every per-library
    # state reset and every cross-root latch unexercised.
    *"SELECT name FROM libraries"*) lib_answer lib_name ;;
    *"SELECT type FROM libraries"*)
        [ -f "$FIX/fail_type" ] && exit 1
        lib_answer lib_type ;;
    *"unnest(paths)"*)
        [ -f "$FIX/fail_roots" ] && exit 1
        lib_answer roots ;;
    *"WHERE path = ''"*)
        case "$sql" in
            *"path LIKE E'%\\n%'"*) ;;
            *) echo "STUB: recorded-path query lost its newline arm" >&2; exit 1 ;;
        esac
        cat "$FIX/n_bad" ;;
    *"FROM episode_files"*|*"FROM media_files"*)
        # With strict_show set, the episode query must reach the library the
        # way pruneDeletedFiles does — through tv_seasons, not through
        # tv_episodes.media_item_id. Same row today; a rewrite keyed on a
        # column the scanner does not read is how the two come to disagree.
        if [ -f "$FIX/strict_show" ]; then
            case "$sql" in
                *"FROM episode_files"*)
                    case "$sql" in
                        *"tv_seasons"*"ts.media_item_id"*) ;;
                        *) echo "STUB: episode query does not join through tv_seasons" >&2; exit 1 ;;
                    esac ;;
            esac
        fi
        # fail_recorded: this query fails while everything before it succeeds.
        # A lost `|| die` here leaves `recorded` EMPTY, which reads downstream
        # as "this library records no files" — nothing missing, exit 0.
        [ -f "$FIX/fail_recorded" ] && exit 1
        # saw_media_files: prove a SHOW library did not take the movie branch.
        if [ -f "$FIX/saw_media_files" ]; then
            case "$sql" in
                *"FROM media_files"*) echo "STUB-SAW-MEDIA-FILES-QUERY"; exit 0 ;;
            esac
        fi
        lib_answer recorded ;;
    *) echo "psql stub: unhandled query: $sql" >&2; exit 1 ;;
esac
STUB
chmod +x "$TMP/bin/psql"

# The script reaches the database as `sudo -u postgres psql …`. sudo resolves
# psql from the TARGET user's PATH, so stubbing psql alone is not enough — the
# real binary runs and every case fails identically with "cannot reach the
# database", which is exit 2 and would quietly turn this whole file into an
# assertion that the script cannot connect. Strip the -u and exec the rest.
cat > "$TMP/bin/sudo" <<'STUB'
#!/usr/bin/env bash
while [ $# -gt 0 ]; do
    case "$1" in
        -u) shift 2 ;;
        -*) shift ;;
        *)  break ;;
    esac
done
exec "$@"
STUB
chmod +x "$TMP/bin/sudo"


# assert_denied PATH LABEL — fail the suite unless PATH is genuinely
# inaccessible TO THE USER THE SCRIPT WILL RUN AS. Modes are the one thing in
# this file that behaves differently under root and non-root, and a mode that
# grants the owner the bit under test makes its case silently vacuous on a
# non-root runner while passing under root. That shipped once and was red on CI
# for four commits. Prose did not prevent it; this does.
assert_denied() {
    local path="$1" label="$2" mode probe
    # 1. The MODE. Accessibility alone cannot catch the defect this exists for:
    #    under root the suite drops to a non-owner, so 750 genuinely denies and
    #    the case looks fine — while on a non-root runner the script runs AS the
    #    owner and 750 grants everything. The owner digit is the invariant, and
    #    it is the same in both invocations.
    # stat -c %a drops leading zeros — a 000 directory prints "0", not "000" —
    # and prints four digits when setuid/setgid/sticky is set. Normalise to the
    # last three before looking at the owner digit.
    mode="$(stat -c '%a' "$path" 2>/dev/null)"
    case "$mode" in
        ''|*[!0-7]*) bad "$label: could not read the mode of $path"; return ;;
    esac
    while [ "${#mode}" -lt 3 ]; do mode="0$mode"; done
    mode="${mode#"${mode%???}"}"
    # The owner must lack READ or EXECUTE. For a directory those are the two
    # bits that make it inspectable, so an owner digit of 5 (r-x) or 7 (rwx)
    # leaves it fully usable — and on a non-root runner the script runs AS the
    # owner. Other digits are fine and are used deliberately: 4 tests
    # readable-but-not-traversable, 1 tests traversable-but-not-listable, 6
    # tests neither-traversable. 750 was the defect, and its owner digit is 7.
    # Every call site here needs an UNTRAVERSABLE directory, so the bit that
    # matters is x, not r. Rejecting only 5 and 7 accepted 1 and 3, which leave
    # the path fully traversable — and the comment below used to commend digit
    # 1 for a different kind of case, inviting exactly the substitution this
    # could not catch.
    case "${mode%??}" in
        1|3|5|7) bad "$label: $path is mode $mode — the OWNER digit grants execute, so on a non-root runner (no setpriv drop) the script runs as the owner, can traverse it, and this case is vacuous. Use 000." ;;
    esac
    # 2. And then confirm it empirically, for the user that will actually run,
    #    by testing TRAVERSAL rather than listing. `ls` needs r; every state
    #    these cases build is a traverse-block, and a mode-100 directory is
    #    unlistable but perfectly traversable — so an ls probe called it denied
    #    while the script walked straight through.
    if [ "$(id -u)" -eq 0 ] && [ "${#DROP[@]}" -gt 0 ]; then
        probe="$("${DROP[@]}" env sh -c 'cd "$1" 2>/dev/null && echo traversable || echo denied' _ "$path")"
    else
        probe="$(cd "$path" 2>/dev/null && echo traversable || echo denied)"
    fi
    [ "$probe" = denied ] || bad "$label: $path is TRAVERSABLE by the user the script runs as — this case is vacuous"
}

# fixture <name> — start a fresh fixture directory with sane defaults.
fixture() {
    FIX="$TMP/fix.$1"
    rm -rf "$FIX"; mkdir -p "$FIX"
    echo 1        > "$FIX/lib_ids"
    echo 1        > "$FIX/lib_exists"
    echo Movies   > "$FIX/lib_name"
    echo movie    > "$FIX/lib_type"
    echo 0        > "$FIX/n_bad"
    echo 0        > "$FIX/n_badroot"
    : > "$FIX/roots"
    : > "$FIX/recorded"
    export FIX
}

# run — invoke the script under test with the stub on PATH.
run() {
    OUT="$(PATH="$TMP/bin:$PATH" AURORA_DB=testdb bash "$SCRIPT" 2>&1)"
    RC=$?
}

expect_rc() {  # $1 = expected rc, $2 = label
    if [ "$RC" = "$1" ]; then ok "$2"
    else bad "$2 (exit $RC, wanted $1)"; printf '%s\n' "$OUT" | sed 's/^/       | /'; fi
}

expect_out() {  # $1 = substring, $2 = label
    case "$OUT" in *"$1"*) ok "$2" ;;
                   *) bad "$2 (output lacks \"$1\")"; printf '%s\n' "$OUT" | sed 's/^/       | /' ;; esac
}

# ── A NOTE ON MODES IN THIS FILE ───────────────────────────────────
# Privilege-dependent cases use `chmod 000`, never 750. 750 grants the OWNER
# rwx, and on a non-root runner there is no setpriv drop — the script under
# test runs as the very user that created the fixture, so a 750 directory is
# fully traversable and the blocked state is never built. Three cases used 750
# and were therefore RED on every non-root runner (which is what CI uses) while
# passing under root, where setpriv drops to a non-owner. 000 denies the owner
# too, so both invocations build the same state.
echo "check-library-paths: agreement with the scanner"

# ── 1. The happy path ─────────────────────────────────────────────
fixture happy
R="$TMP/happy"; mkdir -p "$R"
: > "$R/A.mkv"; : > "$R/B.mkv"
echo "$R" > "$FIX/roots"
printf '%s\n%s\n' "$R/A.mkv" "$R/B.mkv" > "$FIX/recorded"
run
expect_rc 0 "every recorded file present → exit 0"
expect_out "all 2 recorded file(s) will be found" "…and says so"

# ── 2. A genuinely missing file ───────────────────────────────────
# Guards the FALSE ALL-CLEAR side.
fixture gone
R="$TMP/gone"; mkdir -p "$R"
: > "$R/A.mkv"
echo "$R" > "$FIX/roots"
printf '%s\n%s\n' "$R/A.mkv" "$R/DELETED.mkv" > "$FIX/recorded"
run
expect_rc 1 "a recorded file that is not on disk → exit 1"
expect_out "DELETED.mkv" "…and names it"

# ── 3. A directory symlink is not descended into ──────────────────
# WalkDir does not follow one; `test -e` does. A recorded row reachable ONLY
# through a directory symlink is pruned, so reporting it found is a false
# all-clear.
fixture dirlink
R="$TMP/dirlink"; mkdir -p "$R/real" "$TMP/dirlink-out"
: > "$TMP/dirlink-out/Hidden.mkv"
: > "$R/real/Seen.mkv"
ln -s "$TMP/dirlink-out" "$R/linked"
echo "$R" > "$FIX/roots"
printf '%s\n%s\n' "$R/real/Seen.mkv" "$R/linked/Hidden.mkv" > "$FIX/recorded"
run
expect_rc 1 "a row reachable only through a directory symlink → exit 1"
expect_out "linked/Hidden.mkv" "…and names it"

# ── 4. A symlinked FILE inside the root is accepted ───────────────
# Guards the OVER-REPORT side: symlinked media is the normal *arr layout, and
# the scanner accepts it as long as the target resolves under the root.
fixture filelink
R="$TMP/filelink"; mkdir -p "$R/real" "$R/links"
: > "$R/real/A.mkv"
ln -s ../real/A.mkv "$R/links/A.mkv"
echo "$R" > "$FIX/roots"
printf '%s\n%s\n' "$R/real/A.mkv" "$R/links/A.mkv" > "$FIX/recorded"
run
expect_rc 0 "a symlinked file whose target is inside the root → exit 0"

# ── 5. A symlink escaping the root is rejected ────────────────────
fixture escape
R="$TMP/escape"; mkdir -p "$R"
: > "$TMP/escape-out.mkv"
ln -s "$TMP/escape-out.mkv" "$R/E.mkv"
: > "$R/Real.mkv"
echo "$R" > "$FIX/roots"
printf '%s\n%s\n' "$R/Real.mkv" "$R/E.mkv" > "$FIX/recorded"
run
expect_rc 1 "a symlink pointing outside the root → exit 1"

# ── 6. HIGH-1: a root reached through a symlinked component ───────
# collectVideoFiles tests containment against EvalSymlinks(root); the walk
# output is prefixed with the UNRESOLVED root. Comparing a resolved target
# against the lexical root dropped every symlinked file, emptied the disk
# list, and landed on the zero-discovered branch — which prints "the scan will
# prune nothing" and exits 0 while the scan prunes. The state is reachable
# because the runbook has the operator write libraries.paths by hand.
fixture aliasroot
mkdir -p "$TMP/aliasreal/movies"
ln -s "$TMP/aliasreal" "$TMP/alias"
R="$TMP/alias/movies"
mkdir -p "$TMP/aliasreal/movies/data"
: > "$TMP/aliasreal/movies/data/payload.bin"
ln -s "$TMP/aliasreal/movies/data/payload.bin" "$TMP/aliasreal/movies/B.mkv"
echo "$R" > "$FIX/roots"
printf '%s\n%s\n' "$R/B.mkv" "$R/ORPHANED.mkv" > "$FIX/recorded"
run
expect_rc 1 "symlinked root component: the orphan is still reported → exit 1"
expect_out "ORPHANED.mkv" "…and named"
# Asserted positively: B.mkv must be absent from the missing list. Testing
# only for the absence of "no media found" passes whenever the script fails
# for any other reason at all — including not reaching the database.
if [ "$RC" = 1 ] && ! printf '%s\n' "$OUT" | grep -q 'B\.mkv'; then
    ok "symlinked root component: the symlinked file was discovered, not reported missing"
else
    bad "symlinked root component: B.mkv was not discovered (the HIGH-1 regression)"
    printf '%s\n' "$OUT" | sed 's/^/       | /'
fi

# ── 7. HIGH-2: a root that exists but this user cannot read ───────
# collectVideoFiles errors ONLY when EvalSymlinks(root) fails, so an
# unreadable root is NOT walkFailed. If the service user CAN read it the scan
# walks it and prunes; predicting "nothing will be deleted" from our own
# blindness is a false all-clear. Must refuse to answer (exit 2), not exit 0.
#
# chmod 000 is not a barrier to root, so under root this case has to DROP
# PRIVILEGES or it does not test anything. Skipping instead is not a neutral
# choice: CI containers run as root, so the skip is where the guard would
# have been, and a mutation reverting the fix passes the whole suite. (It
# did — that is why this runs unprivileged.)
fixture opaque
R="$TMP/opaque"; mkdir -p "$R"
: > "$R/A.mkv"
chmod 000 "$R"
echo "$R" > "$FIX/roots"
printf '%s\n%s\n' "$R/A.mkv" "$R/GONE.mkv" > "$FIX/recorded"

DROP=()
if [ "$(id -u)" -eq 0 ]; then
    # 65534 is nobody/nogroup on Debian and RHEL alike. The fixture, the stub
    # bin and the script all have to be reachable by it.
    chmod -R a+rX "$TMP/bin" "$FIX" 2>/dev/null
    chmod a+rx "$TMP" 2>/dev/null
    if command -v setpriv >/dev/null 2>&1; then
        DROP=(setpriv --reuid=65534 --regid=65534 --clear-groups)
    fi
fi
if [ "$(id -u)" -eq 0 ] && [ "${#DROP[@]}" -eq 0 ]; then
    bad "unreadable root: running as root and setpriv is unavailable — this case cannot be tested here, and skipping it silently is how the guard was lost before"
else
    OUT="$(PATH="$TMP/bin:$PATH" FIX="$FIX" "${DROP[@]}" env PATH="$TMP/bin:$PATH" \
           FIX="$FIX" AURORA_DB=testdb HOME=/tmp bash "$SCRIPT" 2>&1)"
    RC=$?
    expect_rc 2 "a root this user cannot read → exit 2 (cannot check), never 0"
    expect_out "cannot inspect these roots" "…and says why"
fi
chmod 755 "$R"

# ── 8. A missing root really is walkFailed ────────────────────────
# The one root state that DOES match walkFailed: the prune is skipped
# wholesale, so exit 0 is the honest answer even with unfound rows.
fixture absent
echo "$TMP/absent-root" > "$FIX/roots"
printf '%s\n' "$TMP/absent-root/A.mkv" > "$FIX/recorded"
run
expect_rc 0 "a missing root → exit 0 (the scan skips its prune)"
expect_out "does not exist" "…and says the library is not being scanned"

# ── 9. The zero-discovered guard ──────────────────────────────────
fixture emptyroot
R="$TMP/emptyroot"; mkdir -p "$R"
echo "$R" > "$FIX/roots"
printf '%s\n' "$R/A.mkv" > "$FIX/recorded"
run
expect_rc 0 "an empty root → exit 0 (pruneDeletedFiles' zero-discovered guard)"
expect_out "no media found" "…and says the library will show empty"

# ── 10. A non-canonical recorded path ─────────────────────────────
# filepath.Join cleans as the walk builds each child, so a doubled slash can
# never equal the walk output — the row is pruned however equivalent it looks.
fixture noncanon
R="$TMP/noncanon"; mkdir -p "$R"
: > "$R/N.mkv"
echo "$R" > "$FIX/roots"
printf '%s//%s\n' "$R" "N.mkv" > "$FIX/recorded"
run
expect_rc 1 "a doubled slash in a recorded path → exit 1"

# ── 11. An extension the scanner does not accept ──────────────────
fixture ext
R="$TMP/ext"; mkdir -p "$R"
: > "$R/A.mkv"; : > "$R/V.vob"
echo "$R" > "$FIX/roots"
printf '%s\n%s\n' "$R/A.mkv" "$R/V.vob" > "$FIX/recorded"
run
expect_rc 1 "a recorded .vob (not a video extension to the scanner) → exit 1"

# ── 12. MEDIUM-1: a newline in a recorded path ────────────────────
# Line-oriented comparison cannot represent it. Counting lines is not enough:
# `sort -u` collapses a duplicated half, so the count matched and the check
# passed. The count must come from SQL.
fixture newline
R="$TMP/newline"; mkdir -p "$R"
: > "$R/A.mkv"; : > "$R/B.mkv"
echo "$R" > "$FIX/roots"
echo 1 > "$FIX/n_bad"
printf '%s\n%s\n%s\n' "$R/A.mkv" "$R/A.mkv" "$R/B.mkv" > "$FIX/recorded"
run
expect_rc 2 "a recorded path containing a newline → exit 2, never an all-clear"
expect_out "empty or contain a newline" "…and says which query finds them"

# ── 13. Failures must not read as all-clears ──────────────────────
fixture badid
echo 0 > "$FIX/lib_exists"
run
expect_rc 2 "a library id that does not exist → exit 2"


fixture qfail
: > "$FIX/fail_all"
run
expect_rc 2 "a query that fails mid-run → exit 2, not a green summary"

# Every query has its own `|| die`, and the case above only reaches the first
# one. A lost `|| die` further down is the dangerous shape: the variable is
# left EMPTY, which reads downstream as "this library records no files" —
# nothing missing, all clear, exit 0. So fail exactly the recorded-paths
# query, with everything before it succeeding.
fixture qfail_late
R="$TMP/qfail_late"; mkdir -p "$R"
: > "$R/A.mkv"
echo "$R" > "$FIX/roots"
printf '%s\n' "$R/A.mkv" > "$FIX/recorded"
# Driven by a FIXTURE FLAG, not by patching the stub from in here. Both
# earlier stub-patching cases died silently: the arm text moved under them,
# and — the part that made it invisible — a failing python heredoc does not
# fail the shell case around it, so the case ran the unmodified stub and
# asserted only that the script works normally.
: > "$FIX/fail_recorded"
run
expect_rc 2 "the recorded-paths query failing → exit 2, not 'no files recorded'"

# ── 15. A SHOW library uses the episode_files join ────────────────
# fixture() defaults to `movie`, so without this every case above exercises
# only the media_files half — and the episode side is half the reason the
# script exists. pruneDeletedFiles branches on lib.Type and reads one table or
# the other, never both, so a library type that silently fell through to the
# movie query would report "all 0 recorded file(s) will be found" for a show
# library whose every row was about to be pruned.
fixture show
R="$TMP/show"; mkdir -p "$R/Show/Season 01"
: > "$R/Show/Season 01/S01E01.mkv"
echo show > "$FIX/lib_type"
echo Shows > "$FIX/lib_name"
echo "$R" > "$FIX/roots"
printf '%s\n' "$R/Show/Season 01/S01E01.mkv" > "$FIX/recorded"
run
expect_rc 0 "a show library resolves through episode_files → exit 0"
expect_out "all 1 recorded file(s) will be found" "…and compares its rows"

fixture show_missing
R="$TMP/show_missing"; mkdir -p "$R/Show/Season 01"
: > "$R/Show/Season 01/S01E01.mkv"
echo show > "$FIX/lib_type"
echo "$R" > "$FIX/roots"
printf '%s\n%s\n' "$R/Show/Season 01/S01E01.mkv" "$R/Show/Season 01/S01E02.mkv" > "$FIX/recorded"
run
expect_rc 1 "a show library with a missing episode file → exit 1"

# The query the script sends for a show must be the episode one. Asserting on
# the exit code alone cannot tell a correct branch from one that read the wrong
# lib_type and got lucky, because the stub answers both from one fixture file.
fixture show_query
R="$TMP/show_query"; mkdir -p "$R"
: > "$R/A.mkv"
echo show > "$FIX/lib_type"
echo "$R" > "$FIX/roots"
printf '%s\n' "$R/A.mkv" > "$FIX/recorded"
: > "$FIX/saw_media_files"
run
if [ "$RC" = 0 ]; then ok "a show library sends the episode_files query, not media_files"
else bad "a show library sent the media_files query (exit $RC)"; printf '%s\n' "$OUT" | sed 's/^/       | /'; fi

# ── 16. Every query needs its own `|| die` ────────────────────────
# Losing one leaves its variable EMPTY, and empty reads downstream as a benign
# fact rather than a failure: no paths configured, no files recorded, a movie
# library. All three exit 0. The recorded-paths case above pins one of these;
# these pin the two that turn a transient psql failure into an all-clear.
# Each query has its own `|| die`, and the case above only reaches the first.
# A lost one further down leaves its variable EMPTY, and empty reads downstream
# as a benign fact rather than a failure: no paths configured, a movie library.
# Both exit 0.
fixture qfail_roots
R="$TMP/qfail_roots"; mkdir -p "$R"; : > "$R/A.mkv"
echo "$R" > "$FIX/roots"; printf '%s\n' "$R/A.mkv" > "$FIX/recorded"
: > "$FIX/fail_roots"
run
expect_rc 2 "the roots query failing → exit 2, not 'has no paths'"

fixture qfail_type
R="$TMP/qfail_type"; mkdir -p "$R"; : > "$R/A.mkv"
echo show > "$FIX/lib_type"
echo "$R" > "$FIX/roots"; printf '%s\n' "$R/A.mkv" > "$FIX/recorded"
: > "$FIX/fail_type"
run
expect_rc 2 "the library-type query failing → exit 2, not a movie-branch guess"

# ── 17. HIGH (round 2): an unreadable SUBTREE, not the root ───────
# The root-level guard stops one directory short. `find` errors inside the
# tree, the disk list comes back empty, and the zero-discovered branch claims
# the scan will prune nothing — but that branch cannot tell "there is nothing
# here" from "I am the only one who cannot see it". If the service user reads
# what we could not, the scan discovers files, walkFailed stays false, and the
# prune runs against every recorded row with NOTHING shielding it: underAnyPrefix
# is passed the SCAN's unreadable list, which is empty, not ours.
if [ "$(id -u)" -eq 0 ] && [ "${#DROP[@]}" -eq 0 ]; then
    bad "unreadable subtree: running as root and setpriv is unavailable — cannot test"
else
    fixture subtree
    R="$TMP/subtree"; mkdir -p "$R/sub"
    : > "$R/sub/A.mkv"
    echo "$R" > "$FIX/roots"
    printf '%s\n%s\n' "$R/sub/A.mkv" "$R/GONE.mkv" > "$FIX/recorded"
    chmod 000 "$R/sub"
    assert_denied "$R/sub" "unreadable subtree"
    [ "$(id -u)" -eq 0 ] && { chmod -R a+rX "$TMP/bin" "$FIX" 2>/dev/null; chmod a+rx "$TMP" "$R"; }
    OUT="$(PATH="$TMP/bin:$PATH" "${DROP[@]}" env PATH="$TMP/bin:$PATH" \
           FIX="$FIX" AURORA_DB=testdb HOME=/tmp bash "$SCRIPT" 2>&1)"
    RC=$?
    chmod -R 755 "$R/sub"
    expect_rc 2 "media only under an unreadable SUBTREE → exit 2, never 'prunes nothing'"
    expect_out "may be this check's blindness" "…and says why it will not answer"
fi

# ── 18. A `..` component in a root ────────────────────────────────
# realpath -ms collapses it lexically before resolving symlinks; EvalSymlinks
# resolves it against the already-resolved prefix; WalkDir hands the raw path
# to the kernel. Three different directories once a symlink precedes it.
fixture dotdot
mkdir -p "$TMP/dotdot/real" "$TMP/dotdot/other"
: > "$TMP/dotdot/other/A.mkv"
echo "$TMP/dotdot/real/../other" > "$FIX/roots"
printf '%s\n' "$TMP/dotdot/other/A.mkv" > "$FIX/recorded"
run
expect_rc 2 "a '..' component in a library root → exit 2"

# ── 19. A newline in an on-disk FILENAME ──────────────────────────
# The mirror of case 12: `find -print` splits it across two lines and the
# truncated first half can match a recorded path whose file is gone.
fixture disknewline
R="$TMP/disknewline"; mkdir -p "$R"
touch "$R/$(printf 'A.mkv\njunk.mkv')" 2>/dev/null || true
if [ -e "$R/$(printf 'A.mkv\njunk.mkv')" ]; then
    echo "$R" > "$FIX/roots"
    printf '%s\n' "$R/A.mkv" > "$FIX/recorded"
    run
    expect_rc 2 "a newline in an on-disk filename → exit 2, not a false match"
else
    ok "newline in an on-disk filename: SKIPPED (filesystem refused the name)"
fi

# ── 20. Root readability needs BOTH -r and -x ─────────────────────
# A directory with r but not x can be listed and not traversed: `find` errors
# on every child, so the disk list is empty or partial while the root itself
# looks fine. Dropping the -x half left that reading as "no media found".
if [ "$(id -u)" -eq 0 ] && [ "${#DROP[@]}" -eq 0 ]; then
    bad "root without +x: running as root and setpriv is unavailable — cannot test"
else
    fixture noexec
    R="$TMP/noexec"; mkdir -p "$R"
    : > "$R/A.mkv"
    echo "$R" > "$FIX/roots"
    printf '%s\n%s\n' "$R/A.mkv" "$R/GONE.mkv" > "$FIX/recorded"
    chmod 444 "$R"
    [ "$(id -u)" -eq 0 ] && { chmod -R a+rX "$TMP/bin" "$FIX" 2>/dev/null; chmod a+rx "$TMP"; }
    OUT="$(PATH="$TMP/bin:$PATH" "${DROP[@]}" env PATH="$TMP/bin:$PATH" \
           FIX="$FIX" AURORA_DB=testdb HOME=/tmp bash "$SCRIPT" 2>&1)"
    RC=$?
    chmod 755 "$R"
    expect_rc 2 "a root that is readable but not traversable → exit 2"
fi

# ── 21. A missing root dominates an unreadable one ────────────────
# Any root failing EvalSymlinks sets walkFailed for the WHOLE library in Go,
# skipping prune and sweep — so this must not be the exit 2 that an operator
# cannot drive to zero.
if [ "$(id -u)" -eq 0 ] && [ "${#DROP[@]}" -eq 0 ]; then
    bad "missing + unreadable roots: running as root and setpriv is unavailable"
else
    fixture bothroots
    R="$TMP/bothroots"; mkdir -p "$R"
    : > "$R/A.mkv"; chmod 000 "$R"
    assert_denied "$R" "missing + unreadable roots"
    printf '%s\n%s\n' "$TMP/bothroots-absent" "$R" > "$FIX/roots"
    printf '%s\n' "$R/A.mkv" > "$FIX/recorded"
    [ "$(id -u)" -eq 0 ] && { chmod -R a+rX "$TMP/bin" "$FIX" 2>/dev/null; chmod a+rx "$TMP"; }
    OUT="$(PATH="$TMP/bin:$PATH" "${DROP[@]}" env PATH="$TMP/bin:$PATH" \
           FIX="$FIX" AURORA_DB=testdb HOME=/tmp bash "$SCRIPT" 2>&1)"
    RC=$?
    chmod 755 "$R"
    expect_rc 0 "one absent root + one unreadable root → exit 0 (walkFailed skips the prune)"
fi

# ── 22. A library root that is not a directory ────────────────────
# Deliberately a refusal rather than a comparison. WalkDir on a file visits it
# as a single entry, so the scan discovers exactly one file and prunes every
# other row in the library against it — measured, not assumed. `find ! -type d`
# would actually agree with that, so this exit 2 is an over-report; it is kept
# because "your library root is a file" is a misconfiguration worth stopping
# on, and exit 2 never reads as safe. The root must be mode 755, or the -r/-x
# test catches it first and the -d branch is never reached.
fixture filederoot
printf 'x' > "$TMP/filederoot.mkv"; chmod 755 "$TMP/filederoot.mkv"
echo "$TMP/filederoot.mkv" > "$FIX/roots"
printf '%s\n' "$TMP/filederoot.mkv" > "$FIX/recorded"
run
expect_rc 2 "a library root that is a regular file → exit 2"
expect_out "not a directory" "…and says which shape it is"

# ── 23. HIGH (round 3): EACCES on an ANCESTOR of the root ─────────
# `realpath -e` fails identically for ENOENT and for EACCES on a parent, and
# only the first is walkFailed. Reading the second as the first reported "the
# path does not exist, nothing will be deleted" and exited 0 — while the scan,
# as a user who CAN traverse the parent, walks the root and prunes. The shape
# is the ordinary one: media owned by the service user under a 0750 parent,
# checked by an operator who is not in its group.
if [ "$(id -u)" -eq 0 ] && [ "${#DROP[@]}" -eq 0 ]; then
    bad "ancestor EACCES: running as root and setpriv is unavailable — cannot test"
else
    fixture ancestor
    mkdir -p "$TMP/ancestor/parent/media"
    : > "$TMP/ancestor/parent/media/A.mkv"
    echo "$TMP/ancestor/parent/media" > "$FIX/roots"
    printf '%s\n%s\n' "$TMP/ancestor/parent/media/A.mkv" "$TMP/ancestor/parent/media/GONE.mkv" > "$FIX/recorded"
    chmod 000 "$TMP/ancestor/parent"
    assert_denied "$TMP/ancestor/parent" "untraversable ancestor"
    [ "$(id -u)" -eq 0 ] && { chmod -R a+rX "$TMP/bin" "$FIX" 2>/dev/null; chmod a+rx "$TMP" "$TMP/ancestor"; }
    OUT="$(PATH="$TMP/bin:$PATH" "${DROP[@]}" env PATH="$TMP/bin:$PATH" \
           FIX="$FIX" AURORA_DB=testdb HOME=/tmp bash "$SCRIPT" 2>&1)"
    RC=$?
    chmod 755 "$TMP/ancestor/parent"
    expect_rc 2 "an untraversable ANCESTOR of the root → exit 2, not 'does not exist'"
    expect_out "cannot traverse" "…and names the component that blocked it"
fi

# The same code path must still call a genuinely absent root walkFailed, or the
# fix trades one wrong answer for another: an over-report on every library
# whose disk is simply not mounted.
fixture stillmissing
echo "$TMP/stillmissing-absent/media" > "$FIX/roots"
printf '%s\n' "$TMP/stillmissing-absent/media/A.mkv" > "$FIX/recorded"
run
expect_rc 0 "a genuinely absent root is still walkFailed → exit 0"
expect_out "does not exist" "…and still says so"

# ── 24. The show query must use the tv_seasons join ───────────────
# Case 15 pins only the TABLE NAME, so swapping the join to
# tv_episodes.media_item_id — the drift the script's own comment warns
# against — passed every case. This checks the join text itself.
#
# Via a fixture flag, NOT by patching the stub from in here. Two earlier
# versions of this case did that, and both died silently: the arm text moved
# under them, the replacement matched nothing, and — the part that made it
# invisible — a failing python heredoc does not fail the shell case around it,
# so the case ran the unmodified stub and asserted only that the script works.
fixture show_join
R="$TMP/show_join"; mkdir -p "$R"
: > "$R/A.mkv"
echo show > "$FIX/lib_type"
: > "$FIX/strict_show"
echo "$R" > "$FIX/roots"
printf '%s\n' "$R/A.mkv" > "$FIX/recorded"
run
expect_rc 0 "the show query joins episode → season → item, as the scanner does"

# ── 25. Byte collation ──────────────────────────────────────────
# `comm` and `sort` honour LC_COLLATE, and under a UTF-8 locale two
# byte-distinct paths that strcoll ranks EQUAL are treated as common by comm —
# dropping a genuinely missing row and reading the library clean. GNU sort also
# aborts on invalid UTF-8, which would truncate the disk side silently.
#
# STRUCTURAL, not behavioural, and deliberately so. Demonstrating a collation
# collision needs a particular non-C UTF-8 locale to be GENERATED on the
# machine; this repo's container has only C.utf8, where every candidate pair I
# tried compares unequal, so a behavioural case here passes whatever the script
# does — worse than no case, because it reads as coverage. This asserts the
# setting is present and says plainly that it is a structural pin.
if grep -qx 'export LC_ALL=C' "$SCRIPT"; then
    ok "the script forces byte collation (LC_ALL=C) before any sort/comm"
else
    bad "the script no longer forces LC_ALL=C — under a UTF-8 locale comm treats two byte-distinct paths that collate equal as common, and a missing row is silently dropped"
fi

# ── 26. Extension matching is case-insensitive ────────────────────
# IsVideoFile lowercases before comparing, so MOVIE.MKV is a video file to the
# scanner. Dropping grep's -i drops such files from the DISK side and reports
# their recorded rows as about to be pruned.
#
# The lowercase companion file is load-bearing. With MOVIE.MKV alone, losing -i
# empties the disk list, which lands on the zero-discovered branch and also
# exits 0 — so the case passed with and without the flag. It did exactly that;
# that is why the second file is here.
fixture upper
R="$TMP/upper"; mkdir -p "$R"
: > "$R/MOVIE.MKV"; : > "$R/lower.mkv"
echo "$R" > "$FIX/roots"
printf '%s\n%s\n' "$R/MOVIE.MKV" "$R/lower.mkv" > "$FIX/recorded"
run
expect_rc 0 "an uppercase extension is a video file here too → exit 0"

# ── 27. A newline or empty string in a library ROOT ───────────────
# The third newline vector. It CANNOT be checked inside the roots loop: the
# roots arrive through `while IFS= read -r r`, so a newline has already split
# one element into two roots before the loop body sees it. Written that way
# first; it was dead code and this case is what caught it. An empty element is
# grouped in because it makes the SCAN's own EvalSymlinks fail, which skips
# its prune — so anything reported for that library would be wrong too.
fixture rootnewline
R="$TMP/rootnewline"; mkdir -p "$R"
: > "$R/A.mkv"
echo "$R" > "$FIX/roots"
echo 1 > "$FIX/n_badroot"
printf '%s\n' "$R/A.mkv" > "$FIX/recorded"
run
expect_rc 2 "a newline or empty entry in libraries.paths → exit 2"
expect_out "read here as two separate roots" "…and says why it will not answer"

# ── 28. A relative path in libraries.paths ────────────────────────
# It resolves against the CHECKER's working directory and the SERVICE's
# separately, so the two would examine different trees.
fixture relroot
echo "some/relative/path" > "$FIX/roots"
printf '%s\n' "some/relative/path/A.mkv" > "$FIX/recorded"
run
expect_rc 2 "a relative library root → exit 2"

# ── 29. A root that can be traversed but not LISTED ───────────────
# Mode 111: classify_root passes it (it IS -x), so this is the one shape
# that still reaches the -r half of the root check.
#
# HONESTY NOTE: this does not strictly PIN that half. Drop the -r test and a
# mode-111 root is walked instead, find errors on every entry, and the
# unreadable latch produces the same exit 2 by a different route — so the
# mutation survives. Probably equivalent in practice; recorded rather than
# claimed as coverage, because five cases in this file have passed for the
# wrong reason and each was found by someone else. Without that half the root
# is walked, `find` errors on every entry, the disk list comes back empty and
# the zero-discovered branch answers — correctly only by way of the unreadable
# latch, which is a different guard. Pin the -r half directly.
if [ "$(id -u)" -eq 0 ] && [ "${#DROP[@]}" -eq 0 ]; then
    bad "execute-only root: running as root and setpriv is unavailable — cannot test"
else
    fixture execonly
    R="$TMP/execonly"; mkdir -p "$R"
    : > "$R/A.mkv"
    echo "$R" > "$FIX/roots"
    printf '%s\n%s\n' "$R/A.mkv" "$R/GONE.mkv" > "$FIX/recorded"
    chmod 111 "$R"
    [ "$(id -u)" -eq 0 ] && { chmod -R a+rX "$TMP/bin" "$FIX" 2>/dev/null; chmod a+rx "$TMP"; }
    OUT="$(PATH="$TMP/bin:$PATH" "${DROP[@]}" env PATH="$TMP/bin:$PATH" \
           FIX="$FIX" AURORA_DB=testdb HOME=/tmp bash "$SCRIPT" 2>&1)"
    RC=$?
    chmod 755 "$R"
    expect_rc 2 "a root that can be entered but not listed → exit 2"
fi

# ── 30. Several libraries in one run ──────────────────────────────
# Every case above drives ONE library, so no per-library state reset and no
# cross-root latch was exercised at all. Two mutations passed the whole suite
# because of it: dropping the per-library `: > "$WORK/disk"` reset (library 2
# then compares against library 1's files, so a row naming a file under
# library 1's root reads as "will be found"), and making the `unreadable`
# latch per-root instead of latching.
fixture multi
printf '1\n2\n3\n' > "$FIX/lib_ids"
L1="$TMP/multi1"; L2="$TMP/multi2"; L3="$TMP/multi3"
mkdir -p "$L1" "$L2" "$L3"
: > "$L1/A.mkv"; : > "$L2/B.mkv"; : > "$L3/C.mkv"
echo "$L1" > "$FIX/roots.1";  printf '%s\n' "$L1/A.mkv" > "$FIX/recorded.1"
echo "$L2" > "$FIX/roots.2"
# Library 2 records a file that lives under LIBRARY 1's root. Its own walk
# cannot find it, so it must be reported — unless library 1's disk list has
# leaked into library 2's comparison.
printf '%s\n%s\n' "$L2/B.mkv" "$L1/A.mkv" > "$FIX/recorded.2"
echo "$L3" > "$FIX/roots.3";  printf '%s\n' "$L3/C.mkv" > "$FIX/recorded.3"
echo Movies > "$FIX/lib_name"; echo movie > "$FIX/lib_type"
run
expect_rc 1 "three libraries, one dirty → exit 1"
expect_out "$L1/A.mkv" "…and the leaked-across row is reported, not absorbed"
case "$OUT" in
    *"library 3"*"all 1 recorded"*) ok "…and the clean library after it is still compared" ;;
    *) bad "library 3 was not compared — per-library state did not survive library 2"; printf '%s\n' "$OUT" | sed 's/^/       | /' ;;
esac

# ── 31. One library, two roots, one with an unreadable subtree ─────
# The `unreadable` latch must survive a LATER clean root. Made per-root
# instead of latching, this library ends the loop with unreadable=0, finds an
# empty disk list and prints "the scan will prune nothing" — the round-2
# defect, restored.
if [ "$(id -u)" -eq 0 ] && [ "${#DROP[@]}" -eq 0 ]; then
    bad "two-root latch: running as root and setpriv is unavailable — cannot test"
else
    fixture latch
    A="$TMP/latchA"; B="$TMP/latchB"
    mkdir -p "$A/sub" "$B"
    : > "$A/sub/A.mkv"          # the library's only media, behind a 0000 dir
    printf '%s\n%s\n' "$A" "$B" > "$FIX/roots"
    printf '%s\n%s\n' "$A/sub/A.mkv" "$A/GONE.mkv" > "$FIX/recorded"
    chmod 000 "$A/sub"
    assert_denied "$A/sub" "two-root latch"
    [ "$(id -u)" -eq 0 ] && { chmod -R a+rX "$TMP/bin" "$FIX" 2>/dev/null; chmod a+rx "$TMP" "$A" "$B"; }
    OUT="$(PATH="$TMP/bin:$PATH" "${DROP[@]}" env PATH="$TMP/bin:$PATH" \
           FIX="$FIX" AURORA_DB=testdb HOME=/tmp bash "$SCRIPT" 2>&1)"
    RC=$?
    chmod 755 "$A/sub"
    expect_rc 2 "an unreadable subtree in the FIRST of two roots → exit 2"
fi

# ── 32. A missing external is fatal, not a quiet all-clear ────────
# `comm` failing leaves `missing` empty, which is the all-clear. There is no
# set -e here, so nothing else catches it.
fixture nocomm
R="$TMP/nocomm"; mkdir -p "$R"
: > "$R/A.mkv"
echo "$R" > "$FIX/roots"
printf '%s\n%s\n' "$R/A.mkv" "$R/DELETED.mkv" > "$FIX/recorded"
# Shadow `comm` with one that always fails, rather than emptying PATH — an
# empty PATH cannot even find bash, so the case exits 127 without ever
# reaching the script and asserts nothing. (It did; hence the note.)
mkdir -p "$TMP/nobin"
printf '#!/bin/sh\nexit 127\n' > "$TMP/nobin/comm"
chmod +x "$TMP/nobin/comm"
OUT="$(PATH="$TMP/nobin:$TMP/bin:$PATH" FIX="$FIX" AURORA_DB=testdb bash "$SCRIPT" 2>&1)"
RC=$?
expect_rc 2 "a comm that fails → exit 2, never an all-clear"

# A `sort` that EXISTS and fails is a different hole, and `command -v` cannot
# see it: the empty disk list it produces feeds the zero-discovered branch,
# which answers "the scan will prune nothing" and exits 0. That was live until
# the pipeline's status was checked.
rm -f "$TMP/nobin/comm"
printf '#!/bin/sh\nexit 127\n' > "$TMP/nobin/sort"
chmod +x "$TMP/nobin/sort"
OUT="$(PATH="$TMP/nobin:$TMP/bin:$PATH" FIX="$FIX" AURORA_DB=testdb bash "$SCRIPT" 2>&1)"
RC=$?
rm -f "$TMP/nobin/sort"
expect_rc 2 "a sort that fails → exit 2, not 'no media found'"

# ── 33. classify_root, directly ───────────────────────────────────
# The absent-vs-blocked decision is where four of the five false all-clears
# lived, so it is unit-tested as well as driven end to end. `absent` is the
# ONLY verdict that leads to exit 0; every ambiguity must land on `blocked`.
echo
echo "classify_root: absent must mean provably absent"
CR="$TMP/cr"
mkdir -p "$CR/real/deep" "$CR/blocked/inner"
ln -s "$CR/nothing-here" "$CR/dangling"
ln -s "$CR/blocked/inner" "$CR/via-blocked"
ln -s "$CR/loopb" "$CR/loopa"; ln -s "$CR/loopa" "$CR/loopb"
cat > "$TMP/probe.sh" <<'PROBE'
source /dev/stdin <<< "$(sed -n '/^classify_root() {/,/^}/p' "$1")"
classify_root "$2"
PROBE
# $4, when given, must appear in the verdict too: it names the guard a case is
# meant to reach, so one guard cannot pass a case written for another.
# CR_FAKEBIN, when set, goes first on PATH (the fake-realpath cases below).
cr_is() {  # $1 = path, $2 = expected first word, $3 = label, [$4 = substring]
    local got
    got="$(PATH="${CR_FAKEBIN:+$CR_FAKEBIN:}$TMP/bin:$PATH" "${DROP[@]}" env HOME=/tmp bash "$TMP/probe.sh" "$SCRIPT" "$1" 2>&1)"
    case "$got" in
        "$2"*"${4:-}"*) ok "$3" ;;
        *) bad "$3 (got: $got)" ;;
    esac
}
chmod 000 "$CR/blocked"
[ "$(id -u)" -eq 0 ] && { chmod -R a+rX "$TMP/bin" 2>/dev/null; chmod a+rx "$TMP" "$CR"; chmod a+r "$TMP/probe.sh" "$SCRIPT"; }
cr_is "$CR/real/deep"       resolved "a fully resolvable path is resolved"
cr_is "$CR/real/deep/nope"  absent   "a missing entry under a READABLE parent is provably absent"
# A dangling symlink must stay `absent`, or an unplugged disk becomes an
# exit 2 the operator cannot clear — the over-report the class fix must not
# introduce while closing the under-report.
cr_is "$CR/dangling"        absent   "a dangling symlink root is absent, not blocked"
cr_is "$CR/dangling/child"  absent   "a path under a dangling symlink is absent"
cr_is "$CR/via-blocked"     blocked  "a symlink INTO an untraversable directory is blocked"
cr_is "$CR/blocked/inner"   blocked  "a direct path into an untraversable directory is blocked"
cr_is "$CR/loopa"           blocked  "a symlink loop is blocked, never absent"
# ── 33b. …whatever realpath -m does on the loop ───────────────────
# On a symlink loop `realpath -m` parts company with itself: GNU coreutils
# carries on lexically and succeeds; uutils — the default `coreutils` on
# Ubuntu 26.04 — fails with ELOOP and prints nothing. classify_root used to
# recurse on that answer, printed `resolved` for the uutils nothing, and the
# case above went red on the 26.04 runner. It no longer calls realpath -m
# at all: it walks a link's target itself, and a loop meets the depth cap.
#
# These fakes put the bad answers back on PATH anyway — only `-m` is faked,
# every other form passes through — so a GNU runner would see one return if
# a later change routed the walk through realpath -m again: the uutils
# failure, and an answer that would read as ABSENT if it were believed. The
# loop must come back blocked under both. (They are verdict-only: which
# guard blocks is the implementation's business; that it is blocked is not.)
REALRP="$(command -v realpath)"
fake_rp() {  # $1 = name, $2 = what `realpath -m -- <target>` does instead
    mkdir -p "$TMP/fakerp-$1"
    printf '#!/bin/sh\n[ "$1" = -m ] && { %s; }\nexec "%s" "$@"\n' "$2" "$REALRP" > "$TMP/fakerp-$1/realpath"
    chmod a+rx "$TMP/fakerp-$1" "$TMP/fakerp-$1/realpath"
}
# Exactly what uutils 0.8.0 and 0.10.0 do: an error on stderr, nothing on
# stdout, status 1.
fake_rp eloop 'echo "realpath: $3: Too many levels of symbolic links" >&2; exit 1'
# Prints a path that would read as absent if believed, and fails.
fake_rp liar 'printf "%s\n" "$3-gone"; exit 1'
CR_FAKEBIN="$TMP/fakerp-eloop"
cr_is "$CR/loopa"           blocked  "…and with a realpath on PATH that FAILS on loops, as uutils does"
CR_FAKEBIN="$TMP/fakerp-liar"
cr_is "$CR/loopa"           blocked  "…and with one that answers a path it would be fatal to believe"
CR_FAKEBIN=""
# The absolute-path guard. Every caller hands classify_root an absolute
# path, so only a tool that failed quietly — an empty canon(), say — can
# hand it anything else. Unguarded, the walk never runs and the function
# falls through to `resolved`.
cr_is ""                    blocked  "an empty path is blocked, never resolved" "not an absolute path"
cr_is "relative/path"       blocked  "…and so is a relative one" "not an absolute path"
# ── 33c. A symlink target ending in a newline ─────────────────────
# `$(...)` strips trailing newlines. A target spelled "hop<newline>" came back
# from readlink as "hop" — another name, absent here — while the real next
# hop is a symlink into the untraversable directory: `absent`, i.e. exit 0,
# where the kernel answers EACCES. GNU and uutils readlink print the target
# alike; the loss was the shell's, so this was wrong on every runner.
# The second case is the same name met one hop further in: a link whose
# target is a link to "f<newline>" (itself a loop). It used to reach the
# walk through realpath -m's answer, where GNU handed the loop back as
# itself and the stripped "f" read as absent; the walk now follows the
# target itself, so it is readlink's capture that meets the newline, on
# either build.
#
# NLFS: does this filesystem take a newline in a name at all? Refusal is the
# one reason to skip, as in cases 19 and 44. Any OTHER setup failure is a
# `bad`: an `ln` that failed part way used to drop both cases with an "ok".
NLFS=0
{ : > "$TMP/nl-probe"$'\n'; } 2>/dev/null && [ -e "$TMP/nl-probe"$'\n' ] && NLFS=1
if [ "$NLFS" -eq 0 ]; then
    ok "newline-terminated symlink targets: SKIPPED (filesystem refused a newline in a name)"
elif ! { ln -s "$CR/blocked/inner" "$CR/hop"$'\n' \
         && ln -s "$CR/hop"$'\n' "$CR/nl-target" \
         && ln -s "$CR/f"$'\n' "$CR/f"$'\n' \
         && ln -s "$CR/f"$'\n' "$CR/to-nl-loop" \
         && ln -s "$CR/to-nl-loop" "$CR/via-nl-loop"; }; then
    bad "newline-terminated symlink targets: could not build the fixture — both cases would go unrun"
else
    cr_is "$CR/nl-target"   blocked  "a symlink target ending in a newline is not shortened into an absent name" "contains a newline"
    cr_is "$CR/via-nl-loop" blocked  "…nor is one met a hop further in" "contains a newline"
fi
# ── 33d. A readlink that exits 0 and prints nothing ───────────────
# Linux cannot create a symlink with an empty target, so only a quietly
# broken readlink reaches the empty-target arm. Unguarded, the empty target
# is "relative", is joined to the link's directory, and that directory comes
# back `resolved`. Faked, as realpath is in 33b.
mkdir -p "$TMP/fakerl-silent"
printf '#!/bin/sh\nexit 0\n' > "$TMP/fakerl-silent/readlink"
chmod a+rx "$TMP/fakerl-silent" "$TMP/fakerl-silent/readlink"
CR_FAKEBIN="$TMP/fakerl-silent"
cr_is "$CR/dangling"        blocked  "a readlink that exits 0 and prints nothing is not followed" "empty or contains a newline"
CR_FAKEBIN=""
# ── 33e. `..` after a component this user cannot enter ────────────
# realpath -m resolves what it can and treats the rest LEXICALLY, so after a
# component it could not enter, a `..` stepped back over the NAME rather than
# over where the name leads. Here `movies -> wall/in/../../media` with `wall`
# untraversable and `in` a link to q/r/s: the kernel (and the service user,
# who can enter `wall`) lands on q/media, which exists; realpath -m, as a
# user who cannot, landed on <dd>/media, which does not — and the root read
# as `absent`, exit 0, over a prune. The walk now takes the target as
# written, so the kernel meets `wall` and the answer is blocked.
DD="$CR/dd"
mkdir -p "$DD/lib" "$DD/wall" "$DD/q/r/s" "$DD/q/media/films"
ln -s "$DD/q/r/s" "$DD/wall/in"
ln -s "$DD/wall/in/../../media" "$DD/lib/movies"
chmod 000 "$DD/wall"
[ "$(id -u)" -eq 0 ] && chmod a+rx "$DD" "$DD/lib" "$DD/q" "$DD/q/media" "$DD/q/media/films"
assert_denied "$DD/wall" "dotdot after a wall"
cr_is "$DD/lib/movies/films" blocked "a target that crosses an untraversable directory and then '..' is blocked, not absent" "cannot traverse"
chmod 755 "$DD/wall"
# Control: once `wall` can be entered, the same root resolves (to q/media).
cr_is "$DD/lib/movies/films" resolved "…and once the directory can be entered, it resolves where the kernel says"
# ── 33f. A lookup that fails for a reason other than absence ──────
# `-e` and `-L` fail alike on EVERY lstat error, and a searchable parent
# does not make the error ENOENT. A FUSE mount without allow_other answers
# EACCES to anyone but its owner — root included — under a parent anyone can
# search, and read as `absent`: "the scan will skip its prune", exit 0, while
# the service user (the mount's owner) walked the root and pruned. The fix
# asks the kernel why, and only ENOENT and ENOTDIR are absence.
# FUSE cannot be mounted here, so this pins the same branch with another
# error the kernel gives under a searchable parent: ENAMETOOLONG, from a
# path longer than PATH_MAX made of `.` components — which this walk now
# meets for real when it follows a link target as written (case 54).
LONGP="$CR/real"; i=0; while [ "$i" -lt 2100 ]; do LONGP="$LONGP/."; i=$((i + 1)); done
cr_is "$LONGP/deep"          blocked  "a path the kernel refuses as too long is blocked, not absent" "File name too long"
# The controls, on the same branch: a genuinely missing name is still
# absent, and so is a name under an executable regular file (ENOTDIR) — the
# scanner's EvalSymlinks fails there too, which is walkFailed for a root.
cr_is "$CR/real/./deep/nope" absent   "…and a genuinely missing one is still absent"
: > "$CR/execfile"; chmod 755 "$CR/execfile"
cr_is "$CR/execfile/x"       absent   "…and so is a name under an executable non-directory (ENOTDIR)"
# A TRAILING slash after it is the same ENOTDIR to the kernel, and the walk
# used to drop the slash and answer `resolved` — so a link to `x.mkv/` was
# recorded as unresolved and, alone, made its library exit 2, while
# `x.mkv/.` and `x.mkv//` read absent (exit 0, which is exact: the scanner
# shields all three). A directory with a trailing slash still resolves.
cr_is "$CR/execfile/"        absent   "an executable file with a trailing slash is ENOTDIR, absent, not resolved"
cr_is "$CR/real/deep/"       resolved "…and a directory with one still resolves"
# `/` itself ends in a slash, and the walk never runs for it, so the
# trailing-slash test once saw an empty path and read `/` as blocked.
for p in / // /.; do
    cr_is "$p"               resolved "…and so does the root directory, spelled $p"
done
# `builtin cd`, so an exported function named cd cannot answer for the
# kernel. The fake would turn these genuinely absent names into `blocked`
# (and one answering "No such file or directory" could turn a refusal into
# `absent`). Both probes: the missing name, and the trailing slash.
for p in "$CR/real/deep/nope" "$CR/execfile/"; do
    got="$(PATH="$TMP/bin:$PATH" "${DROP[@]}" env HOME=/tmp 'BASH_FUNC_cd%%=() { echo "fake: Permission denied" >&2; return 1; }' \
           bash "$TMP/probe.sh" "$SCRIPT" "$p" 2>&1)"
    case "$got" in
        absent) ok "an exported function named cd does not answer in the probe's place (${p#"$CR/"})" ;;
        *) bad "an exported function named cd answered in the probe's place for ${p#"$CR/"} (got: $got)" ;;
    esac
done
# The kernel's words are read in the C locale, so the match does not depend
# on the operator's language. STRUCTURAL, as case 25 is, and for the same
# reason: only C locales exist on this kind of runner, so a behavioural case
# would pass whether or not the locale is forced.
# Captured, then matched — not `sed | grep -q`, which under pipefail fails
# whenever grep's early exit hands sed a SIGPIPE (it did, under load).
CRFN="$(sed -n '/^classify_root() {/,/^}/p' "$SCRIPT")"
case "$CRFN" in
    *'why="$(LC_ALL=C; builtin cd -P -- "$acc" 2>&1)"'*'why2="$(LC_ALL=C; builtin cd -P -- "$path" 2>&1)"'*)
        ok "classify_root asks the kernel why in the C locale, without opening the path (builtin cd -P, both probes)" ;;
    *)  bad "classify_root's errno probes no longer force LC_ALL=C or no longer use builtin cd -P — the absence match depends on the locale, or it opens what it probes" ;;
esac
# Search permission, not read, is what makes an absence conclusive. 0711 is the
# ordinary mode of /home/<user>, and requiring `r` here turned every genuinely
# absent root under a home directory into an exit 2 nobody could clear.
mkdir -p "$CR/x_only"; chmod 711 "$CR/x_only"
cr_is "$CR/x_only/gone"     absent   "a missing entry under a SEARCHABLE but unlistable parent is absent"
chmod 600 "$CR/x_only"
cr_is "$CR/x_only/gone"     blocked  "…but with no search permission at all it is blocked"
chmod 755 "$CR/x_only"
chmod 755 "$CR/blocked"

# ── 34. The round-4 HIGH, end to end ──────────────────────────────
# An untraversable ancestor reached THROUGH a symlinked component. `test -e`
# follows symlinks, so it failed with EACCES while the lexical parent was
# traversable — and the old premise ("its parent was traversable, so this is
# ENOENT") turned that into "does not exist, nothing will be deleted", exit 0.
if [ "$(id -u)" -eq 0 ] && [ "${#DROP[@]}" -eq 0 ]; then
    bad "symlinked-ancestor EACCES: running as root and setpriv is unavailable"
else
    echo
    fixture symanc
    mkdir -p "$TMP/symanc/pool0/storage/movies"
    : > "$TMP/symanc/pool0/storage/movies/A.mkv"
    ln -s "$TMP/symanc/pool0/storage" "$TMP/symanc/srv"
    echo "$TMP/symanc/srv/movies" > "$FIX/roots"
    printf '%s\n%s\n' "$TMP/symanc/srv/movies/A.mkv" "$TMP/symanc/srv/movies/GONE.mkv" > "$FIX/recorded"
    chmod 000 "$TMP/symanc/pool0"
    assert_denied "$TMP/symanc/pool0" "ancestor behind a symlink"
    [ "$(id -u)" -eq 0 ] && { chmod -R a+rX "$TMP/bin" "$FIX" 2>/dev/null; chmod a+rx "$TMP" "$TMP/symanc"; }
    OUT="$(PATH="$TMP/bin:$PATH" "${DROP[@]}" env PATH="$TMP/bin:$PATH" \
           FIX="$FIX" AURORA_DB=testdb HOME=/tmp bash "$SCRIPT" 2>&1)"
    RC=$?
    chmod 755 "$TMP/symanc/pool0"
    expect_rc 2 "an untraversable ancestor BEHIND a symlink → exit 2, not 'does not exist'"
    expect_out "cannot traverse" "…and names the component that actually blocked it"

    # Control: the same tree, traversable — the orphan must be reported.
    run
    expect_rc 1 "…and once traversable, the orphan is found → exit 1"
fi

# ── 35. The per-library rootmissing reset ─────────────────────────
# rootmissing is the one per-library latch whose LEAK produces exit 0 rather
# than exit 2: library 1 has an absent root (correctly "the scan skips its
# prune"), and if that latch survives into library 2 it suppresses the exit-2
# path there too, so library 2's real orphans are reported under a heading
# that says nothing will be deleted. Case 30 pins the $WORK/disk reset; this
# pins the one that matters more.
fixture rmreset
printf '1\n2\n' > "$FIX/lib_ids"
L2="$TMP/rmreset2"; mkdir -p "$L2"; : > "$L2/B.mkv"
echo "$TMP/rmreset-absent" > "$FIX/roots.1"
printf '%s\n' "$TMP/rmreset-absent/A.mkv" > "$FIX/recorded.1"
echo "$L2" > "$FIX/roots.2"
printf '%s\n%s\n' "$L2/B.mkv" "$L2/DELETED.mkv" > "$FIX/recorded.2"
run
expect_rc 1 "an absent root in library 1 does not suppress library 2's orphans"
expect_out "DELETED.mkv" "…and library 2's missing row is named"

# ── 36. dirname is required to resolve a RELATIVE symlink target ──
# classify_root recurses on an unresolvable symlink's target, and a relative
# target is made absolute with dirname. Without it the recursion runs on the
# wrong path and can return `absent` for one that is merely blocked — which is
# the whole class this function exists to close, reintroduced through a
# missing coreutils binary.
if [ "$(id -u)" -eq 0 ] && [ "${#DROP[@]}" -eq 0 ]; then
    bad "relative symlink target: running as root and setpriv is unavailable"
else
    fixture relsym
    mkdir -p "$TMP/relsym/base/wall/inner"
    : > "$TMP/relsym/base/wall/inner/A.mkv"
    ln -s wall/inner "$TMP/relsym/base/link"
    echo "$TMP/relsym/base/link" > "$FIX/roots"
    printf '%s\n%s\n' "$TMP/relsym/base/link/A.mkv" "$TMP/relsym/base/link/GONE.mkv" > "$FIX/recorded"
    chmod 000 "$TMP/relsym/base/wall"
    assert_denied "$TMP/relsym/base/wall" "relative symlink target"
    [ "$(id -u)" -eq 0 ] && { chmod -R a+rX "$TMP/bin" "$FIX" 2>/dev/null; chmod a+rx "$TMP" "$TMP/relsym" "$TMP/relsym/base"; }
    OUT="$(PATH="$TMP/bin:$PATH" "${DROP[@]}" env PATH="$TMP/bin:$PATH" \
           FIX="$FIX" AURORA_DB=testdb HOME=/tmp bash "$SCRIPT" 2>&1)"
    RC=$?
    chmod 755 "$TMP/relsym/base/wall"
    expect_rc 2 "a RELATIVE symlink into an untraversable directory → exit 2"
fi

# ── 37. Each status guard, individually ───────────────────────────
# Case 32 shadows a tool GLOBALLY, so whichever guard fires first satisfies it
# and the siblings can each be removed with the suite still green — a case
# passing through the wrong guard. These shadow one INVOCATION at a time and
# assert on the specific message, so each guard is pinned on its own.
#
# The tool is made to fail only in the shape that reaches the guard under test:
# `sort` reading a FILE operand is the disk side, `sort` reading STDIN is the
# recorded side (a pipe). That distinction is what separates the two sort
# guards, which are otherwise indistinguishable from outside.
guard_case() {  # $1 = stub body, $2 = expected message fragment, $3 = label
    local tool="$4"
    mkdir -p "$TMP/guardbin"
    printf '%s\n' "$1" > "$TMP/guardbin/$tool"
    chmod +x "$TMP/guardbin/$tool"
    OUT="$(PATH="$TMP/guardbin:$TMP/bin:$PATH" FIX="$FIX" AURORA_DB=testdb \
           TMP_SEDCOUNT="$TMP/sedcount" bash "$SCRIPT" 2>&1)"
    RC=$?
    rm -f "$TMP/guardbin/$tool" "$TMP/sedcount"
    if [ "$RC" = 2 ] && case "$OUT" in *"$2"*) true ;; *) false ;; esac; then
        ok "$3"
    else
        bad "$3 (exit $RC)"; printf '%s\n' "$OUT" | sed 's/^/       | /'
    fi
}

fixture guards
R="$TMP/guards"; mkdir -p "$R"
: > "$R/A.mkv"
echo "$R" > "$FIX/roots"
printf '%s\n%s\n' "$R/A.mkv" "$R/DELETED.mkv" > "$FIX/recorded"

# grep: fails only when asked to write disk.video (a -E invocation with a file
# operand). The stub passes every other grep through to the real one.
# Fails only the invocation with a FILE operand — the disk.video filter. The
# startup probe pipes through stdin, so it still passes and this reaches the
# per-site guard instead of dying at the probe. A GLOBALLY broken grep is
# caught by the probe, which is the better outcome and has its own case below.
guard_case '#!/bin/sh
for a in "$@"; do case "$a" in /*) exit 2 ;; esac; done
exec /usr/bin/grep "$@"'   "grep failed while filtering" "the grep guard fires on its own" grep

# sort with a FILE operand — the disk side.
guard_case '#!/bin/sh
case "$*" in *disk.video*) exit 2 ;; esac
exec /usr/bin/sort "$@"'   "sort failed while ordering the discovered files" "the disk-side sort guard fires on its own" sort

# sort reading STDIN — the recorded side.
guard_case '#!/bin/sh
case "$*" in *disk.video*) exec /usr/bin/sort "$@" ;; esac
exit 2'   "ordering the recorded paths" "the recorded-side sort guard fires on its own" sort

# comm -23 builds `missing`; comm -13 builds `unknown`. Only the first can
# produce a false all-clear, so it gets its own case.
guard_case '#!/bin/sh
case "$*" in *-23*) exit 2 ;; esac
exec /usr/bin/comm "$@"'   "comm failed while comparing the recorded paths" "the missing-side comm guard fires on its own" comm

# sed, second invocation: the `missing` filter. This one produced the
# all-clear with NO diagnostic on stdout or stderr at all — the worst shape in
# the file. An always-failing sed is caught upstream by the db_list pipeline,
# which is why shadowing the tool globally could not see it.
# A counter FILE, not a variable: each invocation is its own process, so an
# env var cannot carry "this is the second call". The db_list filter is call 1
# and is guarded upstream; the `missing` filter is call 2, which was not.
rm -f "$TMP/sedcount"
guard_case '#!/bin/sh
n=0
[ -f "$TMP_SEDCOUNT" ] && n=$(cat "$TMP_SEDCOUNT")
n=$((n + 1)); echo "$n" > "$TMP_SEDCOUNT"
[ "$n" -eq 2 ] && exit 2
exec /bin/sed "$@"' \
  "trimming the missing-file list" "the sed guard fires on its own" sed

# wc: an empty count falls through the `-gt 0` test into the all-clear arm.
guard_case '#!/bin/sh
exit 2' \
  "wc failed" "the wc guard fires on its own" wc

# find: a silent non-zero exit. Gated on finderr being EMPTY, because GNU find
# also exits 1 on an ordinary permission error — which the unreadable latch
# already handles and must NOT be turned into a die.
# -print0 only: the startup probe uses -print and must still pass.
guard_case '#!/bin/sh
case "$*" in *-print0*) exit 1 ;; esac
exec /usr/bin/find "$@"' \
  "find failed on" "the find status guard fires on its own" find

# ...and the same find failing NOISILY must NOT die: that is a permission
# error, the latch handles it, and dying would be an over-report on every
# library that has one unreadable folder.
fixture find_noisy
R="$TMP/find_noisy"; mkdir -p "$R"
: > "$R/A.mkv"
echo "$R" > "$FIX/roots"
printf '%s\n' "$R/A.mkv" > "$FIX/recorded"
mkdir -p "$TMP/guardbin"
{
  echo '#!/bin/sh'
  echo '/usr/bin/find "$@"'
  echo 'echo "find: permission denied somewhere" >&2'
  echo 'exit 1'
} > "$TMP/guardbin/find"
chmod +x "$TMP/guardbin/find"
OUT="$(PATH="$TMP/guardbin:$TMP/bin:$PATH" FIX="$FIX" AURORA_DB=testdb bash "$SCRIPT" 2>&1)"
RC=$?
rm -f "$TMP/guardbin/find"
if [ "$RC" = 0 ]; then ok "a find that fails NOISILY is the unreadable latch, not a die"
else bad "a noisy find was treated as an unexplained failure (exit 2)"; printf '%s\n' "$OUT" | sed 's/^/       | /'; fi

# ── 38. The missing-root REPORT names the right root ──────────────
# With one absent root and one merely blocked, the report loop used to re-test
# each root with `realpath -e` — the ENOENT/EACCES conflation classify_root
# exists to avoid — and labelled the blocked root "missing root". Exit code
# unaffected; the sentence was the one this file spends eighty lines saying is
# wrong. (rootmissing dominates, so this library exits 0 either way.)
if [ "$(id -u)" -eq 0 ] && [ "${#DROP[@]}" -eq 0 ]; then
    bad "missing-root report: running as root and setpriv is unavailable"
else
    # The blocked component must be an ANCESTOR of the root, not the root
    # itself: `realpath -e` on a chmod-000 DIRECTORY succeeds (stat needs x on
    # the parent, not on the target), so a root-level block does not
    # distinguish the two implementations. One level up does.
    fixture reportlabel
    W="$TMP/reportlabel-wall"; B="$W/inner"; mkdir -p "$B"
    : > "$B/A.mkv"
    printf '%s\n%s\n' "$TMP/reportlabel-absent" "$B" > "$FIX/roots"
    printf '%s\n' "$B/A.mkv" > "$FIX/recorded"
    chmod 000 "$W"
    assert_denied "$W" "missing-root report label"
    [ "$(id -u)" -eq 0 ] && { chmod -R a+rX "$TMP/bin" "$FIX" 2>/dev/null; chmod a+rx "$TMP"; }
    OUT="$(PATH="$TMP/bin:$PATH" "${DROP[@]}" env PATH="$TMP/bin:$PATH" \
           FIX="$FIX" AURORA_DB=testdb HOME=/tmp bash "$SCRIPT" 2>&1)"
    RC=$?
    # Probed BEFORE the restore below, or it reports on a wall that is already
    # down — which is what it did first, and the mode police caught it.
    wallverdict="$(PATH="$TMP/bin:$PATH" "${DROP[@]}" env HOME=/tmp bash "$TMP/probe.sh" "$SCRIPT" "$B" 2>&1)"
    chmod 755 "$W"
    # The negative half alone is not enough: a root that is merely RESOLVED is
    # also not labelled, so the assertion holds identically when the wall was
    # never built. On a non-root runner that made this case unable to detect
    # the regression it exists for. assert_denied above proves the state, and
    # the classify_root probe proves the script sees it as blocked.
    case "$wallverdict" in
        blocked*) ;;
        *) bad "missing-root report: the wall was not blocked (classify_root said '$wallverdict') — this case would pass vacuously" ;;
    esac
    if printf '%s\n' "$OUT" | grep -q "missing root: $TMP/reportlabel-absent" \
       && ! printf '%s\n' "$OUT" | grep -q "missing root: $B"; then
        ok "only the genuinely absent root is labelled 'missing root'"
    else
        bad "the blocked root was labelled missing (exit $RC)"; printf '%s\n' "$OUT" | sed 's/^/       | /'
    fi
fi

# ── 39. The WRITER half of the find pipeline ──────────────────────
# PIPESTATUS has two entries and only the first was checked. The reader — the
# loop that writes $WORK/disk — empties the disk list just as thoroughly when
# its write fails, and every downstream guard is satisfied: grep exits 1 on an
# empty file, sort succeeds on it, and the run reports "no media found, so the
# scan will prune nothing", exit 0.
#
# `ulimit -f 0` reproduces it portably (no mount, no root). It was originally
# found on a real full tmpfs, where `mktemp -d` and `: > disk` both still
# succeed, so nothing earlier notices.
fixture writerfail
R="$TMP/writerfail"; mkdir -p "$R"
: > "$R/A.mkv"
echo "$R" > "$FIX/roots"
printf '%s\n%s\n' "$R/A.mkv" "$R/DELETED.mkv" > "$FIX/recorded"
OUT="$(PATH="$TMP/bin:$PATH" FIX="$FIX" AURORA_DB=testdb \
       bash -c 'ulimit -f 0 2>/dev/null; exec bash "$1"' _ "$SCRIPT" 2>&1)"
RC=$?
expect_rc 2 "a failing WRITE of the discovered-file list → exit 2, not 'no media found'"
expect_out "could not record what find discovered" "…through the recording guard, not some other die"

# ── 40. The writer failing when the LAST entry takes `continue` ───
# A while loop's exit status is whatever its LAST body command returned, and
# every path in that body that ends in `continue` (a newline name, a link that
# does not resolve, a link realpath gave no answer for, a link that escapes
# the root) returns 0. So a run where every
# write failed but the final entry was one of those reported PIPESTATUS[1]=0,
# left the disk list empty, and answered "no media found, so the scan will
# prune nothing". Case 39 could not see it: bare `ulimit -f 0` KILLS the
# subshell with SIGXFSZ on the first write, and a signal death sets the status
# regardless of ordering, so that case is structurally blind to the very thing
# it looks like it covers. `trap "" XFSZ` makes printf RETURN the error
# instead, which is what a full filesystem actually does.
#
# A dangling symlink under a library root is the most ordinary artefact of the
# half-finished move this script exists for, so this ordering is the likely
# one, not the exotic one.
fixture writerorder
R="$TMP/writerorder"; mkdir -p "$R"
# MANY dangling symlinks around ONE plain file, and then an ASSERTED
# precondition. The defect needs find's LAST emitted entry to take a
# `continue` path, and find emits in readdir order, which is the
# FILESYSTEM's, not find's: ext4 hands back a hash order, and tmpfs — which
# Ubuntu 26.04's systemd mounts on /tmp by default — hands back NEWEST FIRST
# (measured on Linux 6.18). The first version created the file first and
# twenty symlinks after it, which put the file mid-way through an ext4 hash
# order and LAST on tmpfs. Reproduced on tmpfs with GNU find; the likely
# reason this case went red on the 26.04 runner with no change to either
# script.
# So the file sits in the MIDDLE of both creation order and name order
# (a01…a10, then m-keep, then z01…z10): it cannot come last whether the
# directory is read oldest first, newest first, or sorted either way. A hash
# order can still put it last, so a few other names are tried — each one is
# hashed afresh — and the check below then makes it impossible for the case
# to pass without the ordering: a fixture that does not reproduce it fails
# loudly instead of quietly asserting nothing.
i=1; while [ "$i" -le 10 ]; do ln -s "$TMP/writerorder-no-target.mkv" "$R/a$(printf %02d "$i").mkv"; i=$((i + 1)); done
keep="$R/m-keep.mkv"; : > "$keep"
i=1; while [ "$i" -le 10 ]; do ln -s "$TMP/writerorder-no-target.mkv" "$R/z$(printf %02d "$i").mkv"; i=$((i + 1)); done
lastentry="$(find "$R" ! -type d -print0 | tr '\0' '\n' | grep -v '^$' | tail -1)"
try=1
while [ ! -L "$lastentry" ] && [ "$try" -le 5 ]; do
    rm -f "$keep"; keep="$R/m-keep$try.mkv"; : > "$keep"
    lastentry="$(find "$R" ! -type d -print0 | tr '\0' '\n' | grep -v '^$' | tail -1)"
    try=$((try + 1))
done
if [ ! -L "$lastentry" ]; then
    bad "writer-ordering: find emitted a plain file last ($lastentry), so the continue-path ordering this case needs was not built — it would pass without testing anything"
fi
echo "$R" > "$FIX/roots"
printf '%s\n%s\n' "$keep" "$R/DELETED.mkv" > "$FIX/recorded"
OUT="$(PATH="$TMP/bin:$PATH" FIX="$FIX" AURORA_DB=testdb \
       bash -c 'trap "" XFSZ; ulimit -f 0 2>/dev/null; exec bash "$1"' _ "$SCRIPT" 2>&1)"
RC=$?
expect_rc 2 "a failed write whose LAST entry takes continue → exit 2, not 'no media found'"
expect_out "could not record what find discovered" "…and says the recording failed, not that the disk is empty"

# The control: the same failure with a plain file last. Both orderings must
# die, or the guard is merely ordering-dependent in the other direction.
# ONLY plain files, so the last entry is necessarily one — no ordering to
# assert and nothing to get wrong. (The first attempt put one symlink beside
# one file and asserted the file came last; readdir handed back the symlink,
# and the control failed on its own premise. Ordering is not arrangeable here,
# so the control simply removes the possibility.)
fixture writerorder2
R="$TMP/writerorder2"; mkdir -p "$R"
: > "$R/aa.mkv"; : > "$R/zz.mkv"
echo "$R" > "$FIX/roots"
printf '%s\n%s\n' "$R/zz.mkv" "$R/DELETED.mkv" > "$FIX/recorded"
OUT="$(PATH="$TMP/bin:$PATH" FIX="$FIX" AURORA_DB=testdb \
       bash -c 'trap "" XFSZ; ulimit -f 0 2>/dev/null; exec bash "$1"' _ "$SCRIPT" 2>&1)"
RC=$?
expect_rc 2 "…and the same with a plain file last"

# ── 41. The findfail deferral behind rootmissing ──────────────────
# Any root failing EvalSymlinks makes the scan skip the prune for the WHOLE
# library, so a find failure alongside an absent root must not become an
# exit 2 the operator cannot clear.
fixture findfail_defer
R="$TMP/findfail_defer"; mkdir -p "$R"
: > "$R/A.mkv"
printf '%s\n%s\n' "$TMP/findfail_defer-absent" "$R" > "$FIX/roots"
printf '%s\n' "$R/A.mkv" > "$FIX/recorded"
mkdir -p "$TMP/guardbin"
# The stub touches a marker, and the case asserts it ran. Without that, this
# passes identically with no stub at all — the absent root reaches exit 0 on
# its own — so it would go on "covering" the deferral while covering nothing.
rm -f "$TMP/findstub-ran"
{
  echo '#!/bin/sh'
  # -print0 only, so the startup known-answer probe still passes.
  echo 'case "$*" in *-print0*) : > "$FINDSTUB_MARKER"; exit 1 ;; esac'
  echo 'exec /usr/bin/find "$@"'
} > "$TMP/guardbin/find"
chmod +x "$TMP/guardbin/find"
OUT="$(PATH="$TMP/guardbin:$TMP/bin:$PATH" FIX="$FIX" AURORA_DB=testdb \
       FINDSTUB_MARKER="$TMP/findstub-ran" bash "$SCRIPT" 2>&1)"
RC=$?
rm -f "$TMP/guardbin/find"
[ -f "$TMP/findstub-ran" ] || bad "findfail deferral: the find stub never ran, so this case proves nothing about the deferral"
expect_rc 0 "a find failure alongside an ABSENT root → exit 0 (walkFailed skips the prune)"

# ── 42. A tool that exits 0 and prints NOTHING ────────────────────
# The status guards close the non-zero case. `wc` returning 0 with empty
# output leaves the count empty, which falls straight through the `-gt 0`
# test into the all-clear with only a `[: : integer expression expected` on
# stderr to show for it. The guard's own message said as much while checking
# only the status.
fixture wcempty
R="$TMP/wcempty"; mkdir -p "$R"
: > "$R/A.mkv"
echo "$R" > "$FIX/roots"
printf '%s\n%s\n' "$R/A.mkv" "$R/DELETED.mkv" > "$FIX/recorded"
# The stub READS its input before exiting. wc sits at the end of
# `printf | wc -l`, and a stub that exits without reading races the printf:
# when it wins, printf takes SIGPIPE, pipefail turns that into the STATUS
# guard ("wc failed"), and this case — which asserts the VALUE guard — fails
# with the right exit code and the wrong message. Seen once in about thirty
# runs, under eight suites in parallel. Draining stdin removes the race.
guard_case '#!/bin/sh
cat > /dev/null
exit 0' \
  "is not a number" "a wc that exits 0 and prints nothing → exit 2" wc

# ── 43. mktemp producing no usable directory ──────────────────────
# An empty $WORK is not merely useless: under the documented `sudo`
# invocation every scratch file would be written to the FILESYSTEM ROOT
# (/disk, /finderr, …). Observed before the check was added.
fixture mktempfail
R="$TMP/mktempfail"; mkdir -p "$R"
: > "$R/A.mkv"
echo "$R" > "$FIX/roots"
printf '%s\n' "$R/A.mkv" > "$FIX/recorded"
# Exits 0 and prints NOTHING — the shape that reaches the second check. An
# exit-1 shadow is caught by the `|| die` on the call itself, so it leaves the
# empty-result check unpinned (it did).
guard_case '#!/bin/sh
exit 0' \
  "no usable directory" "a mktemp that succeeds but returns nothing → exit 2" mktemp

# ── 44. The badnames write, when it is the failing one ────────────
# A newline-named video file routes to $WORK/badnames rather than to the disk
# list. If THAT write fails silently the badnames file stays empty, the
# newline refusal never fires, and the run compares a truncated disk list —
# the all-clear by a second route. Needs the write to fail, hence the same
# XFSZ trick as case 40.
# ONLY the newline-named entry. With a plain file beside it, that file's own
# failing disk write dies first and masks this one — a case passing through
# the wrong guard, which is the shape five earlier cases had.
fixture badnamewrite
R="$TMP/badnamewrite"; mkdir -p "$R"
touch "$R/$(printf 'weird\nname.mkv')" 2>/dev/null || true
if [ -e "$R/$(printf 'weird\nname.mkv')" ]; then
    echo "$R" > "$FIX/roots"
    printf '%s\n' "$R/DELETED.mkv" > "$FIX/recorded"
    OUT="$(PATH="$TMP/bin:$PATH" FIX="$FIX" AURORA_DB=testdb \
           bash -c 'trap "" XFSZ; ulimit -f 0 2>/dev/null; exec bash "$1"' _ "$SCRIPT" 2>&1)"
    RC=$?
    expect_rc 2 "a failing badnames write → exit 2, not a truncated comparison"
    # WHICH die matters. Without this the case is satisfied by the
    # newline-in-filename refusal, which fires whether or not the write
    # failed — so deleting the fault injection left the suite green. The
    # seventh case in this file to pass for the wrong reason.
    expect_out "could not record what find discovered" "…through the recording guard, not the newline refusal"
else
    ok "badnames write: SKIPPED (filesystem refused a newline in a filename)"
fi

# ── 45. Exit 0 with EMPTY output, per site ────────────────────────
# The status guards close the non-zero case. A tool that exits 0 and prints
# nothing defeats them, and that was closed for wc and mktemp one round before
# being carried to the three siblings on the same decision path — where each
# one produced a clean exit 0 on a library with a row that would be pruned.
#
# Each site now tests a CONTRADICTION it already holds the evidence for
# (a non-empty input yielding empty output), except comm, where an empty
# result is the legitimate all-clear and the cross-check is arithmetic.
fixture emptyout
R="$TMP/emptyout"; mkdir -p "$R"
: > "$R/A.mkv"; : > "$R/B.mkv"
echo "$R" > "$FIX/roots"
printf '%s\n%s\n%s\n' "$R/A.mkv" "$R/B.mkv" "$R/DELETED.mkv" > "$FIX/recorded"

guard_case '#!/bin/sh
case "$*" in *disk.video*) exit 0 ;; esac
exec /usr/bin/sort "$@"' \
  "sort returned nothing from a non-empty file" "a sort exiting 0 with no output (disk side) → exit 2" sort

# The recorded side is a PIPELINE (printf | sed | sort), so a sort that exits
# without reading hands sed a SIGPIPE and `pipefail` catches it in the status
# guard before the value guard is reached. Either die is correct — the point is
# that no route here reaches exit 0 — so this asserts the exit code and says
# why the message is the status one.
mkdir -p "$TMP/guardbin"
{
  echo '#!/bin/sh'
  echo 'case "$*" in *disk.video*) exec /usr/bin/sort "$@" ;; esac'
  echo 'exit 0'
} > "$TMP/guardbin/sort"
chmod +x "$TMP/guardbin/sort"
OUT="$(PATH="$TMP/guardbin:$TMP/bin:$PATH" FIX="$FIX" AURORA_DB=testdb bash "$SCRIPT" 2>&1)"
RC=$?
rm -f "$TMP/guardbin/sort"
expect_rc 2 "a sort exiting 0 with no output (recorded side) → exit 2"

guard_case '#!/bin/sh
exit 0' \
  "empty" "a sed exiting 0 with no output → exit 2" sed

guard_case '#!/bin/sh
case "$*" in *-23*) exit 0 ;; esac
exec /usr/bin/comm "$@"' \
  "does not add up" "a comm exiting 0 with no output → exit 2, via the arithmetic cross-check" comm

# ── 46. The known-answer probes ───────────────────────────────────
# `find` and `grep` are the one pair whose empty output is legitimately
# meaningful — an empty root, or a root with no video files — so a broken one
# is indistinguishable from the truth AT THE CALL SITE, and the all-clear it
# produces is the dangerous one. The probes move the question off the call
# site: both have exactly one right answer, so a tool that gets them wrong
# cannot be trusted for the real one.
fixture probes
R="$TMP/probes"; mkdir -p "$R"
: > "$R/A.mkv"
echo "$R" > "$FIX/roots"
printf '%s\n%s\n' "$R/A.mkv" "$R/DELETED.mkv" > "$FIX/recorded"

guard_case '#!/bin/sh
exit 0' \
  "did not match a known video filename" "a grep that matches nothing at all → caught at startup" grep

guard_case '#!/bin/sh
exit 0' \
  "did not report a directory that exists" "a find that outputs nothing at all → caught at startup" find

# ── 47. A looping root, end to end ────────────────────────────────
# Case 33b pins classify_root itself. End to end, the uutils failure did NOT
# reach exit 0: classify_root said `resolved`, and the `realpath -e` behind
# it — there for exactly this — failed on the loop and refused instead. So
# the exit code alone cannot tell the fix from the bug; the reason can. The
# verdict must come from classify_root's own depth cap, under whichever
# realpath is installed and under the uutils-shaped fake (classify_root no
# longer calls realpath -m, so neither can change it).
fixture e2eloop
L="$TMP/e2eloop"; mkdir -p "$L"
ln -s "$L/loopb" "$L/loopa"; ln -s "$L/loopa" "$L/loopb"
echo "$L/loopa" > "$FIX/roots"
printf '%s\n' "$L/loopa/A.mkv" > "$FIX/recorded"
for rpbin in "" "$TMP/fakerp-eloop"; do
    what="the installed realpath"; [ -n "$rpbin" ] && what="a realpath that fails on loops"
    OUT="$(PATH="${rpbin:+$rpbin:}$TMP/bin:$PATH" FIX="$FIX" AURORA_DB=testdb bash "$SCRIPT" 2>&1)"
    RC=$?
    expect_rc 2 "a looping root under $what → exit 2"
    case "$OUT" in
        *"resolves component by component but not as a whole"*)
            bad "…but only through the realpath -e backstop: classify_root called the loop resolved ($what)"
            printf '%s\n' "$OUT" | sed 's/^/       | /' ;;
        *"symlink chain too deep"*)
            ok "…and classify_root itself blocked it ($what)" ;;
        *)  bad "…for no reason this case knows ($what)"; printf '%s\n' "$OUT" | sed 's/^/       | /' ;;
    esac
done

# ── 48. A link's resolved target, compared byte for byte ──────────
# The scanner's escape test is strings.HasPrefix on the EXACT resolved path.
# `t="$(realpath -e …)"` stripped trailing newlines, so a link to a FILE named
# "<root><newline>" — beside the root, not under it — resolved to exactly the
# root and passed the containment test: "all 2 recorded file(s) will be
# found", exit 0, while the scanner logs "symlink escapes library root" and
# prunes the row. The same on GNU and uutils.
if [ "$NLFS" -eq 0 ]; then
    ok "a target named <root><newline>: SKIPPED (filesystem refused a newline in a name)"
else
    fixture nlescape
    R="$TMP/nlescape/media"; mkdir -p "$R"
    : > "$R/real.mkv"
    if { : > "$R"$'\n'; } 2>/dev/null && ln -s "$R"$'\n' "$R/x.mkv"; then
        echo "$R" > "$FIX/roots"
        printf '%s\n%s\n' "$R/real.mkv" "$R/x.mkv" > "$FIX/recorded"
        run
        expect_rc 1 "a link to a file named <root><newline> is an escape, not the root → exit 1"
        expect_out "$R/x.mkv" "…and its row is the one named"
    else
        bad "a target named <root><newline>: could not build the fixture — the case would go unrun"
    fi
fi

# ── 49. realpath -e past a non-directory: one answer on either build ─
# A link to `a.mkv/.` is where GNU and uutils realpath -e part: GNU fails with
# ENOTDIR, uutils resolves it to a.mkv. So one tree gave exit 1 on GNU and
# exit 0 on uutils. Not a false all-clear — the scanner's EvalSymlinks fails
# with ENOTDIR, which it counts as unreadable and SHIELDS — but an answer that
# depended on the coreutils build. Both call sites now ask the kernel
# (`[ -e ]`) first, and a link the kernel refuses is classified, not skipped.
# Every shape runs under the installed realpath and under a fake that
# resolves it as uutils does, so a GNU runner pins the uutils side too.
#   1. Beside a plain file: the link is not counted as found (exit 1), and
#      the report says unresolved links are among the rows it lists.
#   2. ALONE under its root: the scanner discovers nothing here (it shields
#      the link), so exit 0 would be right — but this check cannot tell that
#      link from one the scanner DOES resolve (case 51), so it refuses:
#      exit 2, an over-report on purpose.
#   3. A root linked to `file.mkv/.`: blocked inside classify_root, which
#      cannot pass a non-directory, on either build.
#   3b. A root linked to an EXECUTABLE file with a trailing slash: the walk
#      used to drop the slash and call it resolved; it is now put to the
#      kernel, which says ENOTDIR, so it reads absent — the scan's
#      EvalSymlinks fails there too and skips the prune: exit 0, exact, on
#      either build.
#   3c. A root `a/b` where `a` is 20 links deep and `b` 25: each component
#      resolves on its own, the whole fails (the kernel's 40 is per lookup),
#      so it gets past classify_root and stops at the root's own `[ -e ]`,
#      with the same reason on either build; without that check realpath -e
#      (which follows 45 links in user space) answers and the run stops at
#      "not a directory" instead.
# The fake resolves a link whose target ends in `/.` or `/` the way uutils
# does, by resolving the target without that suffix.
mkdir -p "$TMP/fakerp-enotdir"
printf '#!/bin/sh\n[ "$1" = -e ] && [ -L "$3" ] && { t="$(readlink -- "$3")"; case "$t" in */.) exec "%s" -e -- "${t%%/.}" ;; */) exec "%s" -e -- "${t%%/}" ;; esac; }\nexec "%s" "$@"\n' \
    "$REALRP" "$REALRP" "$REALRP" > "$TMP/fakerp-enotdir/realpath"
chmod a+rx "$TMP/fakerp-enotdir" "$TMP/fakerp-enotdir/realpath"
fixture enotdir
E="$TMP/enotdir"
R="$E/media"; Z="$E/zero"
mkdir -p "$R" "$Z/data"; : > "$R/a.mkv"; : > "$Z/data/a.bin"; : > "$E/file.mkv"
: > "$E/exec.mkv"; chmod 755 "$E/exec.mkv"
mkdir -p "$E/xD1" "$E/xD2" "$E/xca" "$E/xcb"; : > "$E/xD2/A.mkv"
xbuilt=1
prev="$E/xD1"; i=1; while [ "$i" -le 20 ]; do ln -s "$prev" "$E/xca/c$i" || xbuilt=0; prev="$E/xca/c$i"; i=$((i + 1)); done
ln -s "$prev" "$E/xa" || xbuilt=0
prev="$E/xD2"; i=1; while [ "$i" -le 25 ]; do ln -s "$prev" "$E/xcb/c$i" || xbuilt=0; prev="$E/xcb/c$i"; i=$((i + 1)); done
ln -s "$prev" "$E/xD1/b" || xbuilt=0
[ "$xbuilt" -eq 1 ] || bad "a root past 40 links across components: could not build the fixture — shape 3c would go unrun"
if ! { ln -s "$R/a.mkv/." "$R/link.mkv" \
       && ln -s "$Z/data/a.bin/." "$Z/link.mkv" \
       && ln -s "$E/file.mkv/." "$E/rootlink" \
       && ln -s "$E/exec.mkv/" "$E/rootlink-x"; }; then
    bad "realpath -e past a non-directory: could not build the fixture — every shape would go unrun"
fi
for rpbin in "" "$TMP/fakerp-enotdir"; do
    what="the installed realpath"; [ -n "$rpbin" ] && what="a realpath -e that resolves it, as uutils does"
    echo "$R" > "$FIX/roots"; printf '%s\n%s\n' "$R/a.mkv" "$R/link.mkv" > "$FIX/recorded"
    OUT="$(PATH="${rpbin:+$rpbin:}$TMP/bin:$PATH" FIX="$FIX" AURORA_DB=testdb bash "$SCRIPT" 2>&1)"; RC=$?
    expect_rc 1 "a link to a.mkv/. is not discovered, under $what → exit 1"
    expect_out "$R/link.mkv" "…and its row is the one named ($what)"
    expect_out "could not be resolved here" "…with the note that unresolved links are among them ($what)"
    echo "$Z" > "$FIX/roots"; printf '%s\n%s\n' "$Z/link.mkv" "$Z/other.mkv" > "$FIX/recorded"
    OUT="$(PATH="${rpbin:+$rpbin:}$TMP/bin:$PATH" FIX="$FIX" AURORA_DB=testdb bash "$SCRIPT" 2>&1)"; RC=$?
    expect_rc 2 "…and alone under its root, it is not called empty, under $what → exit 2 (an over-report)"
    expect_out "found no media it could confirm" "…through the unresolved-links refusal ($what)"
    echo "$E/rootlink" > "$FIX/roots"; printf '%s\n' "$E/rootlink/x.mkv" > "$FIX/recorded"
    OUT="$(PATH="${rpbin:+$rpbin:}$TMP/bin:$PATH" FIX="$FIX" AURORA_DB=testdb bash "$SCRIPT" 2>&1)"; RC=$?
    expect_rc 2 "a root linked to file.mkv/., under $what → exit 2"
    expect_out "$E/file.mkv (cannot traverse" "…blocked at the file, inside classify_root ($what)"
    echo "$E/rootlink-x" > "$FIX/roots"; printf '%s\n' "$E/rootlink-x/x.mkv" > "$FIX/recorded"
    OUT="$(PATH="${rpbin:+$rpbin:}$TMP/bin:$PATH" FIX="$FIX" AURORA_DB=testdb bash "$SCRIPT" 2>&1)"; RC=$?
    expect_rc 0 "a root linked to an executable file with a trailing slash reads absent, under $what → exit 0"
    expect_out "does not exist" "…as the scan's own ENOTDIR does ($what)"
    echo "$E/xa/b" > "$FIX/roots"; printf '%s\n' "$E/xa/b/A.mkv" > "$FIX/recorded"
    OUT="$(PATH="${rpbin:+$rpbin:}$TMP/bin:$PATH" FIX="$FIX" AURORA_DB=testdb bash "$SCRIPT" 2>&1)"; RC=$?
    expect_rc 2 "a root whose components' links add up past 40, under $what → exit 2"
    expect_out "resolves component by component but not as a whole" "…stopped at the root's own kernel check ($what)"
done

# ── 50. A realpath -e that answers nothing for the root ───────────
# The escape test is `"$t/" in "$rr"/*`. With rr empty that is "/"*, which
# every target passes, so a link escaping the root read as found: exit 0.
# Only a quietly broken realpath -e produces it, hence the fake: it answers
# nothing, status 0, for a directory (the root) and passes the rest through.
mkdir -p "$TMP/fakerp-emptyroot"
printf '#!/bin/sh\n[ "$1" = -e ] && [ -d "$3" ] && exit 0\nexec "%s" "$@"\n' "$REALRP" > "$TMP/fakerp-emptyroot/realpath"
chmod a+rx "$TMP/fakerp-emptyroot" "$TMP/fakerp-emptyroot/realpath"
fixture emptyrr
R="$TMP/emptyrr"; mkdir -p "$R"; : > "$R/A.mkv"
: > "$TMP/emptyrr-outside.mkv"; ln -s "$TMP/emptyrr-outside.mkv" "$R/E.mkv"
echo "$R" > "$FIX/roots"; printf '%s\n%s\n' "$R/A.mkv" "$R/E.mkv" > "$FIX/recorded"
run
expect_rc 1 "control: a link escaping the root is not discovered → exit 1"
OUT="$(PATH="$TMP/fakerp-emptyroot:$TMP/bin:$PATH" FIX="$FIX" AURORA_DB=testdb bash "$SCRIPT" 2>&1)"; RC=$?
expect_rc 2 "a realpath -e that answers nothing for the root → exit 2, not every link 'inside'"
expect_out "gave no usable answer" "…through the root-answer check"

# ── 51. A link the kernel refuses and the scanner follows ─────────
# The kernel gives up after 40 links; EvalSymlinks follows 255, and GNU and
# uutils realpath -e both follow such a chain too. A link at the end of a
# 41-link chain that lands inside the root is therefore DISCOVERED by the
# scanner, while `[ -e ]` here says it does not resolve. This branch's
# intermediate commit b35afe3 skipped it as "not found"; as the library's
# only media, the walk came back empty and the zero-discovered branch said
# "the scan will prune nothing" — exit 0, on both builds, while the scanner
# discovered one file and pruned gone.mkv. Reproduced against
# collectVideoFiles itself. main had no such hole (its realpath -e followed
# the chain) and gave the exact exit 1; this answers exit 2 — the price,
# against main, of not believing realpath -e over the kernel. The chain lives outside the
# root, and the link's final target is not a video, so the link is the only
# thing the scanner can discover.
# The control is the same with 39 links, which the kernel follows: found,
# and gone.mkv is reported.
for n in 41 39; do
    fixture "chain$n"
    C="$TMP/chain$n"; R="$C/lib"; mkdir -p "$R/data" "$C/links"; : > "$R/data/a.bin"
    prev="$R/data/a.bin"; i=1; built=1
    while [ "$i" -le "$n" ]; do
        ln -s "$prev" "$C/links/c$i" || { built=0; break; }
        prev="$C/links/c$i"; i=$((i + 1))
    done
    ln -s "$prev" "$R/link.mkv" || built=0
    [ "$built" -eq 1 ] || bad "a $n-link chain: could not build the fixture — the case would go unrun"
    echo "$R" > "$FIX/roots"
    printf '%s\n%s\n' "$R/link.mkv" "$R/gone.mkv" > "$FIX/recorded"
    run
    if [ "$n" -eq 41 ]; then
        expect_rc 2 "the only media behind a 41-link chain (kernel refuses, scanner follows) → exit 2, never 'no media found'"
        expect_out "found no media it could confirm" "…through the unresolved-links refusal"
    else
        expect_rc 1 "control: behind a 39-link chain, which the kernel follows, it is found → exit 1"
        expect_out "$R/gone.mkv" "…and the missing row is the one named"
    fi
done
# Two controls on what the refusal must NOT cover, both the over-report
# side. A library whose only video is a DANGLING link — the most ordinary
# state mid-move — is proven absent by classify_root, the scanner reads it
# as not-exist too, and the walk is genuinely empty: exit 0, as before. And
# a link the kernel refuses whose NAME is not a video can never be
# discovered (IsVideoFile comes before EvalSymlinks), so it must not make
# an otherwise empty library refuse.
fixture danglingonly
R="$TMP/danglingonly"; mkdir -p "$R"
ln -s "$TMP/danglingonly-nothing.mkv" "$R/x.mkv" || bad "dangling-only library: could not build the fixture"
echo "$R" > "$FIX/roots"; printf '%s\n%s\n' "$R/x.mkv" "$R/GONE.mkv" > "$FIX/recorded"
run
expect_rc 0 "a library whose only video is a dangling link is empty, not unresolved → exit 0"
expect_out "no media found" "…through the zero-discovered branch"
fixture nonvideochain
R="$TMP/nonvideochain"; mkdir -p "$R"
ln -s "$TMP/chain41/links/c41" "$R/poster.jpg" || bad "non-video chained link: could not build the fixture"
echo "$R" > "$FIX/roots"; printf '%s\n' "$R/GONE.mkv" > "$FIX/recorded"
run
expect_rc 0 "a non-video link behind a 41-link chain does not make an empty library refuse → exit 0"
# The record of unresolved links is written from inside the find pipeline,
# so a failed write there must be the recording guard's `exit 9`, as it is
# for the disk list: lost silently, the record reads as empty and the walk
# as "no media found". The same XFSZ trick as cases 40 and 44, with the
# chained link as the only entry, so the record is the only write.
fixture unsurewrite
R="$TMP/unsurewrite"; mkdir -p "$R"
ln -s "$TMP/chain41/links/c41" "$R/link.mkv" || bad "unresolved-record write: could not build the fixture"
echo "$R" > "$FIX/roots"; printf '%s\n%s\n' "$R/link.mkv" "$R/gone.mkv" > "$FIX/recorded"
OUT="$(PATH="$TMP/bin:$PATH" FIX="$FIX" AURORA_DB=testdb \
       bash -c 'trap "" XFSZ; ulimit -f 0 2>/dev/null; exec bash "$1"' _ "$SCRIPT" 2>&1)"
RC=$?
expect_rc 2 "a failed write of the unresolved-link record → exit 2, not 'no media found'"
expect_out "could not record what find discovered" "…through the recording guard"
# Per library, like every other latch (cases 30 and 35). Library 1 has an
# unresolved link beside a file it finds; library 2 is genuinely empty. A
# record that leaked from 1 into 2 would make 2 refuse instead of saying it
# found nothing.
fixture unsurereset
printf '1\n2\n' > "$FIX/lib_ids"
L1="$TMP/unsurereset1"; L2="$TMP/unsurereset2"; mkdir -p "$L1" "$L2"
: > "$L1/a.mkv"
ln -s "$TMP/chain41/links/c41" "$L1/link.mkv" || bad "unresolved-record reset: could not build the fixture"
echo "$L1" > "$FIX/roots.1"; printf '%s\n' "$L1/a.mkv" > "$FIX/recorded.1"
echo "$L2" > "$FIX/roots.2"; printf '%s\n' "$L2/X.mkv" > "$FIX/recorded.2"
run
expect_rc 0 "an unresolved link in library 1 does not make an empty library 2 refuse → exit 0"
case "$OUT" in
    *"library 2"*"no media found"*) ok "…and library 2 says it found no media" ;;
    *) bad "library 2 did not report itself empty — the unresolved-link record leaked across libraries"; printf '%s\n' "$OUT" | sed 's/^/       | /' ;;
esac

# ── 52. A link through a directory this user cannot enter ─────────
# The other thing the kernel refuses and the SERVICE user may not: a link
# whose path runs through a directory the checking user cannot search, and
# back inside the root. As the operator `[ -e ]` fails with EACCES; as
# Aurora the scanner resolves it and discovers it. Skipped, it was the
# zero-discovered all-clear again (on main too, through realpath -e). The
# script's comment called skipping "an error other than not-exist" the safe
# side; that holds for ENOTDIR, which the scanner cannot resolve either, and
# not for EACCES, which only this user hits.
if [ "$(id -u)" -eq 0 ] && [ "${#DROP[@]}" -eq 0 ]; then
    bad "link through an unenterable directory: running as root and setpriv is unavailable — cannot test"
else
    fixture throughwall
    T52="$TMP/throughwall"; R="$T52/lib"; mkdir -p "$R/data" "$T52/w"; : > "$R/data/a.bin"
    if ln -s "$R/data/a.bin" "$T52/w/hop" && ln -s "$T52/w/hop" "$R/link.mkv"; then
        echo "$R" > "$FIX/roots"
        printf '%s\n%s\n' "$R/link.mkv" "$R/GONE.mkv" > "$FIX/recorded"
        chmod 000 "$T52/w"
        assert_denied "$T52/w" "link through an unenterable directory"
        [ "$(id -u)" -eq 0 ] && { chmod -R a+rX "$TMP/bin" "$FIX" 2>/dev/null; chmod a+rx "$TMP" "$T52" "$R" "$R/data"; }
        OUT="$(PATH="$TMP/bin:$PATH" "${DROP[@]}" env PATH="$TMP/bin:$PATH" \
               FIX="$FIX" AURORA_DB=testdb HOME=/tmp bash "$SCRIPT" 2>&1)"
        RC=$?
        chmod 755 "$T52/w"
        expect_rc 2 "the only media behind a directory this user cannot enter → exit 2, never 'no media found'"
        expect_out "found no media it could confirm" "…through the unresolved-links refusal"
        # Control: the same tree, enterable — the link is found, GONE.mkv named.
        run
        expect_rc 1 "…and once the directory can be entered, it is found → exit 1"
    else
        bad "link through an unenterable directory: could not build the fixture — the case would go unrun"
    fi
fi

# ── 53. A realpath -e that fails quietly on a link ────────────────
# The kernel says the link resolves, then realpath -e fails — or exits 0 and
# prints nothing. That is the tool failing, not a fact about the link, and
# skipping the link as "not found" turned an all-symlink library (the usual
# *arr layout, every video a link) into an empty walk: exit 0 while the
# scanner pruned GONE.mkv. Each fake misbehaves for links only (the root is a
# directory and passes through), so it is the link's call that is tested.
mkdir -p "$TMP/fakerp-linkfail" "$TMP/fakerp-linksilent"
printf '#!/bin/sh\n[ "$1" = -e ] && [ -L "$3" ] && exit 1\nexec "%s" "$@"\n' "$REALRP" > "$TMP/fakerp-linkfail/realpath"
printf '#!/bin/sh\n[ "$1" = -e ] && [ -L "$3" ] && exit 0\nexec "%s" "$@"\n' "$REALRP" > "$TMP/fakerp-linksilent/realpath"
chmod a+rx "$TMP/fakerp-linkfail" "$TMP/fakerp-linkfail/realpath" "$TMP/fakerp-linksilent" "$TMP/fakerp-linksilent/realpath"
fixture arrlinks
R="$TMP/arrlinks"; mkdir -p "$R/real"; : > "$R/real/a.data"
ln -s "$R/real/a.data" "$R/A.mkv" || bad "all-symlink library: could not build the fixture"
echo "$R" > "$FIX/roots"; printf '%s\n%s\n' "$R/A.mkv" "$R/GONE.mkv" > "$FIX/recorded"
run
expect_rc 1 "control: an all-symlink library under the installed realpath → exit 1"
for shape in linkfail linksilent; do
    OUT="$(PATH="$TMP/fakerp-$shape:$TMP/bin:$PATH" FIX="$FIX" AURORA_DB=testdb bash "$SCRIPT" 2>&1)"; RC=$?
    expect_rc 2 "an all-symlink library under a realpath -e that $( [ "$shape" = linkfail ] && echo fails || echo 'answers nothing' ) on links → exit 2, not 'no media found'"
    expect_out "found no media it could confirm" "…through the unresolved-links refusal ($shape)"
done
# …but only for VIDEO names: a non-video link the scanner can never discover
# is not "unresolved", whatever realpath says about it.
fixture arrnonvideo
R="$TMP/arrnonvideo"; mkdir -p "$R/real"; : > "$R/real/a.data"
ln -s "$R/real/a.data" "$R/poster.jpg" || bad "non-video link under a failing realpath: could not build the fixture"
echo "$R" > "$FIX/roots"; printf '%s\n' "$R/GONE.mkv" > "$FIX/recorded"
for shape in linkfail linksilent; do
    OUT="$(PATH="$TMP/fakerp-$shape:$TMP/bin:$PATH" FIX="$FIX" AURORA_DB=testdb bash "$SCRIPT" 2>&1)"; RC=$?
    expect_rc 0 "a non-video link under the $shape realpath does not make an empty library refuse → exit 0"
done

# ── 54. A link target longer than PATH_MAX as written ─────────────
# The walk follows a link's target as written, and a relative target joined
# to the link's directory can be longer than PATH_MAX while the real path is
# short: here the 41st link of a chain points at `./` x 2040 + `c40`. The
# kernel's lstat of that string fails with ENAMETOOLONG under a parent this
# user can search, which read as `absent`; Go's EvalSymlinks has no such
# limit (it walks component by component), follows the chain, and discovers
# the link. At this branch's 3a7e30d, which began walking targets as
# written, that gave "no media found", exit 0, over a prune, and the
# root-side twin read as "missing root", exit 0, where the scanner shields
# that root and prunes the other one. main had neither hole — its realpath
# -m collapsed the `./` — and gave exit 1 (the link) and exit 2 (the root).
# Now: exit 2 both, which against main costs precision on the link side.
# Both checked against collectVideoFiles.
# Unprivileged, so it also pins the not-ENOENT-means-blocked rule (case 33f)
# end to end on a runner that cannot mount FUSE.
mklong() {  # mklong <dir> <final target> — prints the 41st link
    local d="$1" prev="$2" i dots=""
    mkdir -p "$d" || return 1
    for i in $(seq 1 40); do ln -s "$prev" "$d/c$i" || return 1; prev="$d/c$i"; done
    for i in $(seq 1 2040); do dots="$dots./"; done
    ln -s "${dots}c40" "$d/c41" || return 1
    printf '%s' "$d/c41"
}
fixture longlink
LG="$TMP/longlink"; mkdir -p "$LG/lib/data" "$LG/dir/sub" "$LG/other"
: > "$LG/lib/data/a.bin"; : > "$LG/dir/sub/A.mkv"; : > "$LG/other/B.mkv"
if CF="$(mklong "$LG/chainF" "$LG/lib/data/a.bin")" && CD="$(mklong "$LG/chainD" "$LG/dir")" \
   && ln -s "$CF" "$LG/lib/link.mkv"; then
    echo "$LG/lib" > "$FIX/roots"
    printf '%s\n%s\n' "$LG/lib/link.mkv" "$LG/lib/gone.mkv" > "$FIX/recorded"
    run
    expect_rc 2 "the only media behind a link target longer than PATH_MAX as written → exit 2, never 'no media found'"
    expect_out "found no media it could confirm" "…through the unresolved-links refusal"
    # ── 55. …and the same chain inside a ROOT ─────────────────────
    printf '%s\n%s\n' "$CD/sub" "$LG/other" > "$FIX/roots"
    printf '%s\n%s\n' "$LG/other/B.mkv" "$LG/other/GONE.mkv" > "$FIX/recorded"
    run
    expect_rc 2 "a root reached through a target longer than PATH_MAX → exit 2, not 'missing root'"
    expect_out "File name too long" "…blocked in the kernel's words"
    case "$OUT" in
        *"missing root"*) bad "…but it was still labelled a missing root"; printf '%s\n' "$OUT" | sed 's/^/       | /' ;;
        *) ok "…and it is not labelled a missing root" ;;
    esac
else
    bad "a link target longer than PATH_MAX: could not build the fixture — cases 54 and 55 would go unrun"
fi

# ── 56. is_video does not depend on grep ──────────────────────────
# is_video used grep on a here-string: a grep that failed (status 2) read as
# "not a video" and dropped the record, and a here-string in a full TMPDIR
# never reached grep at all (case 57). It is now bash's own match. So a grep
# that FAILS its -qEi form must change nothing here: the link is still a
# video, still unresolved, and the library still refuses (exit 2, through
# the unresolved-links refusal — not "could not record", which a grep-based
# is_video would give, nor exit 0, which the old one did). The startup probe
# uses `-Ei`, so the run gets as far as the walk.
fixture grepfail
R="$TMP/grepfail"; mkdir -p "$R"
ln -s "$TMP/chain41/links/c41" "$R/link.mkv" || bad "is_video without grep: could not build the fixture"
echo "$R" > "$FIX/roots"; printf '%s\n%s\n' "$R/link.mkv" "$R/gone.mkv" > "$FIX/recorded"
guard_case '#!/bin/sh
[ "$1" = -qEi ] && exit 2
exec /usr/bin/grep "$@"' \
  "found no media it could confirm" "a grep that fails its -qEi form changes nothing: is_video is bash's own match" grep
# And it folds case, as grep -i did and as the scanner's IsVideoFile does
# (it lowercases the extension): `LINK.MKV` is a video. Read as "not a
# video", the library's only media was skipped and the run said "no media
# found", exit 0, while the scanner, which follows 41 links, discovered it
# and pruned gone.mkv.
fixture upperlink
R="$TMP/upperlink"; mkdir -p "$R"
ln -s "$TMP/chain41/links/c41" "$R/LINK.MKV" || bad "is_video folds case: could not build the fixture"
echo "$R" > "$FIX/roots"; printf '%s\n%s\n' "$R/LINK.MKV" "$R/gone.mkv" > "$FIX/recorded"
run
expect_rc 2 "the only media an unresolved link named LINK.MKV → exit 2: an upper-case extension is still a video"
expect_out "found no media it could confirm" "…through the unresolved-links refusal"

# ── 57. The write-failure cases again, under BASH_COMPAT=50 ───────
# Bash before 5.1 — Ubuntu 20.04's 5.0, RHEL 8's 4.4 — and any bash under
# BASH_COMPAT=50 writes every here-string to a file in TMPDIR (5.1 and
# later, one larger than the 64 KiB pipe buffer). Where TMPDIR
# takes the create but not the write (a full tmpfs), the redirection failed
# and the loop it fed never ran: the library loop examined nothing and the
# summary said "nothing would be pruned", exit 0 (main too); the roots loop
# walked nothing and said "no media found"; is_video's grep answered "not a
# video". The script now has no here-string. The XFSZ trick of cases 40 and
# 44 makes every write fail, a here-string's file included, so under
# BASH_COMPAT=50 it reproduces the full TMPDIR on any bash: each fixture
# that writes must stop at the recording guard, never at an all-clear, and
# the one that writes nothing (a missing root) must still be reported.
compat50() {  # run the script with every write failing, under BASH_COMPAT=50
    OUT="$(PATH="$TMP/bin:$PATH" FIX="$FIX" AURORA_DB=testdb BASH_COMPAT=50 \
           bash -c 'trap "" XFSZ; ulimit -f 0 2>/dev/null; exec bash "$1"' _ "$SCRIPT" 2>&1)"
    RC=$?
}
# Is the mechanism real on this bash? If BASH_COMPAT=50 still fed a
# here-string through a pipe, these cases would pass without showing the
# hazard, so say which it is.
hs="$(BASH_COMPAT=50 bash -c 'trap "" XFSZ; ulimit -f 0 2>/dev/null; while read -r x; do echo ran; done <<< probe' 2>/dev/null)"
if [ "$hs" = ran ]; then
    ok "BASH_COMPAT=50: NOTE — this bash ($BASH_VERSION) still feeds a here-string through a pipe, so the cases below cannot show the old failure, only that none is left"
else
    ok "BASH_COMPAT=50: a here-string fails under a failing write on this bash ($BASH_VERSION), as on bash 5.0 in a full TMPDIR"
fi
fixture compat_plain
R="$TMP/compat_plain"; mkdir -p "$R"; : > "$R/A.mkv"
echo "$R" > "$FIX/roots"; printf '%s\n%s\n' "$R/A.mkv" "$R/DELETED.mkv" > "$FIX/recorded"
compat50
expect_rc 2 "BASH_COMPAT=50, writes failing: a library with a missing row → exit 2, never 'nothing would be pruned'"
expect_out "could not record what find discovered" "…through the recording guard"
fixture compat_unsure
R="$TMP/compat_unsure"; mkdir -p "$R"
ln -s "$TMP/chain41/links/c41" "$R/link.mkv" || bad "BASH_COMPAT=50 unresolved link: could not build the fixture"
echo "$R" > "$FIX/roots"; printf '%s\n%s\n' "$R/link.mkv" "$R/gone.mkv" > "$FIX/recorded"
compat50
expect_rc 2 "BASH_COMPAT=50, writes failing: the only media an unresolved link → exit 2, not 'not a video'"
expect_out "could not record what find discovered" "…through the recording guard"
if [ "$NLFS" -eq 1 ]; then
    fixture compat_badname
    R="$TMP/compat_badname"; mkdir -p "$R"
    : > "$R/$(printf 'weird\nname.mkv')"
    echo "$R" > "$FIX/roots"; printf '%s\n' "$R/DELETED.mkv" > "$FIX/recorded"
    compat50
    expect_rc 2 "BASH_COMPAT=50, writes failing: a newline-named video → exit 2"
    expect_out "could not record what find discovered" "…through the recording guard"
fi
# A missing root writes nothing, so it reaches its report, whose loop over
# the roots was the third here-string: the skip is still exit 0 (case 8),
# and the report must still name the root it skips.
fixture compat_missing
echo "$TMP/compat_missing-absent" > "$FIX/roots"
printf '%s\n' "$TMP/compat_missing-absent/A.mkv" > "$FIX/recorded"
compat50
expect_rc 0 "BASH_COMPAT=50, writes failing: a missing root → exit 0, as in case 8 (the scan skips its prune)"
expect_out "missing root: $TMP/compat_missing-absent" "…and its report still names the root"

# ── 58. A link to an executable file with a trailing slash ────────
# `x.mkv/` is ENOTDIR to the kernel and to the scanner's EvalSymlinks, which
# shields such a link. The walk used to drop the slash and answer
# `resolved`, so the link was recorded as unresolved and, as the library's
# only media, made it exit 2; it now reads absent, as `x.mkv/.` and
# `x.mkv//` did, and the empty library says so: exit 0, exact.
fixture execslash
R="$TMP/execslash"; mkdir -p "$R/data"; : > "$R/data/x.bin"; chmod 755 "$R/data/x.bin"
ln -s "$R/data/x.bin/" "$R/link.mkv" || bad "link to an executable file with a trailing slash: could not build the fixture"
echo "$R" > "$FIX/roots"; printf '%s\n%s\n' "$R/link.mkv" "$R/GONE.mkv" > "$FIX/recorded"
run
expect_rc 0 "the only media a link to an executable x.mkv/ → exit 0, as the scanner (which shields it) prunes nothing"
expect_out "no media found" "…through the zero-discovered branch"

# ── 59. Every root is read, or the library says so ────────────────
# The roots loop reads a process substitution, and a command in the loop
# that reads its stdin swallows the roots after the current one. Here a
# realpath that drains stdin (and then answers correctly) leaves the walk
# with the first, empty root only: without the count, "no media found",
# exit 0, while the scanner walks the second root and prunes GONE.mkv.
# (The same guard catches a process substitution that fails outright,
# as it does without /proc; measured, not cased.) Run with stdin from
# /dev/null, so outside the loop the fake drains nothing.
fixture tworoots
R1="$TMP/tworoots/r1"; R2="$TMP/tworoots/r2"; mkdir -p "$R1" "$R2"; : > "$R2/A.mkv"
printf '%s\n%s\n' "$R1" "$R2" > "$FIX/roots"
printf '%s\n%s\n' "$R2/A.mkv" "$R2/GONE.mkv" > "$FIX/recorded"
mkdir -p "$TMP/fakerp-drain"
printf '#!/bin/sh\ncat > /dev/null\nexec "%s" "$@"\n' "$REALRP" > "$TMP/fakerp-drain/realpath"
chmod a+rx "$TMP/fakerp-drain" "$TMP/fakerp-drain/realpath"
OUT="$(PATH="$TMP/fakerp-drain:$TMP/bin:$PATH" FIX="$FIX" AURORA_DB=testdb bash "$SCRIPT" 2>&1 < /dev/null)"; RC=$?
expect_rc 2 "a realpath that drains the roots loop's stdin → exit 2, never 'no media found'"
expect_out "read 1 of its 2 root(s)" "…through the roots count"

# ── 60. The library ids: blank, not numeric, or a pattern ─────────
# The ids are split on whitespace by an unquoted expansion. A list of
# nothing but whitespace passed the emptiness test and split into no ids,
# so the loop ran zero times; the final count's `-eq 0` arm was all that
# stopped "nothing would be pruned". A non-numeric id goes into SQL (the
# stub answers any query, so only the check stops it). And the split runs
# with globbing off: a `*` in a directory holding a file named 7 would
# otherwise have become library 7, an id nobody asked for.
fixture blankids
printf ' \n' > "$FIX/lib_ids"
run
expect_rc 2 "a library list of only whitespace → exit 2, never 'nothing would be pruned'"
expect_out "holds no ids, only whitespace" "…refused right after the split"
fixture badid
printf '2a\n' > "$FIX/lib_ids"
run
expect_rc 2 "a library id that is not a number → exit 2"
expect_out "library id '2a' is not a number" "…refused before any query names it"
fixture globid
printf '*\n' > "$FIX/lib_ids"
mkdir -p "$TMP/globcwd"; : > "$TMP/globcwd/7"
OUT="$(cd "$TMP/globcwd" && PATH="$TMP/bin:$PATH" AURORA_DB=testdb bash "$SCRIPT" 2>&1)"; RC=$?
expect_rc 2 "a library id of '*' beside a file named 7 → exit 2"
expect_out "library id '*' is not a number" "…refused as written, not expanded to library 7"

echo
echo "passed: $PASS   failed: $FAIL"
[ "$FAIL" -eq 0 ]
