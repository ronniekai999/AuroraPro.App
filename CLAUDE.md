# Aurora Media Server — project memory

Self-hosted media server in Go (bare-metal Linux: systemd + native
PostgreSQL), with a React/Vite SPA frontend. See `README.md` for the full
install/operate story.

## Build & test

```bash
go build ./...     # must be green
go test ./...      # must be green
```

The dev pipeline (research → implement+tests → adversarial review → merge gate)
is documented in `docs/dev-workflow.md`. Branch off `main`; never commit to
`main` directly.

## Testing against the live server

You can deploy a change and verify it against the **running instance**
(`https://aurorapro.app`) end-to-end over HTTPS — no SSH needed:

```bash
# After the change is on `main`:
bash scripts/server-test-loop.sh --trigger-update
```

This logs in, triggers the in-app auto-updater, waits for the rebuild, then runs
the API smoke test. Full runbook + the manual curl equivalents are in
**`docs/server-testing.md`**.

Key facts:

- **Credentials are environment secrets, never committed.** The loop reads
  `AURORA_TEST_USER` / `AURORA_TEST_PASS` (and optional `AURORA_BASE`) from the
  environment. Configure them in the Claude Code web environment's secrets.
- **The remote update trigger is admin-only** and the server builds
  **`origin/main`** (`AURORA_UPDATE_BRANCH`, default `main`). A change only
  deploys once it's on `main` — trigger *after* merging.
- Without an admin account, deploy by merging to `main` and letting the box's
  5-minute `aurora-update.timer` pick it up, then run the smoke test.

Relevant code/scripts: `scripts/server-test-loop.sh`,
`scripts/aurora_smoke_test.sh`, `scripts/aurora-update.sh`,
`internal/api/system_handlers.go` (update trigger/status endpoints).
