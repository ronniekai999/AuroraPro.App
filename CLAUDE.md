# Aurora Media Server — project memory

Self-hosted media server in Go (bare-metal Linux: systemd + native
PostgreSQL), with a React/Vite SPA frontend. See `README.md` for the full
install/operate story.

## Build & test

```bash
go build ./...     # must be green
go test ./...      # must be green
```

Branch off `main`; never commit to `main` directly. The full pipeline is in
`docs/dev-workflow.md`, and the review gate below is a REQUIRED stage of it.

## Adversarial review gate — required before every push

**You must not push, open a PR, or call a code change complete until an
independent agent has adversarially reviewed the final diff.** This is not a
suggestion or a nice-to-have, and your own re-reading of your own diff does
not satisfy it. It is stage 5 of `docs/dev-workflow.md` and the whole of
`AGENTS.md` — read `AGENTS.md` for the reviewer's full brief.

**Dispatching that reviewer is pre-authorized.** If you are operating under a
standing instruction not to spawn subagents unless asked, this repo's gate
overrides it: the review subagent is part of the definition of done here, so
it counts as requested for every code change. Do not skip the gate to honor a
no-subagents default.

Run it like this, in this order:

1. `go build ./...` and `go test ./...` green (plus `npm run audit` in
   `static/redesign/app/` for frontend work) — verify BEFORE reviewing, so the
   reviewer reads a working diff.
2. Dispatch a **separate, fresh-context, read-only** agent over the complete
   diff (`git diff <base>...HEAD`). Give it the acceptance criteria and the
   diff. Do NOT tell it your conclusions or that you think the change is
   correct — priming it defeats the point.
3. Resolve every high/critical finding, then review the FINAL diff again. A
   clean verdict does not cover code written after it.
4. Record the verdict, which is what unblocks the push:

   ```bash
   bash scripts/record-review.sh clean --reviewer <id> --findings <n> "<what it checked, what it found>"
   ```

5. In your handoff, report the review verdict **separately** from build/test
   results. "Tests pass" is not a review outcome.

If no independent reviewer is available, say the gate is **incomplete** — never
present a self-review as equivalent. `record-review.sh bypass "<why>"` records
that honestly and lets the push through; it is the only way past, and it
obliges you to report the gate as incomplete. There is no silent bypass.

**This is enforced mechanically, in two layers.**

1. **`.githooks/pre-push` is the enforcement boundary.** git runs it with the
   refs and shas already resolved, in the repo actually being pushed, so no
   shell shape changes what it sees — `bash -c "…"`, `pushd other && git
   push`, `git -C … push`, `timeout 60 git push`, `git push a && git push b`
   all reach the same check. It refuses the push unless every ref being
   pushed has a record naming a reviewer. Installed via
   `core.hooksPath=.githooks` by `scripts/install-git-hooks.sh`, which the
   SessionStart hook runs for you.
2. **`scripts/review-gate.sh` (PreToolUse) covers what a git hook cannot
   see**: `git push --no-verify`, which skips pre-push hooks by design, and
   the `mcp__github__` tools that write file content over the API without
   touching git at all.

This replaced an earlier design that tried to recognize a push by parsing the
shell command. Four review rounds walked through that parser, each bypass
ordinary rather than adversarial. An allowlist of shell shapes cannot be
finished; the git layer has no such list.

Known limits, so you don't over-trust it:

- **The gate cannot verify a review happened**, only that a record exists and
  names a reviewer. Anyone who can write the record can author one by hand.
  The reviewer field and diff digest make a hollow record auditable, not
  impossible.
- **`--no-verify` genuinely bypasses layer 1**; only the weaker layer 2
  catches it, and only when it can see the command.
- **A fresh clone has no hook until `core.hooksPath` is set** — that is the
  cost of enforcing at the git layer.

`scripts/review-gate-test.sh` (run in CI) pins the behavior by performing real
pushes to a temp remote and asserting what actually landed, rather than
trusting exit codes.

Only `*.md`/`*.txt` diffs are exempt, and `CLAUDE.md`, `AGENTS.md` and
`docs/dev-workflow.md` are excluded from that exemption: the rules an agent
follows are not a place for unreviewed edits.

The hook exists because prose alone did not work: this gate was written down
in `AGENTS.md`, `docs/dev-workflow.md`, and a pointer here, and was still
skipped on PR #487 — only `CLAUDE.md` is auto-loaded, and the pointer read as
a citation rather than an instruction.

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

## AI/LLM stack (providers: local Ollama, Ollama Cloud, Anthropic, OpenAI)

All AI features (semantic search, hero/Discover recommendations, recaps, AI
file matching, listwise rerank) call one client: `internal/llm`. Consumers
use `ChatJSON(With)` / `EmbedBatch` / `Rerank` and never branch on provider.
Code: `internal/llm/{client,provider,anthropic,openai,llmschema,rerank}.go`,
boot resolution in `cmd/aurora/main.go` (`applyLLMOverrides`), admin surface
`GET/PUT /api/admin/llm` + `POST /api/admin/llm/test`, SPA `AdminLLMTab`.

Invariants to preserve when touching this area:

- **Provider routing lives entirely inside `internal/llm`.** `Config.Provider`
  (chat: local | ollama_cloud | anthropic | openai) and `Config.EmbedProvider`
  (local | openai — Anthropic has no embeddings API) select adapters behind
  the existing entry points; the `structured` flag only picks between Ollama
  transports and is ignored for hosted providers.
- **Hosted base URLs are compile-time constants** (env-overridable for
  gateways, NEVER admin-editable) and **keys are per-host**: the Ollama
  bearer, Anthropic key, and OpenAI key each ride only to their own host
  (`setAnthropicAuth`/`setOpenAIAuth`; `sendAuth` gating for Ollama). The
  admin test endpoint may probe with a posted key ONLY because those hosts
  are fixed.
- **No sampling params to hosted providers** (current Claude models and the
  gpt-5 family reject temperature) — the Ollama /v1 path keeps its pinned
  0.1. Schemas pass through `sanitizeStructuredSchema` (allowlist + forced
  `additionalProperties:false`); the `llmjson` tolerant parser stays the
  safety net everywhere.
- **`EmbedSpaceID` format is load-bearing**: bare model name for
  Ollama-family embeds (matches every existing install's
  `llm_embed_model_active` marker — qualifying it would null all vectors on
  upgrade), `"openai/<model>"` otherwise. Space change ⇒ marker reset ⇒
  null + full re-embed via the existing backfill. OpenAI embeds request
  `dimensions=768` to fit `vector(768)` — no migration.
- **`CheckProviderCombo` is the single policy source** (admin save 400s,
  boot warns). Settings keys `llm_anthropic_api_key` / `llm_openai_api_key`
  end in `_api_key` so `isSecretSettingKey` masks them for free; keys are
  plaintext at rest like every other credential (documented trade-off).
- The admin PUT writes provider selectors LAST (partial-save safety); the
  PUT returns `{ok, restart_required}` — the SPA re-fetches settings after
  save (don't `setS(ack)`).
- **GET keeps editable and display fields separate**: `chat_model` /
  `embed_model` carry exactly what is STORED (blank = provider default);
  live-resolved values ride `effective_chat_model`/`effective_embed_model`.
  Never backfill live models into the editable fields — that round-trip
  persisted stale Ollama tags on a provider switch (hosted chat 404s;
  embeds null vectors then fail re-embed). The SPA blanks model fields
  when the provider FAMILY changes and restores loaded values on return.

## Social features (member profiles + follows, PRs #428/#429)

Member-visible profiles (`/user/:name`, bio/socials/recent watches), a
follow graph, a `/members` directory, and the "From People You Follow" home
rail. Code: migrations 049–050, `internal/db/queries_social.go`,
`internal/api/social_handlers.go` (+ tests), SPA `UserProfileView` /
`MembersView` / `lib/socialLinks`.

Invariants to preserve when touching this area:

- **Watch-history sharing is opt-in** (`users.share_watch_history`, default
  FALSE) and re-checked inside every read query — no caches to invalidate.
- History surfaces show the **default sub-profile only** (kids profiles
  never attribute to the account) and only rows with `completed_at`.
- The follow **feed applies the viewing sub-profile's parental ceiling**
  (`allowedRatingsForMax`) like every home rail.
- Member-visible responses never carry email/role/auth fields; avatars pass
  `memberSafeAvatar` (nebula/TMDB only); social handles are stored bare and
  shape-validated per network (links can only point at the four fixed
  domains).
- `/api/members/*` is the member-visible namespace — the admin-gated
  `/api/users` subtree must stay admin-only (and chi can't mix `{id}` /
  `{username}` wildcards at one node anyway).

## Watch-party invites (migration 051)

Member-to-member invites — send now or scheduled — with bell RSVP, a lobby
countdown, and calendar chips. Code: migration 051,
`internal/db/queries_party_invites.go`, `internal/api/party_invite_handlers.go`,
`internal/watchparty/rehydrate.go` (+ tests), SPA `PartyComposerModal` /
`PartyLobbyCard` / `lib/partyInvites` + bell/calendar wiring in `App.tsx` and
`CalendarView`.

Invariants to preserve here:

- **Sending is host-only and post-hoc by code** (composes with both create
  paths). A re-invite is a no-op that must never reset the invitee's RSVP.
- **Delivery goes through `notify.Dispatcher` only**, and only when the
  invite row was actually created — that created-flag is the notification
  dedup layer (invite notifications carry no `request_id`, so the
  notifications table's dedup index does not apply).
- **Parental ceilings are checked at SEND time** against the invitee's
  DEFAULT sub-profile (`rating_restricted` skip; unrated titles excluded
  under any restriction). Kids sub-profiles are structurally unreachable.
  Known limit: the check is point-in-time — party JOIN carries no rating
  gate at all (pre-existing, whole watchparty package) and a media swap
  after sending isn't re-checked. Gating join on the joiner's ceiling is
  the open follow-up; don't advertise stronger enforcement than this.
- **Rosters are member-visible surfaces**: username/display/avatar only,
  avatars through `memberSafeAvatar`; declines stay private to the
  decliner — the roster ENDPOINT filters `declined` rows out (not just the
  lobby UI), while declined invitees keep roster read access.
- **Scheduled-but-unstarted parties are exempt from every reaper** (empty-
  party cleanup, host-disconnect grace, host explicit leave) until the
  scheduled start has passed by the staleness window — a booking must
  survive its host closing the laptop. After an auto-start with an empty
  room, staleness anchors on `StartedAt`, giving showtime joiners ~5 min.
- **Scheduled parties must survive restarts**: the manager rehydrates
  active+scheduled+unstarted rows at boot and re-arms countdown/reminder
  timers (the box auto-deploys, so restarts are routine). Reminder timers
  carry no cancel hooks — they self-validate against the CURRENT
  `ScheduledStartAt` at fire time and dedupe via `reminderSentFor`.
- Calendar: party chips group by the viewer's **local** date; episode air
  dates stay UTC-keyed. Don't unify them.

## Native-client direct play (Tier 1 of the Mac-app work)

Capability keys that let a NATIVE client (libVLC/mpv/ExoPlayer-backed app)
direct-play what browsers cannot: `mkv_container` / `avi_container` /
`ts_container`, the legacy video codecs (`mpeg4`, `msmpeg4v3`,
`mpeg2video`, `vc1`), the native-only audio codecs (`dts`, `truehd`,
`mlp`, `alac`, `mp2`, `pcm_*`), and the `h264_hi10` profile key. Code:
`internal/streaming/streaming.go` (`containerCapKey`,
`directPlayOnlyVideoCodecs`, `isDirectPlayOnlyAudio`,
`hlsDeliverableAudio`), tests in `nativeclient_test.go`, client contract
in `docs/native-client-caps.md`.

Invariants to preserve when touching this area:

- **Nothing is direct-playable by default — a client reaches these paths
  only by NAMING the capability.** The SPA emits exactly
  `mp4_container`/`webm_container` and no native-only codec, so browsers
  are structurally unable to be handed an MKV. That absence IS the safety
  model, and it is enforced mechanically:
  `TestSPAProbeEmitsNoNativeOnlyCapabilities` reads `streaming.ts` and
  fails if a native-only key appears anywhere in it as a string literal
  (it scans ALL literals rather than modelling how the caps array is
  built, so a spread or a ternary can't slip one past it).
  `TestBrowserDecisionGolden` pins the full decision (every field + reason
  code) for browsers across fMP4 on/off and the nil-caps fallback — a
  changed line in that golden file is a changed user experience, so read
  the diff rather than regenerating reflexively.
- **"Direct-play-only" sets never reach a copy path *by decision*:**
  `directPlayOnlyVideoCodecs` forces `remuxVideoOK=false`, and
  `isDirectPlayOnlyAudio` codecs are denied by `RemuxAudioCopySafe` /
  `TranscodeAudioCopySafe`. Adding a codec to `knownVideoCodecs` /
  `knownAudioCodecs` without deciding which side it falls on is the bug
  `TestNativeOnlyCodecSetsDoNotDrift` guards — an unclassified video codec
  keeps `remuxVideoOK=true` and reaches `-c:v copy`.
  Note the asymmetry in ENFORCEMENT, which is weaker than the decision:
  audio is clamped server-side at session mint (`NormalizeSessionAudio`
  re-derives the codec from the library's own probe data), but video is
  not — `SessionOpts.Remux` comes straight from the request body, so a
  client that POSTs `remux:true` for an MPEG-2 file still reaches the copy
  path. Pre-existing (VP9/AV1 had the same hole) and self-harm only, but
  don't read the decision-engine invariant as a server-side guarantee.
  A video-side clamp is the open follow-up.
- **`hlsCaps` means "what THIS delivery path can carry", never "what the
  client can decode"** — that is why the hls.js restriction now has a
  native-client counterpart (`hlsDeliverableAudio`). Without it,
  `findBestAudioTrack` picks a DTS default track on a path that must
  re-encode it, passing over a copyable AAC track beside it.
- **Hi10P and the legacy codecs are direct-play-or-transcode, never
  remux.** H.264 High 10 in fMP4/TS is unproven on every consumer we ship;
  MPEG-4 Part 2 / MPEG-2 / VC-1 have no fMP4 mapping and hls.js can't
  demux them from TS.
- `containerCapKey` is keyed by **NormalizeContainer output**, not file
  extension — `mov` normalizes to `mp4` and must not get its own entry.
  Note `.webm` files probe as `matroska` and are therefore stored as
  container `mkv` (pre-existing; documented in the client contract).
