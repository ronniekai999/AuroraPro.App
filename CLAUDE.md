# Aurora Media Server — project memory

Self-hosted Go media server for bare-metal Linux (systemd + PostgreSQL) with a
React/Vite SPA and a native macOS client. `README.md` is the install/operate
entry point; `docs/README.md` indexes focused runbooks.

## Required workflow

```bash
go build ./...
go test ./...
```

Branch from `main`; never commit directly to it. Follow `docs/dev-workflow.md`.
For frontend changes also run `npm run audit` in `static/redesign/app/` (install
Playwright Chromium first when the environment lacks it).

### Independent adversarial review gate

Do not push, open a PR, or call a change complete until a separate fresh-context
agent has reviewed the complete final diff. The reviewer is read-only, receives
the issue/acceptance criteria and diff without the implementer's conclusions,
and reports severity-ordered findings with exact locations and residual gaps.
Resolve high/critical findings and re-review after every substantive change.

After the final content commit, record the exact reviewed commit, then commit
only the generated record:

```bash
bash scripts/record-review.sh clean --reviewer <id> --findings <n> "<summary>"
```

`clean` and `lows-only` open the advisory gate; `fix-first` does not. Use
`bypass` only when no independent reviewer exists and report the gate as
incomplete. Records are tracked in `.claude/review-records/`; record-only
commits are walked back when resolving the reviewed SHA.

The tooling is advisory, not enforcement:

- The branch owns `.github/workflows/ci.yml` and `scripts/review-gate-ci.sh`;
  either can be weakened unless CODEOWNERS and a required status check are
  configured outside the repository.
- A record proves only that a matching file names a reviewer, not that a review
  occurred. Client hooks can be disabled through Git configuration, and CI does
  not prevent direct pushes unless branch protection requires it.
- `.githooks/pre-push` checks normal pushes; `scripts/review-gate.sh` recognizes
  common push/API/merge shapes but its wrapper parser is intentionally
  incomplete. Do not spend effort pretending a client-side parser can bind its
  operator.
- The review-record job runs on pull requests, not direct pushes to `main`.
- Markdown/text-only diffs are exempt except `AGENTS.md`, `CLAUDE.md`, and
  `docs/dev-workflow.md`; changes to those rules require review.

## Live-server verification

After a change is on `main`, the admin-only deploy/test loop is:

```bash
bash scripts/server-test-loop.sh --trigger-update
```

It reads `AURORA_TEST_USER`, `AURORA_TEST_PASS`, and optional `AURORA_BASE` from
environment secrets. Never commit credentials. The updater builds
`origin/main`; without admin access, wait for `aurora-update.timer` and run the
smoke test separately. See `docs/server-testing.md`.

## Current subsystem invariants

### AI/LLM providers

All consumers use `internal/llm` through `ChatJSON(With)`, `EmbedBatch`, or
`Rerank`; provider routing never leaks into consumers.

- Chat providers: local, Ollama Cloud, Anthropic, OpenAI. Embeddings: local or
  OpenAI; Anthropic has no embedding API.
- Hosted base URLs are compile-time constants (environment-overridable only),
  never admin-editable. Each credential is sent only to its provider host.
- Hosted requests omit sampling parameters. Structured schemas pass through
  `sanitizeStructuredSchema`; tolerant `llmjson` parsing remains the fallback.
- `EmbedSpaceID` is the bare model for Ollama-family embeddings and
  `openai/<model>` for OpenAI. Changing it resets vectors and triggers a full
  backfill. OpenAI requests 768 dimensions to match `vector(768)`.
- `CheckProviderCombo` is the policy source. Secret setting names end in
  `_api_key` so existing masking applies; credentials remain plaintext at rest.
- Admin PUT writes provider selectors last and returns restart state; the SPA
  re-fetches settings rather than treating the acknowledgement as settings.
- Editable `chat_model`/`embed_model` are stored values (blank means default);
  effective fields are display-only. Never persist resolved defaults during a
  provider-family switch.

### Member profiles and follows

- Watch-history sharing is opt-in and rechecked on every read. Shared history
  uses only the account's default profile and completed rows.
- Follow feeds apply the viewing profile's parental ceiling.
- Member responses never expose email, role, or auth data. Avatars pass through
  `memberSafeAvatar`; social handles are bare and network-validated.
- Member routes stay under `/api/members/*`; `/api/users` remains admin-only.

### Watch-party invitations

- Sending is host-only. A duplicate invite is a no-op and never resets RSVP.
- Delivery goes only through `notify.Dispatcher` and only for a newly created
  row; that created flag is the invite-notification deduplication boundary.
- Parental rating is checked at send time against the invitee's default
  profile. This is point-in-time only: joining and later media swaps are not
  rechecked, so do not claim stronger enforcement.
- Rosters expose member-safe fields and omit declined users, although declined
  invitees retain roster-read access.
- Scheduled, unstarted rooms survive disconnect reapers and restarts. Timers
  self-validate the current schedule and deduplicate reminders.
- Party calendar chips group by viewer-local date; episode air dates remain
  UTC-keyed.

### Direct-play casting

- The receiver often fails silently, so `castDirectPlaySupported` fails closed:
  H.264 plus AAC/MP3 in MP4, at most 1080p, with every unknown rejected.
- Gate on `audio_codec_out`, which represents the effective default track, not
  the first stream's `audio_codec`.
- `/api/stream/direct/` stays in `receiverAssetPrefixes`; the neighboring
  browser cookie route remains credentialed. Direct-file probes use HEAD;
  playlist probes use GET. Probe failures are diagnostic only.
- Only the no-media sentinel tears down `start()`. General load failure cannot
  yet end a cast safely without closing the player after the disconnect
  debounce.
- `.mov` is normalized and served as `video/mp4`.
- Track receiver media positively through `castLoadedMediaRef`; never infer it
  from local delivery mode or an absent committed session. A sessionless commit
  clears the previous committed tracker slot.
- Known gaps: receiver rejection is not reliably detected, failed attempts can
  close the player, refusal does not fall back to HLS, and behavior lacks a
  real-device end-to-end test.

### Midstream and watch-party casting

- Seed the host baseline after `loadMedia`; do not suppress the receiver's own
  IDLE/PLAYING transitions. Never update a transition baseline before the
  transition is consumed.
- No correction or host transition processing crosses an in-flight load.
  Promote an anchor only after the load resolves.
- Clone anchors follow the sender position and are padded backward within the
  FFmpeg initial-burst window. A missing `start_sec` is omitted, never encoded
  as zero; zero is a valid anchor and nullable state represents unknown.
- `start_sec` from the cast-token response is the only receiver/absolute-time
  conversion key. `?at=` is merely a bounded hint.
- A casting host becomes authoritative only after the receiver arrives at the
  party position. Its corrective seeks are not user scrubs and must not be
  broadcast as such.
- Host broadcast decisions live in `decideHostBroadcast`; position and play
  state form one decision. A failed correction escalates only where re-anchoring
  is safe.
- Reset per-title cast state on target identity. Keep `blocked` distinct from
  `none`; blocked actions must be retried rather than consumed.
- Determine party episode identity through `isPartyEpisodeMismatch` and pass
  absolute source seconds to `loadCurrent`/`castLoadGetter`.
- Known gaps: no real-device coverage or produced-edge signal; reload-based
  resume is not broadcast; shared-session and authoritative-host corrections
  cannot re-anchor; party media changes can leave a receiver on the prior item.

### Native-client direct play

Contract: `docs/native-client-caps.md`; tests compare it with server and macOS
capability declarations.

- Nothing is direct-playable without explicit client capabilities.
- Direct-play-only legacy formats transcode when unsupported; they never enter
  a copy path by inference.
- `hlsCaps` describes the selected delivery path, not the physical device.
- Hi10P and legacy codecs are direct-play-or-transcode, never remuxed into an
  HLS path that cannot carry them.

### Playback selection and pacing

- `ClientCaps.MaxBitrate` and `SessionOpts.MaxBitrate` are viewer ceilings, not
  source metadata.
- Language preference selection must agree in direct-play and transcode paths.
- `transcode.stereo_downmix=legacy` is the byte-identical rollback; the newer
  path is explicit about channel layout.
- `hevc_output:auto` permits hardware output only; `all` explicitly opts into
  software HEVC.
- `-readrate_initial_burst` requires FFmpeg >= 6.1 by major and minor version.
- Tonemapping scales before the zscale/Hable chain.
- Forward seeks rebuild only beyond the produced edge supplied by hls.js.
- `effectiveDefaultIndex` is the single model of the track a player starts.
- Known gap: an HLS quality up-switch can still stall because new rungs start at
  the current absolute source position and no cross-rendition produced-edge
  contract exists.

### Node build floor

- Install/update scripts distinguish an impossible build from an unsupported
  but potentially working Node release and report failures before fetching.
- The gate applies only when building the SPA from source; committed fallback
  assets need no Node runtime.
- `scripts/node-version-test.sh` executes call sites against a fake Node and
  verifies duplicated `node_vite_verdict` implementations remain identical.
  Duplication is intentional because the root updater may run from a source
  mirror mid-checkout.
- Known limits: the declared Vite engine range is read from the lockfile rather
  than tested on real installations; the intermediate Node verdict is reasoned,
  not measured; pre-fetch gating means an outdated box needs manual repair.

### Library path preflight and catalog safety

`scripts/check-library-paths.sh` is a second opinion, never a safety gate. The
operator runbook must keep saying so.

- Unknown or ambiguous filesystem state exits 2, never an all-clear. Positive
  proof of absence differs from EACCES, unreadable ancestors, symlink loops, and
  unresolved symlink targets; `classify_root` owns that distinction.
- Mirror the scanner's lexical walk root and resolved escape-check root. Do not
  compare walked lexical paths against only the resolved root.
- `find "$root" ! -type d` matches the scanner's `!d.IsDir()` semantics,
  including symlinks and unusual entries.
- Line-oriented comparison cannot represent newline or empty paths; SQL counts
  those rows explicitly. Quietly failing tools need status checks, contradiction
  checks, or known-answer probes, as appropriate.
- The script intentionally over-reports unreadable subtrees, does not model the
  empty-item sweep, and does not reproduce every `walkFailed` condition.
- `scripts/check-library-paths-test.sh` drops privileges for permission cases;
  mutation coverage and `LC_ALL=C` structural checks are load-bearing.

Library repointing UI was withdrawn after destructive prototypes. Before any
retry:

- Treat catalog deletion as the highest-risk area and test against real
  PostgreSQL from the first commit.
- Do not detect relocation and globally suppress/defer pruning. The viable rule
  is per-row: an old path outside current roots was not walked, so absence is
  not deletion evidence.
- Fix `episode_files ... ON CONFLICT ... episode_id = EXCLUDED.episode_id`
  separately first; quick-hash changes can otherwise re-parent episodes.
- `FindMediaItemByTitle` no longer projects `year` at all — its projection was
  narrowed to the four columns the scanner reads — so the NULL-year scan error
  is gone without the upsert's `COALESCE(year, 0)` keying moving. Re-check that
  before relying on it.
- Use `docs/moving-media-paths.md` for the current manual procedure.

### Merging duplicate media items

`MergeMediaItems` ends in `DELETE FROM media_items WHERE id = duplicate`, and
`media_items` has 19 `ON DELETE CASCADE` children. Anything not re-parented
first is destroyed silently. It handled 8; the other 11 arrived in later
migrations. Code in `internal/db/queries_phase2.go`, tests in
`queries_merge_children_test.go` (all `TEST_DATABASE_URL`-gated).

- `mergeChildren` DRIVES the generic loop. A classification that does not cause
  handling is a comment, and a list used only as a cross-check was defeated by
  adding one line. `bespoke: true` is the one shape the loop does not handle, so
  the behavioural test seeds a row for all 19 including those.
- A collision key is the FULL unique key minus `media_item_id`. A partial key
  does not error; it judges another profile's or parent's row a collision and
  deletes it. Got wrong twice — `recently_surfaced_items`, and `watch_progress`
  on both the item and episode paths, which destroyed a kid profile's history.
- A partial-keyed child cannot reach the generic path, declared or not.
  `mergeChildStrategyError` refuses a declared `keyPredicate`;
  `mergeChildPartialKeyError` asks the live schema on every merge and refuses an
  undeclared one, including when the introspection query itself fails. The
  schema-reading test is not enough — it does not run where the merge does.
- Three drift guards (`media_items`, `tv_episodes`, `tv_seasons`), all covering
  CASCADE and SET NULL. The SET NULLs are the nastier half: a stripped
  `watch_parties.episode_id` leaves a live room on no episode, and
  `internal/watchparty/rehydrate.go` reads it at boot.
- `episodeCol` is data, pinned against `pg_constraint`: the recap tables use
  `up_to_episode_id`, not `episode_id`.
- `episode_recaps` is re-pointed with a plain UPDATE because a collision check
  there can only compare the row against itself. The target pair being free is a
  data expectation, not a constraint — violated, it raises 23505 and rolls the
  merge back. `recap_conversations` is a container: its turns move first, or the
  empty survivor's win destroys a person's whole Q&A thread.
- A self-merge is a no-op. Without the guard every collision check matches the
  row against itself, nothing moves, and the DELETEs strip the item's own data.
- Added statements return their errors; the pre-existing ones swallow them. On
  abort, both items are left in place, which beats destroying data.
- `mergeRecapConversationChildren` moves turns onto the surviving conversation
  for the SAME profile. Drop that one predicate and the join has two candidates
  and picks arbitrarily, so one person's private Q&A lands in another's — a
  disclosure, not a misplacement. A review showed the single-profile test could
  not see it, and a two-profile test that relies on which candidate Postgres
  picks is a coin toss; the pinning test gives the OTHER profile the only
  canonical conversation, so the wrong answer is the only one available.
- Known gaps: recaps on a colliding duplicate EPISODE still die with it;
  `watch_parties.media_title`/`media_poster` stay denormalized;
  `handleDuplicateMetadata` swallows a merge error and reports the duplicate
  handled — including a refusal from `mergeChildPartialKeyError`, so a
  transient catalog-read failure stamps the surviving duplicate as attempted
  and leaves it to the rotation; nothing locks the duplicate row, so a
  concurrently inserted child is still cascaded away; `media_cast`'s
  nullable-`character` check over-keeps; the recap move's `NOT EXISTS` de-dup
  is unpinned (without it a repeated `request_id` raises 23505 and rolls the
  merge back, so it fails loudly).

### Enrichment recovery for never-attempted items (issue #510, migration 059)

A TV show whose row exists but whose enrichment never ran used to be permanently
stuck: the deferred TV pass runs after `wg.Wait()`, abandons its queue on
`ctx.Err()`, and `scanContext()` hands it the server lifecycle context, so any
restart mid-scan produces the state.

- `metadataProgressExpr` = `GREATEST(last_metadata, last_metadata_attempt)` is
  the one definition of "already dealt with"; the aliased form comes from the
  same `metadataProgressFor`. `last_metadata` means STORED, the attempt column
  means ASKED AND ANSWERED. Do not collapse them: the refresh queue's smart diff
  hands `last_metadata` to TMDB's changes API.
- The attempt stamp is gated on `err == nil`. Stamping failures would let one
  outage defer every item it touched by a refresh interval.
- Two recovery paths divide the work FOR SHOWS: the scanner sweeps rows never
  attempted, the rotation owns everything already attempted. Movies reach the
  same state and are recovered by the rotation alone.
- The sweep runs ONCE PER SCAN, not from the per-file path. `processFile`
  returns early on an unchanged hash, and the #510 state is exactly "every file
  recorded, then the deferred pass cancelled" — so the per-file latch is
  unreachable there. Keep both; the latch covers a show that gains files first.
- The sweep is bounded twice: a mandatory positive `limit` (100) and a
  per-library interval (1h, process-local). Selection is "no progress" while the
  stamp needs an answer, so a reliably ERRORING show stays eligible for ever —
  unbounded, an invalid TMDB key re-searched and re-embedded the whole library
  on every fsnotify-triggered scan. The limit also stops a scan-unrelated sweep
  starving the episode backfills that run after it.
- Exclude shows with no episode files: `DeleteEmptyMediaItems` (phase 1c, before
  the sweep) removes them on the next clean scan.
- A show that matched nothing reads as `match_status='matched'` with a NULL
  `tmdb_id`, so it is invisible to `GetItemsNeedingReview` and the AI re-match
  backfill. The rotation is its only path; do not cite that pipeline instead.
- Sharing `metadataProgressExpr` with a test does not pin that the query uses
  it. The rotation is pinned end-to-end through `GetStaleMetadataItems`, the
  stamp gate behaviourally against a fake TMDB (the test assigns the unexported
  `tmdb.baseURL`; there is no exported seam), and the sweep by real
  `ScanLibrary` runs — deleting the sweep block used to fail no test anywhere.
- The sweep runs LAST in the deferred pass, after the per-file fulls AND the
  episode backfills, and is kept in its own slice to make that true. It is the
  one part not derived from the scan's delta, and a backfill is only ever
  signalled in the scan that FIRST sees the file — so a cancellation during a
  sweep queued ahead of them dropped a signal that is never raised again. The
  rotation is only a PARTIAL net for that: its smart diffing skips a show
  outright when it has a `last_metadata` and a `tmdb_id` and TMDB reports no
  upstream change, and a locally added file is not one — so for the MATCHED
  class, which is the common one, those episodes stay bare permanently. Not
  every backfill-eligible show: eligibility is `Attempted`, which is either
  progress column, so an asked-and-unmatched show has both NULL and the rotation
  does re-enrich it.
  The sweep's shows cannot also hold a backfill entry (a backfill needs the row
  ATTEMPTED, the sweep selects rows that are not, and progress only moves
  forwards), so the ordering costs no redundant pass.
  `TestScanLibraryRunsTheRecoverySweepAfterTheEpisodeBackfills` pins it; moving
  the loop back to the front left the whole suite green.
- Known gaps: deterministically erroring items are bounded, not fixed, and the
  process-local interval re-arms on every deploy; a scan and the background
  refresh can enrich one row concurrently with nothing serialising them — and
  the two queues now select the SAME rows in the same order by construction
  (`NULLS FIRST` puts the no-progress set at the rotation's head, `id ASC`
  orders it, and the sweep uses the same predicate and `ORDER BY id`), so for a
  single-library install the overlap is the common case rather than a
  coincidence; `enrichSeasons`' error is discarded, so a show whose episode pass
  failed is still stamped attempted and the scanner latch then excludes it; a
  failed merge strands a row; `UpdateMediaMetadata` always stamps
  `last_metadata`, so the admin refresh endpoint can write a stored-claim for an
  unmatchable show; `tv_episodes` has no index on `media_item_id` and the sweep
  query joins on it twice (pre-existing shape, amortised by the hourly limit);
  and the sweep claims its rate-limit slot up front but now does its work last,
  so a scan cancelled before reaching it has spent the interval for nothing —
  bounded only by the slot being process-local, so the restart that caused the
  cancellation re-arms it.

### Nullable database columns

Go scalar fields use zero values as unknown sentinels. Queries projecting
nullable scalar columns into them must use `COALESCE`; do not convert the model
to pointers as a local fix.

Affected families include nullable scalar fields in `media_items`,
`media_files`, `episode_files`, `requests`, `user_profiles`, and `artwork`.
A predicate mentioning a nullable column does not exclude NULL. Check every
projected column, including raw siblings beside already-coalesced fields.
`COALESCE` inside a `DISTINCT ON` CTE is sufficient for outer projections.

Run database probes with `go test -count=1 ./...`; cached results create false
confidence. Fixtures must fail if their query returns no rows and clean up
catalog-wide rows because packages share the database. Existing tests cover
only queried paths, not all 128 nullable columns across the schema, and no lint
or schema constraint prevents a recurrence.
