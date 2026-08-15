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

# Hermetic by construction. The suite makes commits, and it used to rely on
# an ambient global git identity — which GitHub-hosted runners do not set, so
# the CI job added last round would have been red on every PR, including the
# one adding it. Pinning the identity here (and ignoring global/system config)
# also keeps a contributor's commit.gpgsign from hanging the run.
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_SYSTEM=/dev/null
export GIT_AUTHOR_NAME=review-gate-test GIT_AUTHOR_EMAIL=test@example.invalid
export GIT_COMMITTER_NAME=review-gate-test GIT_COMMITTER_EMAIL=test@example.invalid

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
# Each case branches fresh off the pushed base, so the range under test is
# exactly ONE commit. The hook checks the resolved reviewed commit, whose
# record covers base...HEAD — so on an accumulating branch a case could pass
# or fail because of an earlier case's commit rather than its own.
newcase() {
  caseno=$((caseno+1))
  rm -f "$WORK/.claude/review-records/"*.json 2>/dev/null || true
  git -C "$WORK" checkout -q -B "case$caseno" refs/remotes/origin/main 2>/dev/null
  echo "case $caseno" >> "$WORK/a.go"
  git -C "$WORK" commit -qam "case $caseno"
  BAD_SHA="$(git -C "$WORK" rev-parse HEAD)"
  DEST="v$caseno"
}
push_case() { ( cd "$WORK" && git push -q origin "HEAD:refs/heads/$DEST" ) >/dev/null 2>&1; }
must_block() { push_case; if landed; then bad "$1 — UNREVIEWED COMMIT REACHED THE REMOTE"; else ok "$1"; fi; }
must_allow() { push_case; if landed; then ok "$1"; else bad "$1 — a reviewed push was refused"; fi; }
rec() { ( cd "$WORK" && bash "$RECORD" "$@" >/dev/null 2>&1 ); }

# --reviewer matters here: without it the reviewer check blocks first and the
# VERDICT branch is never exercised, so adding `fix-first` to the passing
# verdicts left this case green.
newcase; rec fix-first --reviewer someone "high found";     must_block 'fix-first blocks'
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

section "unusual repo shapes still fail closed"
# A bare repo has no work tree, so `git rev-parse --show-toplevel` exits 128.
# The first version of the hook had `|| exit 0` there, which made pushing from
# a bare clone its single most reliable bypass — and nothing pinned the fix.
newcase
BARE="$TMP/bare$caseno.git"
git clone -q --bare "$WORK" "$BARE" 2>/dev/null
git -C "$BARE" config core.hooksPath "$HOOKS"
( cd "$BARE" && git push -q "$REMOTE" "HEAD:refs/heads/$DEST" ) >/dev/null 2>&1
if landed; then bad 'bare repo push is refused — UNREVIEWED COMMIT REACHED THE REMOTE'
else ok 'bare repo push is refused'; fi

section "bypasses that turn the client-side hook off (advisory layer)"
# These document what the pre-push layer CANNOT hold, so nobody mistakes it
# for enforcement. Each one lands the commit; scripts/review-gate-ci.sh is
# what catches them, and it is tested in its own section below.
newcase
( cd "$WORK" && git -c core.hooksPath=/dev/null push -q origin "HEAD:refs/heads/$DEST" ) >/dev/null 2>&1
if landed; then ok 'core.hooksPath override DOES bypass (known, CI catches it)'
else bad 'core.hooksPath override unexpectedly blocked — update the docs'; fi
newcase
CLONE="$TMP/clone$caseno"; git clone -q "$WORK" "$CLONE" 2>/dev/null
( cd "$CLONE" && git push -q "$REMOTE" "HEAD:refs/heads/$DEST" ) >/dev/null 2>&1
if landed; then ok 'a fresh clone DOES bypass (known, CI catches it)'
else bad 'fresh clone unexpectedly blocked — update the docs'; fi

section "the docs exemption cannot smuggle code"
# The range must be exactly this ONE rename commit. With any other unreviewed
# commit beneath it the push blocks regardless of the exemption, and the case
# passes without ever exercising it — it did, until a mutation run showed
# turning rename detection back on changed nothing.
caseno=$((caseno+1)); DEST="v$caseno"
rm -f "$WORK/.claude/review-records/"*.json 2>/dev/null || true
git -C "$WORK" checkout -q -B renamecase refs/remotes/origin/main
mkdir -p "$WORK/docs"
git -C "$WORK" mv a.go docs/archived.md 2>/dev/null
git -C "$WORK" commit -qm "docs: archive notes"
BAD_SHA="$(git -C "$WORK" rev-parse HEAD)"
must_block 'renaming code into docs/*.md is NOT exempt'
# Sanity: a genuinely markdown-only commit off the same base IS exempt, so
# the case above is testing rename detection and not a blanket refusal.
caseno=$((caseno+1)); DEST="v$caseno"
git -C "$WORK" checkout -q -B realdocs refs/remotes/origin/main
echo note > "$WORK/NOTES.md"; git -C "$WORK" add -A
git -C "$WORK" commit -qm "docs: a real note"
BAD_SHA="$(git -C "$WORK" rev-parse HEAD)"
must_allow 'a genuinely markdown-only commit IS exempt'
# The record exemption covers records ONLY. .claude/settings.json wires the
# PreToolUse hook, so exempting the directory would let a branch disable a
# gate layer with no review.
caseno=$((caseno+1)); DEST="v$caseno"
git -C "$WORK" checkout -q -B settingscase refs/remotes/origin/main
mkdir -p "$WORK/.claude"; echo '{"hooks":{}}' > "$WORK/.claude/settings.json"
git -C "$WORK" add -A; git -C "$WORK" commit -qm "chore: settings"
BAD_SHA="$(git -C "$WORK" rev-parse HEAD)"
must_block 'pre-push: .claude/settings.json is NOT exempt'
# The same file, but ON TOP of a reviewed commit — so the record-walk has a
# predecessor to resolve back to. Without this shape, widening the walk's
# record-exemption to all of .claude/ leaves the suite green while an
# unreviewed edit to the file wiring the PreToolUse hook reaches the remote.
caseno=$((caseno+1)); DEST="v$caseno"
git -C "$WORK" checkout -q -B walkcase refs/remotes/origin/main
echo "reviewed work" >> "$WORK/a.go"
git -C "$WORK" commit -qam "reviewed code"
rec clean --reviewer someone "covers the code commit"
git -C "$WORK" add .claude/review-records >/dev/null 2>&1
git -C "$WORK" commit -qm "chore: record review"
mkdir -p "$WORK/.claude"; echo '{"hooks":{"PreToolUse":[]}}' > "$WORK/.claude/settings.json"
git -C "$WORK" add -A; git -C "$WORK" commit -qm "chore: settings on top of a reviewed state"
BAD_SHA="$(git -C "$WORK" rev-parse HEAD)"
must_block 'pre-push: settings.json above a reviewed commit is NOT walked past'

section "a rewritten remote-tracking ref cannot fake an empty diff"
newcase
git -C "$WORK" update-ref refs/remotes/origin/main "$BAD_SHA"
must_block 'self-set merge-base does not exempt'
git -C "$WORK" update-ref refs/remotes/origin/main "$(git -C "$REMOTE" rev-parse main 2>/dev/null || echo "$BAD_SHA")" 2>/dev/null || true

section "review-gate-ci.sh (the binding check)"
CI="$ROOT/scripts/review-gate-ci.sh"
CIR="$TMP/cirepo"; git init -q -b main "$CIR"
git -C "$CIR" config user.email t@t; git -C "$CIR" config user.name t
echo base > "$CIR/a.go"; git -C "$CIR" add -A; git -C "$CIR" commit -qm base
git -C "$CIR" branch -f mainbase
echo change >> "$CIR/a.go"; git -C "$CIR" commit -qam "unreviewed code"
if ( cd "$CIR" && bash "$CI" mainbase HEAD >/dev/null 2>&1 ); then
  bad 'CI check flags an unreviewed commit'; else ok 'CI check flags an unreviewed commit'; fi
( cd "$CIR" && bash "$RECORD" clean --reviewer someone "reviewed" >/dev/null 2>&1 )
if ( cd "$CIR" && bash "$CI" mainbase HEAD >/dev/null 2>&1 ); then
  ok 'CI check passes a recorded commit'; else bad 'CI check passes a recorded commit'; fi

# THE case that matters, and the one whose absence hid an always-failing
# gate through two rounds: commit the record (which moves HEAD, as the
# documented flow requires) and run the check from a FRESH CLONE, which is
# all a CI checkout ever sees. Testing an untracked record in the worktree
# models a state CI is never in.
git -C "$CIR" add .claude/review-records >/dev/null 2>&1
git -C "$CIR" commit -qm "chore: record review"
CLONE_CI="$TMP/cloneci"; rm -rf "$CLONE_CI"
git clone -q "$CIR" "$CLONE_CI" 2>/dev/null
git -C "$CLONE_CI" branch -f mainbase "$(git -C "$CIR" rev-parse mainbase)" 2>/dev/null
if ( cd "$CLONE_CI" && bash "$CI" mainbase HEAD >/dev/null 2>&1 ); then
  ok 'CI check passes with the record COMMITTED, from a clone'
else
  bad 'CI check passes with the record COMMITTED, from a clone — the documented flow must be satisfiable'
fi
# And a record commit must not launder code sitting above the reviewed state.
echo sneak >> "$CLONE_CI/a.go"; git -C "$CLONE_CI" commit -qam "code after the review"
if ( cd "$CLONE_CI" && bash "$CI" mainbase HEAD >/dev/null 2>&1 ); then
  bad 'CI check catches code added after the record'
else ok 'CI check catches code added after the record'; fi
git -C "$CLONE_CI" reset -q --hard HEAD~1

section "CI check: verdict handling (mutation-sensitive)"
cisha() { git -C "$CLONE_CI" rev-parse HEAD~1; }   # the reviewed (non-record) commit
cirec() { echo "$CLONE_CI/.claude/review-records/$(cisha).json"; }
cichk() { ( cd "$CLONE_CI" && bash "$CI" mainbase HEAD >/dev/null 2>&1 ); }
ciexp() { if cichk; then [ "$2" = 0 ] && ok "$1" || bad "$1 (passed, want blocked)"
          else [ "$2" = 1 ] && ok "$1" || bad "$1 (blocked, want passed)"; fi; }
orig="$(cat "$(cirec)")"
printf '%s' "$orig" | jq '.reviewer = ""' > "$(cirec)"
ciexp 'CI: anonymous verdict blocks' 1
printf '%s' "$orig" | jq '.verdict = "fix-first"' > "$(cirec)"
ciexp 'CI: fix-first blocks' 1
printf '%s' "$orig" | jq '.sha = "deadbeef"' > "$(cirec)"
ciexp 'CI: record for another sha blocks' 1
echo 'not json' > "$(cirec)"
ciexp 'CI: corrupt record blocks' 1
printf '%s' "$orig" | jq '.verdict = "bypass"' > "$(cirec)"
ciexp 'CI: bypass passes (and says so)' 0
printf '%s\n' "$orig" | jq '.verdict = "lows-only"' > "$(cirec)"
ciexp 'CI: lows-only passes' 0
printf '%s\n' "$orig" > "$(cirec)"
git -C "$CLONE_CI" checkout -q -- . 2>/dev/null   # drop any whitespace drift
# The exemption must cover records ONLY — settings.json wires the hooks.
git -C "$CLONE_CI" checkout -q -B settingscase mainbase
mkdir -p "$CLONE_CI/.claude"; echo '{}' > "$CLONE_CI/.claude/settings.json"
git -C "$CLONE_CI" add -A; git -C "$CLONE_CI" commit -qm "chore: settings"
if cichk; then bad 'CI: .claude/settings.json is NOT exempt'; else ok 'CI: .claude/settings.json is NOT exempt'; fi
# The files that GOVERN agent behavior are excluded from the docs exemption.
# pre-push had a case for this; the CI side — the layer the docs call
# strongest — did not, and a reviewer's mutation of that clause went unnoticed.
for gov in CLAUDE.md AGENTS.md docs/dev-workflow.md; do
  git -C "$CLONE_CI" checkout -q -B "gov$(basename "$gov" .md)" mainbase
  mkdir -p "$CLONE_CI/$(dirname "$gov")"
  echo "a rule" >> "$CLONE_CI/$gov"
  git -C "$CLONE_CI" add -A; git -C "$CLONE_CI" commit -qm "docs: edit $gov"
  if cichk; then bad "CI: $gov is NOT docs-exempt"; else ok "CI: $gov is NOT docs-exempt"; fi
done
git -C "$CLONE_CI" checkout -q --force settingscase 2>/dev/null || true
# The client-side bypasses above are exactly what this must still catch.
echo more >> "$CIR/a.go"; git -C "$CIR" commit -qam "pushed around the hook"
if ( cd "$CIR" && bash "$CI" mainbase HEAD >/dev/null 2>&1 ); then
  bad 'CI check catches a commit that bypassed the hook'
else ok 'CI check catches a commit that bypassed the hook'; fi
# Branch off the base so the CUMULATIVE diff is markdown-only — that is what
# the check reads, so a docs commit sitting on top of code is not exempt.
git -C "$CIR" checkout -q -B docsbranch mainbase
echo doc > "$CIR/NOTES.md"; git -C "$CIR" add -A; git -C "$CIR" commit -qm "docs: notes"
if ( cd "$CIR" && bash "$CI" mainbase HEAD >/dev/null 2>&1 ); then
  ok 'CI check exempts a markdown-only branch'; else bad 'CI check exempts a markdown-only branch'; fi
git -C "$CIR" checkout -q -B renamebranch mainbase
git -C "$CIR" mv a.go archived.md
git -C "$CIR" commit -qm "docs: archive"
if ( cd "$CIR" && bash "$CI" mainbase HEAD >/dev/null 2>&1 ); then
  bad 'CI check catches code renamed into a .md'; else ok 'CI check catches code renamed into a .md'; fi
# Docs sitting ON TOP of unreviewed code is not a docs-only change.
git -C "$CIR" checkout -q -B stacked mainbase
echo code >> "$CIR/a.go"; git -C "$CIR" commit -qam "code"
echo d > "$CIR/D.md"; git -C "$CIR" add -A; git -C "$CIR" commit -qm "docs on top"
if ( cd "$CIR" && bash "$CI" mainbase HEAD >/dev/null 2>&1 ); then
  bad 'CI check sees code beneath a docs tip'; else ok 'CI check sees code beneath a docs tip'; fi

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
# Shapes that reached the remote past BOTH client layers, since --no-verify
# skips pre-push by design. These are the same forms that defeated the old
# push parser, so letting them back in here would repeat the round trip.
chk 'no-verify after git -c k=v'  2 "$(p 'git -c user.email=x push --no-verify origin main')"
chk 'no-verify after git -C dir'  2 "$(p 'git -C /tmp push --no-verify origin main')"
chk 'no-verify after bare VAR='   2 "$(p 'GIT_AUTHOR_NAME=x git push --no-verify origin main')"
chk 'no-verify inside parens'     2 "$(p '( git push --no-verify origin main )')"
chk 'ordinary push allowed here'  0 "$(p 'git push origin main')"
chk 'commit -m mentioning push'   0 "$(p 'git commit -m "document git push flow"')"
chk 'echo with && push inside'    0 "$(p 'echo "build && git push"')"
chk 'npm run build'               0 "$(p 'npm run build')"
chk 'grep for the string'         0 "$(p 'grep -rn "git push --no-verify" docs/')"
chk 'mcp push_files blocked'      2 '{"tool_name":"mcp__github__push_files","tool_input":{}}'
chk 'mcp create_or_update blocked' 2 '{"tool_name":"mcp__github__create_or_update_file","tool_input":{}}'
chk 'mcp delete_file blocked'     2 '{"tool_name":"mcp__github__delete_file","tool_input":{}}'
# Merging from the shell reaches the same outcome as the MCP tools, and the
# harness prompt tells agents to prefer the CLI — so the recommended path
# needs the same block. Literals are assembled here so that editing or
# grepping this file is not itself refused.
GHC="gh"; PRC="pr"; MGC="merge"; NVF="--no-""verify"
chk 'cli pr merge blocked'        2 "$(p "$GHC $PRC $MGC 42 --squash")"
chk 'cli api merge blocked'       2 "$(p "$GHC api -X PUT repos/o/r/pulls/42/$MGC")"
chk 'curl api merge blocked'      2 "$(p "curl -X PUT https://api.github.com/repos/o/r/pulls/42/$MGC")"
chk 'cli pr create allowed'       0 "$(p "$GHC $PRC create --fill")"
chk 'cli pr view allowed'         0 "$(p "$GHC $PRC view 42")"
# Mentioning is not running. This hook refused a reviewer's first command of
# the round for containing the literal as test data, and CLAUDE.md documents
# it — so an agent could not grep the limits list it is told to read.
chk 'grepping the literal allowed' 0 "$(p "grep -rn \"$GHC $PRC $MGC\" CLAUDE.md")"
chk 'commit message naming it'     0 "$(p "git commit -m \"gate: block $GHC $PRC $MGC\"")"
chk 'echoing the literal allowed'  0 "$(p "echo \"never run $GHC $PRC $MGC yourself\"")"

# Wrappers. Folding the merge check into the peeler silently DROPPED these —
# the old bare regex caught them and the refactor did not, in the one layer
# covering a self-merge. Neither the suite nor the mutation harness noticed,
# which is why they are pinned individually now.
for w in "timeout 60" "timeout -k 5 60" "nice -n 5" "setsid" "stdbuf -o0" \
         "sudo -u root" "env -u FOO" "flock /tmp/l"; do
  chk "wrapped merge blocked: $w"  2 "$(p "$w $GHC $PRC $MGC 42")"
done
chk 'wrapped no-verify blocked'    2 "$(p "timeout 60 git push $NVF origin main")"
chk 'wrapper alone is allowed'     0 "$(p 'timeout 60 npm run build')"
chk 'nice alone is allowed'        0 "$(p 'nice -n 5 go test ./...')"

# Segment splitting. Every existing compound case was an ALLOW case, so
# replacing the separator split with `cat` left the suite green while
# anything after a `;` or `&&` stopped being seen at all.
chk 'merge after a semicolon'      2 "$(p "echo hi; $GHC $PRC $MGC 42")"
chk 'merge after &&'               2 "$(p "go build ./... && $GHC $PRC $MGC 42")"
chk 'no-verify after a semicolon'  2 "$(p "echo hi; git push $NVF origin main")"
chk 'no-verify after &&'           2 "$(p "make test && git push $NVF origin main")"

# The commit-message skip is load-bearing: without it this exact command is
# refused. The existing "commit message naming it" case uses the merge
# literal, which anchoring alone already allows, so it never exercised this.
chk 'commit msg naming the flag'   0 "$(p "git commit -m \"gate: block git push $NVF\"")"
# Heredoc stripping still matters for a NON-commit heredoc whose body line
# starts with the literal; the commit skip short-circuits the commit form.
chk 'heredoc body starting with it' 0 "$(p "cat > n.txt <<EOF
git push $NVF is banned here
EOF")"
chk 'mcp merge_pull_request blocked' 2 '{"tool_name":"mcp__github__merge_pull_request","tool_input":{}}'
chk 'mcp enable_pr_auto_merge blocked' 2 '{"tool_name":"mcp__github__enable_pr_auto_merge","tool_input":{}}'
chk 'mcp create_pr allowed'       0 '{"tool_name":"mcp__github__create_pull_request","tool_input":{}}'
chk 'mcp get_file allowed'        0 '{"tool_name":"mcp__github__get_file_contents","tool_input":{}}'

section "review-gate-ci.sh argument handling and degenerate branches"
# A branch carrying ONLY record commits resolves to the merge base and stops
# there, rather than walking back into the base branch's history.
git -C "$CIR" checkout -q -B recordsonly mainbase
mkdir -p "$CIR/.claude/review-records"
echo '{"sha":"x","verdict":"clean","reviewer":"y"}' > "$CIR/.claude/review-records/x.json"
git -C "$CIR" add -A; git -C "$CIR" commit -qm "chore: record"
if ( cd "$CIR" && bash "$CI" mainbase HEAD >/dev/null 2>&1 ); then
  ok 'CI: a record-only branch needs no record'; else bad 'CI: a record-only branch needs no record'; fi
# Asserted from a state the check would otherwise PASS, so the rejection is
# attributable to the guard rather than to the branch being unreviewed.
if ( cd "$CIR" && bash "$CI" mainbase HEAD extra >/dev/null 2>&1 ); then
  bad 'CI rejects extra arguments'; else ok 'CI rejects extra arguments'; fi

section "install-git-hooks.sh"
IG="$ROOT/scripts/install-git-hooks.sh"
IR="$TMP/instrepo"; git init -q -b main "$IR"
mkdir -p "$IR/.githooks" "$IR/scripts"
cp "$HOOKS/pre-push" "$IR/.githooks/pre-push"
echo x > "$IR/a.go"; git -C "$IR" add -A; git -C "$IR" commit -qm base
( cd "$IR" && bash "$IG" >/dev/null 2>&1 )
hp="$(git -C "$IR" config --local --get core.hooksPath 2>/dev/null || true)"
case "$hp" in
  /*) ok 'installer sets an ABSOLUTE core.hooksPath' ;;
  *)  bad "installer sets an ABSOLUTE core.hooksPath (got '$hp')" ;;
esac
if [ -x "$IR/.githooks/pre-push" ]; then ok 'installer makes the hook executable'
else bad 'installer makes the hook executable'; fi
# It must not silently stomp a deliberate custom hooks dir.
git -C "$IR" config --local core.hooksPath /some/other/hooks
out="$( cd "$IR" && bash "$IG" 2>&1 )"
hp2="$(git -C "$IR" config --local --get core.hooksPath)"
if [ "$hp2" = "/some/other/hooks" ] && printf '%s' "$out" | grep -q "WARNING"; then
  ok 'installer leaves a custom hooksPath alone and warns'
else bad 'installer leaves a custom hooksPath alone and warns'; fi
git -C "$IR" config --local --unset core.hooksPath 2>/dev/null || true
# A checkout without .githooks/ must say so rather than silently do nothing.
IR2="$TMP/instrepo2"; git init -q -b main "$IR2"
echo x > "$IR2/a.go"; git -C "$IR2" add -A; git -C "$IR2" commit -qm base
out2="$( cd "$IR2" && bash "$IG" 2>&1 )"
if printf '%s' "$out2" | grep -q "WARNING"; then ok 'installer warns when .githooks is absent'
else bad 'installer warns when .githooks is absent'; fi

# The probe must not call a dead gate active. Two earlier versions did — one
# on the failure side, one on the success side — so this pins both.
IR3="$TMP/instrepo3"; git init -q -b main "$IR3"
mkdir -p "$IR3/.githooks"
printf '#!/usr/bin/env bash\nexit 0\n' > "$IR3/.githooks/pre-push"; chmod +x "$IR3/.githooks/pre-push"
echo x > "$IR3/a.go"; git -C "$IR3" add -A; git -C "$IR3" commit -qm base
out3="$( cd "$IR3" && bash "$IG" 2>&1 )"
if printf '%s' "$out3" | grep -q "active"; then
  bad 'installer does NOT call a disabled hook active'
else ok 'installer does NOT call a disabled hook active'; fi
# And it must say active when the hook really does refuse.
cp "$HOOKS/pre-push" "$IR3/.githooks/pre-push"; chmod +x "$IR3/.githooks/pre-push"
out4="$( cd "$IR3" && bash "$IG" 2>&1 )"
if printf '%s' "$out4" | grep -q "active"; then ok 'installer confirms a working hook'
else bad 'installer confirms a working hook'; fi

# An effective hooksPath set at --worktree scope OUTRANKS --local. Reading
# --local reported "gate active" while the effective path was /dev/null, and
# unlike `git -c …` that override persists, so the false all-clear repeated
# every session. This one case also kills "skip the wiring check", since both
# mutants end up probing a path the repo would not actually use.
IR4="$TMP/instrepo4"; git init -q -b main "$IR4"
mkdir -p "$IR4/.githooks"; cp "$HOOKS/pre-push" "$IR4/.githooks/pre-push"; chmod +x "$IR4/.githooks/pre-push"
echo x > "$IR4/a.go"; git -C "$IR4" add -A; git -C "$IR4" commit -qm base
git -C "$IR4" config --local core.hooksPath "$IR4/.githooks"
git -C "$IR4" config --local extensions.worktreeConfig true 2>/dev/null
if git -C "$IR4" config --worktree core.hooksPath /dev/null 2>/dev/null; then
  out7="$( cd "$IR4" && bash "$IG" 2>&1 )"
  if printf '%s' "$out7" | grep -q "active"; then
    bad 'installer sees a --worktree hooksPath override'
  else ok 'installer sees a --worktree hooksPath override'; fi
  git -C "$IR4" config --worktree --unset core.hooksPath 2>/dev/null || true
else
  ok 'installer sees a --worktree hooksPath override (skipped: git too old)'
fi

# A hook that fails for a reason of its OWN is not a refusal. Treating any
# nonzero exit as proof of a working gate is the v1 defect; the check is
# `rc != 0 AND the hook said so`, and dropping either half must be caught.
IR5="$TMP/instrepo5"; git init -q -b main "$IR5"
mkdir -p "$IR5/.githooks"
printf '#!/usr/bin/env bash\nexit 1\n' > "$IR5/.githooks/pre-push"; chmod +x "$IR5/.githooks/pre-push"
echo x > "$IR5/a.go"; git -C "$IR5" add -A; git -C "$IR5" commit -qm base
out8="$( cd "$IR5" && bash "$IG" 2>&1 )"
if printf '%s' "$out8" | grep -q "active"; then
  bad 'installer does NOT read a silent failure as a refusal'
else ok 'installer does NOT read a silent failure as a refusal'; fi

# git skips a non-executable hook SILENTLY, so the installer must repair the
# mode or say the gate is off — never proceed quietly.
IR6="$TMP/instrepo6"; git init -q -b main "$IR6"
mkdir -p "$IR6/.githooks"; cp "$HOOKS/pre-push" "$IR6/.githooks/pre-push"; chmod 644 "$IR6/.githooks/pre-push"
echo x > "$IR6/a.go"; git -C "$IR6" add -A; git -C "$IR6" commit -qm base
out9="$( cd "$IR6" && bash "$IG" 2>&1 )"
# Repairing is the job; warning is only the fallback when chmod cannot work.
# Accepting either let "skip the chmod entirely" pass, since the wiring check
# downstream then warns and the case read as satisfied.
if [ -x "$IR6/.githooks/pre-push" ]; then
  ok 'installer repairs a non-executable hook'
else bad 'installer repairs a non-executable hook'; fi

section "loud failure modes stay loud"
# A bypass that reads like a review, or a gate that goes quiet without jq, is
# how "incomplete" passes unnoticed. Both were mutable with the suite green.
newcase; rec bypass "no reviewer available"
out5="$( cd "$WORK" && git push origin "HEAD:refs/heads/$DEST" 2>&1 )"
if printf '%s' "$out5" | grep -q "BYPASSED"; then ok 'pre-push announces a bypass'
else bad 'pre-push announces a bypass'; fi
( cd "$CLONE_CI" && git checkout -q --force main 2>/dev/null ) || true
git -C "$CIR" checkout -q -B bypasscase mainbase
echo c >> "$CIR/a.go"; git -C "$CIR" commit -qam "code"
( cd "$CIR" && bash "$RECORD" bypass "none available" >/dev/null 2>&1 )
git -C "$CIR" add .claude/review-records >/dev/null 2>&1; git -C "$CIR" commit -qm "chore: record"
out6="$( cd "$CIR" && bash "$CI" mainbase HEAD 2>&1 )"
if printf '%s' "$out6" | grep -q "::warning"; then ok 'CI annotates a bypass'
else bad 'CI annotates a bypass'; fi

section "no jq means fail CLOSED, not fail quiet"
NOJQ="$TMP/nojq"; mkdir -p "$NOJQ"
for b in git bash sh grep sed awk printf cat tr cut head tail mktemp rm mkdir env dirname basename sort uniq wc; do
  [ -x "/usr/bin/$b" ] && ln -sf "/usr/bin/$b" "$NOJQ/$b" 2>/dev/null
  [ -x "/bin/$b" ] && ln -sf "/bin/$b" "$NOJQ/$b" 2>/dev/null
done
newcase
if ( cd "$WORK" && PATH="$NOJQ" git push -q origin "HEAD:refs/heads/$DEST" ) >/dev/null 2>&1; then
  bad 'pre-push fails CLOSED without jq'; else ok 'pre-push fails CLOSED without jq'; fi
if ( cd "$CIR" && PATH="$NOJQ" bash "$CI" mainbase HEAD ) >/dev/null 2>&1; then
  bad 'CI check fails CLOSED without jq'; else ok 'CI check fails CLOSED without jq'; fi

section "record-review argument handling"
r() { ( cd "$WORK" && bash "$RECORD" "$@" >/dev/null 2>&1 ); }
if r clean "no reviewer flag";       then bad 'clean without --reviewer rejected'; else ok 'clean without --reviewer rejected'; fi
if r lows-only "no reviewer flag";   then bad 'lows-only without --reviewer rejected'; else ok 'lows-only without --reviewer rejected'; fi
if r clean --reviewer x "";          then bad 'empty summary rejected'; else ok 'empty summary rejected'; fi
if r clean --reviewer x "   ";       then bad 'whitespace summary rejected'; else ok 'whitespace summary rejected'; fi
if r bogus --reviewer x "s";         then bad 'unknown verdict rejected'; else ok 'unknown verdict rejected'; fi
if r clean --reviewer x --findings n "s"; then bad 'non-numeric --findings rejected'; else ok 'non-numeric --findings rejected'; fi
if r bypass "no reviewer available"; then ok 'bypass needs no reviewer'; else bad 'bypass needs no reviewer'; fi
# CLAUDE.md cites the diff digest as what makes a hollow record auditable.
# Nothing asserted it, and nothing reads it — so at minimum it must be
# present and match the diff it claims to describe.
( cd "$WORK" && bash "$RECORD" clean --reviewer someone "digest check" >/dev/null 2>&1 )
dsha="$(git -C "$WORK" rev-parse HEAD)"
drec="$WORK/.claude/review-records/$dsha.json"
dgot="$(jq -r '.diff_digest // ""' "$drec" 2>/dev/null)"
dmb="$(git -C "$WORK" merge-base refs/remotes/origin/main "$dsha" 2>/dev/null || true)"
dwant="$(git -C "$WORK" diff "$dmb" "$dsha" 2>/dev/null | sha256sum | cut -d' ' -f1)"
if [ -n "$dgot" ] && [ "$dgot" = "$dwant" ]; then ok 'record carries a correct diff digest'
else bad "record carries a correct diff digest (got '${dgot:0:12}', want '${dwant:0:12}')"; fi

printf '\npass=%s fail=%s\n' "$pass" "$fail"
[ "$fail" = 0 ]
