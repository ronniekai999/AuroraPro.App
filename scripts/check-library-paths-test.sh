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
case "$sql" in
    "SELECT 1")                 exit 0 ;;
    *"FROM libraries ORDER BY id"*) cat "$FIX/lib_ids" ;;
    *"count(*) FROM libraries"*)    cat "$FIX/lib_exists" ;;
    *"SELECT name FROM libraries"*) cat "$FIX/lib_name" ;;
    *"SELECT type FROM libraries"*) cat "$FIX/lib_type" ;;
    *"unnest(paths)"*)              cat "$FIX/roots" ;;
    *"WHERE path = ''"*)            cat "$FIX/n_bad" ;;
    *"FROM episode_files"*|*"FROM media_files"*) cat "$FIX/recorded" ;;
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

# fixture <name> — start a fresh fixture directory with sane defaults.
fixture() {
    FIX="$TMP/fix.$1"
    rm -rf "$FIX"; mkdir -p "$FIX"
    echo 1        > "$FIX/lib_ids"
    echo 1        > "$FIX/lib_exists"
    echo Movies   > "$FIX/lib_name"
    echo movie    > "$FIX/lib_type"
    echo 0        > "$FIX/n_bad"
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
    expect_out "cannot inspect the root" "…and says why"
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

cp "$TMP/bin/psql" "$TMP/psql.good"

fixture qfail
cat > "$TMP/bin/psql" <<'STUB'
#!/usr/bin/env bash
sql=""
while [ $# -gt 0 ]; do case "$1" in -c) sql="$2"; shift 2 ;; *) shift ;; esac; done
case "$sql" in "SELECT 1") exit 0 ;; *) exit 1 ;; esac
STUB
chmod +x "$TMP/bin/psql"
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
cp "$TMP/psql.good" "$TMP/bin/psql"
python3 - "$TMP/bin/psql" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
s = s.replace(
    '    *"FROM episode_files"*|*"FROM media_files"*) cat "$FIX/recorded" ;;',
    '    *"FROM episode_files"*|*"FROM media_files"*) exit 1 ;;')
open(p, 'w').write(s)
PY
chmod +x "$TMP/bin/psql"
run
expect_rc 2 "the recorded-paths query failing → exit 2, not 'no files recorded'"
cp "$TMP/psql.good" "$TMP/bin/psql"

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
cp "$TMP/bin/psql" "$TMP/psql.save"
python3 - "$TMP/bin/psql" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
s = s.replace(
    '    *"FROM episode_files"*|*"FROM media_files"*) cat "$FIX/recorded" ;;',
    '    *"FROM episode_files"*) cat "$FIX/recorded" ;;\n'
    '    *"FROM media_files"*) echo "STUB-SAW-MEDIA-FILES-QUERY" ;;')
open(p, 'w').write(s)
PY
chmod +x "$TMP/bin/psql"
run
if [ "$RC" = 0 ]; then ok "a show library sends the episode_files query, not media_files"
else bad "a show library sent the media_files query (exit $RC)"; printf '%s\n' "$OUT" | sed 's/^/       | /'; fi
cp "$TMP/psql.save" "$TMP/bin/psql"

# ── 16. Every query needs its own `|| die` ────────────────────────
# Losing one leaves its variable EMPTY, and empty reads downstream as a benign
# fact rather than a failure: no paths configured, no files recorded, a movie
# library. All three exit 0. The recorded-paths case above pins one of these;
# these pin the two that turn a transient psql failure into an all-clear.
qfail_on() {  # $1 = query fragment to fail, $2 = label
    cp "$TMP/psql.save" "$TMP/bin/psql" 2>/dev/null || true
    python3 - "$TMP/bin/psql" "$1" <<'PY'
import sys
p, frag = sys.argv[1], sys.argv[2]
s = open(p).read()
marker = '    *"%s"*)' % frag
i = s.index(marker)
j = s.index(';;', i) + 2
s = s[:i] + '    *"%s"*) exit 1 ;;' % frag + s[j:]
open(p, 'w').write(s)
PY
    chmod +x "$TMP/bin/psql"
    run
    expect_rc 2 "$2"
}

fixture qfail_roots
R="$TMP/qfail_roots"; mkdir -p "$R"; : > "$R/A.mkv"
echo "$R" > "$FIX/roots"; printf '%s\n' "$R/A.mkv" > "$FIX/recorded"
cp "$TMP/bin/psql" "$TMP/psql.save"
qfail_on 'unnest(paths)' "the roots query failing → exit 2, not 'has no paths'"

fixture qfail_type
R="$TMP/qfail_type"; mkdir -p "$R"; : > "$R/A.mkv"
echo show > "$FIX/lib_type"
echo "$R" > "$FIX/roots"; printf '%s\n' "$R/A.mkv" > "$FIX/recorded"
qfail_on 'SELECT type FROM libraries' "the library-type query failing → exit 2, not a movie-branch guess"
cp "$TMP/psql.save" "$TMP/bin/psql"

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

echo
echo "passed: $PASS   failed: $FAIL"
[ "$FAIL" -eq 0 ]
