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
cat >> "$TMP/bin/psql" <<'STUB'
STUB
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

echo
echo "passed: $PASS   failed: $FAIL"
[ "$FAIL" -eq 0 ]
