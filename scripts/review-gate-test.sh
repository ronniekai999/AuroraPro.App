#!/usr/bin/env bash
# Tests for the adversarial review gate.
#
#   bash scripts/review-gate-test.sh
#
# Part 1 exercises .githooks/pre-push by performing REAL pushes to a real
# (local, temp) bare remote and then asserting what actually landed on it.
# Asserting the remote rather than the hook's exit code is the point: three
# earlier rounds of this suite asserted exit codes and stayed green while
# unreviewed commits reached a remote through shapes the suite did not model.
# Here, a bypass shows up as a commit on the remote no matter how it got
# there — including through shells, wrappers and directory changes the old
# parser could not see.
#
# Part 2 covers the PreToolUse layer, which now only guards --no-verify and
# the content-writing MCP tools.
#
# Everything runs in synthetic repos under a temp dir; nothing touches this
# checkout, and no case depends on its state.

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GATE="$ROOT/scripts/review-gate.sh"
RECORD="$ROOT/scripts/record-review.sh"
HOOKS="$ROOT/.githooks"
[ -f "$HOOKS/pre-push" ] || { echo "cannot find .githooks/pre-push"; exit 1; }

pass=0; fail=0
section() { printf '\n%s\n' "$1"; }
ok()   { printf '  ok   %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  FAIL %s\n' "$1"; fail=$((fail+1)); }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# --- a repo whose pushes are gated, wired to a bare remote --------------
REMOTE="$TMP/remote.git"; git init -q --bare -b main "$REMOTE"
WORK="$TMP/work"; git init -q -b main "$WORK"
git -C "$WORK" config user.email t@t; git -C "$WORK" config user.name t
git -C "$WORK" remote add origin "$REMOTE"
echo base > "$WORK/a.go"; git -C "$WORK" add -A; git -C "$WORK" commit -qm base
git -C "$WORK" push -q origin main
# Hook goes on AFTER the fixture exists: the gate would (correctly) refuse
# to push an unreviewed base commit, leaving the remote empty and every
# later assertion measuring the wrong thing.
git -C "$WORK" config core.hooksPath "$HOOKS"
echo unreviewed >> "$WORK/a.go"; git -C "$WORK" commit -qam "unreviewed code"
BAD_SHA="$(git -C "$WORK" rev-parse HEAD)"

# Capture first, then match. Piping `git log` straight into `grep -q` breaks
# under `set -o pipefail`: grep exits on the first hit, git log dies of
# SIGPIPE, and the pipeline reports failure even though the commit WAS found.
# It only bites once the log is long enough to still be writing, so it read
# as flakiness — a reviewed push reported as "refused" in later cases only.
landed() {
  local log
  log="$(git -C "$REMOTE" log --all --oneline 2>/dev/null || true)"
  printf '%s' "$log" | grep -q "${BAD_SHA:0:7}"
}

# try <name> <command...> — runs the command, then asserts the unreviewed
# commit did NOT reach the remote.
try() {
  local name="$1"; shift
  ( cd "$WORK" && eval "$*" ) >/dev/null 2>&1
  if landed; then
    bad "$name — UNREVIEWED COMMIT REACHED THE REMOTE"
    git -C "$REMOTE" update-ref -d refs/heads/leak 2>/dev/null || true
    git -C "$REMOTE" push -q . ":refs/heads/leak" 2>/dev/null || true
  else
    ok "$name"
  fi
}

section "pre-push blocks the shapes that defeated the parser (nothing may land)"
try 'git push'                       'git push origin main'
try 'git push;'                      'git push origin main;'
try 'chained with &&'                'echo x && git push origin main'
try 'commit && push in one call'     'git commit -q --allow-empty -m more && git push origin main'
try 'bash -c with a separator'       'bash -c "echo building; git push origin main"'
try 'bash -c with &&'                'bash -c "true && git push origin main"'
try 'bash -c commit && push'         'bash -c "git commit -q --allow-empty -m x && git push origin main"'
try 'pushd then push'                'pushd . >/dev/null && git push origin main'
try 'cd then push'                   "cd '$WORK' && git push origin main"
try 'git -C'                         "git -C '$WORK' push origin main"
try 'git -C command substitution'    'git -C $(pwd) push origin main'
try 'GIT_DIR='                       "GIT_DIR='$WORK/.git' GIT_WORK_TREE='$WORK' git push origin main"
try 'sudo -i style opt'              'env -i PATH="$PATH" HOME="$HOME" git push origin main'
try 'timeout -k'                     'timeout -k 5 60 git push origin main'
try 'nice with flag'                 'nice -n 19 git push origin main'
try 'env with quoted spaces'         'GIT_AUTHOR_NAME="Jane Doe" git push origin main'
try 'two pushes in one call'         'git push origin main && git push origin main:refs/heads/other'
try 'explicit refspec'               'git push origin main:refs/heads/sneak'
try 'push --all'                     'git push --all origin'
try 'push --mirror'                  'git push --mirror origin'
try 'git -c option'                  'git -c user.email=x push origin main'

section "verdicts"
# Each case gets its own commit and its own destination branch, so no case
# depends on the remote state another case left behind.
caseno=0
newcase() {
  caseno=$((caseno+1))
  rm -f "$WORK/.claude/review-records/"*.json 2>/dev/null || true
  echo "case $caseno" >> "$WORK/a.go"
  git -C "$WORK" commit -qam "case $caseno"
  BAD_SHA="$(git -C "$WORK" rev-parse HEAD)"
  DEST="v$caseno"
}
push_case() { ( cd "$WORK" && git push -q origin "HEAD:refs/heads/$DEST" ) >/dev/null 2>&1; }
must_block() { push_case; if landed; then bad "$1 — UNREVIEWED COMMIT REACHED THE REMOTE"; else ok "$1"; fi; }
must_allow() { push_case; if landed; then ok "$1"; else bad "$1 — a reviewed push was refused"; fi; }
rec() { ( cd "$WORK" && bash "$RECORD" "$@" >/dev/null 2>&1 ); }

newcase; rec fix-first "high found";                       must_block 'fix-first blocks'
newcase; rec clean --reviewer someone "reviewed";           must_allow 'clean record allows'
newcase; rec lows-only --reviewer someone "only nits";      must_allow 'lows-only allows'
newcase; rec bypass "no reviewer available";                must_allow 'bypass allows'
newcase;                                                    must_block 'no record blocks'

newcase; rec clean --reviewer x "named"
jq '.reviewer = ""' "$WORK/.claude/review-records/$BAD_SHA.json" > "$TMP/r.json"
mv "$TMP/r.json" "$WORK/.claude/review-records/$BAD_SHA.json"
must_block 'anonymous verdict blocks'

newcase; rec clean --reviewer x "named"
jq --arg s deadbeef '.sha=$s' "$WORK/.claude/review-records/$BAD_SHA.json" > "$TMP/r.json"
mv "$TMP/r.json" "$WORK/.claude/review-records/$BAD_SHA.json"
must_block 'record for another sha blocks'

newcase; rec clean --reviewer x "named"
echo 'not json' > "$WORK/.claude/review-records/$BAD_SHA.json"
must_block 'corrupt record blocks'

# A clean record for the PREVIOUS commit must not cover a new one.
newcase; rec clean --reviewer x "named"
echo amended >> "$WORK/a.go"; git -C "$WORK" commit -qam "extra work"
BAD_SHA="$(git -C "$WORK" rev-parse HEAD)"
must_block 'a later commit invalidates the record'
rm -f "$WORK/.claude/review-records/"*.json

section "docs-only exemption"
DR="$TMP/docsremote.git"; git init -q --bare -b main "$DR"
DW="$TMP/docswork"; git init -q -b main "$DW"
git -C "$DW" config user.email t@t; git -C "$DW" config user.name t
git -C "$DW" config core.hooksPath "$HOOKS"; git -C "$DW" remote add origin "$DR"
echo x > "$DW/README.md"; git -C "$DW" add -A; git -C "$DW" commit -qm base
git -C "$DW" push -q origin main
dpush() { ( cd "$DW" && git push -q origin main ) >/dev/null 2>&1; }
echo more >> "$DW/README.md"; git -C "$DW" commit -qam docs
if dpush; then ok 'markdown-only push allowed'; else bad 'markdown-only push allowed'; fi
mkdir -p "$DW/docs"; echo 'server {}' > "$DW/docs/nginx.conf"
git -C "$DW" add -A; git -C "$DW" commit -qm conf
if dpush; then bad 'config under docs/ must NOT be exempt'; else ok 'config under docs/ is NOT exempt'; fi
git -C "$DW" reset -q --hard HEAD~1
echo rule >> "$DW/CLAUDE.md"; git -C "$DW" add -A; git -C "$DW" commit -qm rules
if dpush; then bad 'CLAUDE.md must NOT be exempt'; else ok 'CLAUDE.md is NOT exempt'; fi

section "PreToolUse layer: --no-verify and content-writing MCP tools"
p() { printf '%s' "$1" | jq -Rs '{tool_name:"Bash", tool_input:{command:.}}'; }
chk() { # name want_rc payload
  local out rc
  out="$(printf '%s' "$3" | bash "$GATE" 2>&1)"; rc=$?
  if [ "$rc" = "$2" ]; then ok "$1"; else bad "$1 (exit=$rc want=$2)"; fi
}
chk 'push --no-verify blocked'    2 "$(p 'git push --no-verify origin main')"
# `git push -n` is --dry-run, not --no-verify. Matching a bare -n made this
# hook block its own test run over a `sed -n` that mentioned a push.
chk 'push -n (dry-run) allowed'   0 "$(p 'git push -n origin main')"
chk 'sed -n near the word push'   0 "$(p "bash x.sh | sed -n '/push/p'")"
chk 'tail -n near the word push'  0 "$(p 'git log --oneline | tail -n 5 # find the push')"
# A commit MESSAGE that discusses --no-verify is not a use of it: this check
# blocked the very commit that introduced it.
chk 'heredoc commit body mentioning it' 0 "$(p 'git commit -F - <<EOF
gate: block git push --no-verify
EOF')"
chk 'no-verify in a bash -c'      2 "$(p 'bash -c "git push --no-verify origin main"')"
chk 'ordinary push allowed here'  0 "$(p 'git push origin main')"
chk 'commit -m mentioning push'   0 "$(p 'git commit -m "document git push flow"')"
chk 'echo with && push inside'    0 "$(p 'echo "build && git push"')"
chk 'npm run build'               0 "$(p 'npm run build')"
chk 'grep for the string'         0 "$(p 'grep -rn "git push --no-verify" docs/')"
chk 'mcp push_files blocked'      2 '{"tool_name":"mcp__github__push_files","tool_input":{}}'
chk 'mcp create_or_update blocked' 2 '{"tool_name":"mcp__github__create_or_update_file","tool_input":{}}'
chk 'mcp delete_file blocked'     2 '{"tool_name":"mcp__github__delete_file","tool_input":{}}'
chk 'mcp create_pr allowed'       0 '{"tool_name":"mcp__github__create_pull_request","tool_input":{}}'
chk 'mcp get_file allowed'        0 '{"tool_name":"mcp__github__get_file_contents","tool_input":{}}'

section "record-review argument handling"
r() { ( cd "$WORK" && bash "$RECORD" "$@" >/dev/null 2>&1 ); }
if r clean "no reviewer flag";       then bad 'clean without --reviewer rejected'; else ok 'clean without --reviewer rejected'; fi
if r lows-only "no reviewer flag";   then bad 'lows-only without --reviewer rejected'; else ok 'lows-only without --reviewer rejected'; fi
if r clean --reviewer x "";          then bad 'empty summary rejected'; else ok 'empty summary rejected'; fi
if r clean --reviewer x "   ";       then bad 'whitespace summary rejected'; else ok 'whitespace summary rejected'; fi
if r bogus --reviewer x "s";         then bad 'unknown verdict rejected'; else ok 'unknown verdict rejected'; fi
if r clean --reviewer x --findings n "s"; then bad 'non-numeric --findings rejected'; else ok 'non-numeric --findings rejected'; fi
if r bypass "no reviewer available"; then ok 'bypass needs no reviewer'; else bad 'bypass needs no reviewer'; fi

printf '\npass=%s fail=%s\n' "$pass" "$fail"
[ "$fail" = 0 ]
