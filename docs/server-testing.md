# Testing against the live Aurora server

This runbook lets a Claude Code session (or any box with HTTPS reach to the
server) **deploy a change and verify it against the running instance** — log
in, trigger the in-app auto-updater, wait for the rebuild, then run the API
smoke test. The whole loop runs over HTTPS; no SSH to the box is required.

> One command does all of it: `bash scripts/server-test-loop.sh --trigger-update`
> (see [Quick start](#quick-start)). The rest of this doc explains what it does
> and how to drive the pieces by hand.

## Credentials live in the environment, never in git

The loop needs a **test account** on the server. Its credentials are read from
environment variables and must be configured as **secrets in the Claude Code
web environment** (Environment → secrets) — never committed to this repo, which
is pushed to GitHub.

| Env var | Required | Meaning |
|---------|----------|---------|
| `AURORA_TEST_USER` | yes | Test-account username. Must be an **admin** to use the remote update trigger. |
| `AURORA_TEST_PASS` | yes | Test-account password. |
| `AURORA_BASE` | no | Server base URL. Defaults to `https://aurorapro.app`. |

The account must be **admin** because `POST /api/admin/system/update` and the
admin-path smoke checks are admin-gated. If you only want read-only smoke tests
(no remote update trigger), a non-admin account works — see
[Update without admin](#update-without-an-admin-account).

### When the secrets are not configured (Phase 11.5)

If `AURORA_TEST_USER` / `AURORA_TEST_PASS` are unset, **none of this runbook can
run** — the loop's first step is a login. That is the state a Claude Code web
session is in by default, so it is worth saying plainly rather than leaving the
loop to fail at step one.

The supported fallback is a **build-hash match**, which verifies that the bytes
now being served are the bytes built from the merged commit:

```bash
# From the merge commit, with a clean tree:
cd static/redesign/app && npm run build
# Grep the BUILT index.html, not `ls assets/` — that directory also holds lazy
# chunks which happen to be named index-*, so `ls` returns four names against the
# live page's two and the comparison reads as a mismatch when it is not.
grep -oE 'assets/index-[A-Za-z0-9_-]+\.(js|css)' ../../v2/index.html | sort -u

# What the live server is actually serving:
curl -s https://aurorapro.app/v2/ | grep -oE 'assets/index-[A-Za-z0-9_-]+\.(js|css)' | sort -u
```

Vite's hashes are content-derived, so identical filenames mean identical bundles.
Phase 10b was verified this way: local `index-CX54ZUNm.js` / `index-DbuA9Ri5.css`
matched the live page exactly.

**Know what this does and does not prove.** It proves the deploy landed and the
right build is live. It proves nothing about behaviour — no login, no API smoke
test, no admin path. It is a deployment check, not a functional one, and it
cannot replace the loop for anything that touches the backend. Configure the
secrets if you need the real thing.

## The deploy → test loop

```
 push/merge to main  ──▶  POST /api/admin/system/update  ──▶  poll status  ──▶  smoke test
 (server tracks                (the "Update Now" button)      until success      read-only
  origin/main)                                                  or failed         API checks
```

### ⚠️ The change must be on `main` first

The server's auto-updater (`scripts/aurora-update.sh`) builds whatever is on
**`origin/main`** (`AURORA_UPDATE_BRANCH`, default `main`). Triggering an update
only does something if `main` has commits the box hasn't built yet. So:

1. Land your change on `main` (merge the PR — or, for a throwaway test, push the
   commit to `main` directly if that's acceptable for your workflow).
2. *Then* trigger the update.

Triggering before the commit is on `main` is a harmless no-op: the updater does a
`git fetch`, sees no new commits on `origin/main`, and exits in <1s with the
previous `state`. (If you'd rather test a branch without merging, point the box's
`AURORA_UPDATE_BRANCH` at that branch instead.)

The updater also **refuses** to deploy when the box's working tree is dirty or
its branch has diverged, and — if `AURORA_UPDATE_REQUIRE_SIGNED=true` — when the
new commit isn't signed by a trusted key. Those surface as `state: failed` with a
message in the status payload.

## Quick start

```bash
# Login + smoke test only (no deploy):
AURORA_TEST_USER=… AURORA_TEST_PASS=… bash scripts/server-test-loop.sh

# Full loop — trigger the remote update, wait for it, then smoke test.
# Run this AFTER your change is on main:
bash scripts/server-test-loop.sh --trigger-update
```

When the credentials are configured as environment secrets you don't pass them
on the command line — they're already in the environment.

## Driving the pieces by hand

### 1. Log in and capture the token

`POST /api/auth/login` returns the JWT as an **httpOnly `aurora_access` cookie**
(deep-debug H10) — there is no token in the JSON body. Capture it with a cookie
jar; the API also accepts that JWT as an `Authorization: Bearer` header.

```bash
BASE="${AURORA_BASE:-https://aurorapro.app}"
curl -sS -c /tmp/jar -X POST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"$AURORA_TEST_USER\",\"password\":\"$AURORA_TEST_PASS\"}"

# Pull the JWT out of the Netscape cookie jar (field 6 = name, 7 = value):
TOKEN="$(awk '$6=="aurora_access"{print $7}' /tmp/jar)"
```

> Note: `scripts/aurora_smoke_test.sh`'s header comment predates H10 and tells
> you to copy `aurora_token` from browser `localStorage`. That's stale — the
> token is now an httpOnly cookie and isn't in `localStorage`. Use the cookie-jar
> method above (or `server-test-loop.sh`, which does it for you).

### 2. Trigger the update (admin token)

```bash
curl -sS -X POST "$BASE/api/admin/system/update" \
  -H "Authorization: Bearer $TOKEN"
# → 202 {"started":true,"message":"Update triggered. Poll …/status for progress."}
```

### 3. Poll until it lands

`GET /api/admin/system/update/status` returns
`{state, at, message, old_sha?, new_sha?}`. States progress
`checking → updating → building → installing → restarting → success` (or
`failed`). The box bounces during `restarting`, so the endpoint may blip
unreachable for a second or two — keep polling.

```bash
while :; do
  s="$(curl -sS -H "Authorization: Bearer $TOKEN" "$BASE/api/admin/system/update/status")"
  echo "$s"
  case "$s" in
    *'"state":"success"'*) echo "done"; break ;;
    *'"state":"failed"'*)  echo "FAILED"; break ;;
  esac
  sleep 3
done
```

A typical clean build+restart is ~30s; a cold build (npm install, etc.) can take
a few minutes.

### 4. Smoke test

```bash
AURORA_TOKEN="$TOKEN" AURORA_BASE="$BASE" bash scripts/aurora_smoke_test.sh
```

The smoke test exercises every read-only endpoint and validates status codes +
key JSON shapes (richer assertions when `jq` is installed). With an admin token
it also covers the admin paths.

## Update without an admin account

If the test account is **not** an admin, you can't call the update endpoint.
Deploy by merging to `main` and letting the box's **5-minute
`aurora-update.timer`** pick the commit up on its next tick, then run the smoke
test (read-only checks pass with a non-admin token; admin checks report + skip).

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| `login failed (HTTP 401)` | Wrong `AURORA_TEST_USER`/`AURORA_TEST_PASS`. |
| update trigger `401/403` | Test account isn't an admin. |
| status stuck at old `at` timestamp | `.path`/timer units not active on the box, or the trigger file isn't writable — see `internal/api/system_handlers.go`. |
| `state: failed`, "no new commits" feel | Your change isn't on `origin/main` yet. |
| `state: failed`, "Local changes" / "diverged" | The box's source clone is dirty or diverged — needs a manual reconcile on the server. |
| Connection refused / DNS failure | This environment's network policy may not allow reaching the server. Check the environment's egress config. |

## Related

- `scripts/server-test-loop.sh` — the one-command driver for this loop.
- `scripts/aurora_smoke_test.sh` — the API smoke test it calls.
- `scripts/aurora-update.sh` — the updater the trigger kicks off (tracks `origin/main`).
- `docs/dev-workflow.md` — the broader research → review → merge pipeline.
