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

### First-priority playback repair contracts (October 2026)

- With a readable prior HLS playlist, `append_list` owns resume numbering;
  preserve existing segment bytes/sequences and retain missing-playlist fallback.
- Keep profile-bound cast progress on the acknowledged outgoing title even
  after local navigation. A clock needs a coherent current Media generation
  and acknowledged source anchor. Retire old IDs within their CastSession;
  rejected retries retain genuine prior-media recovery. Failed-generation
  terminal proof permits cleanup only, never completion or advancement.
- Party episode advancement withholds outgoing playback/broadcasts. A newer
  canonical Pause wins over delayed automatic playback; explicit Play/Pause
  remain usable. Explicit Pause consumes one matching video event without
  clearing remote echo suppression, and teardown retires its ownership.
- Cast copies preserve shared anchors/ladders, source decode facts and bounded
  H.264/AAC output with truthful SPS/playlist signalling. Ordinary ultrafast
  software output uses a private High-profile copy when sharing is unsafe.
- VAAPI and QSV encoder levels use their backend's numeric scale; QSV HEVC
  signalling uses Main tier. The HDR fixture carries BT.2020/PQ in raw HEVC;
  production tonemapping is unchanged. Physical receiver/GPU checks and the
  general paused-encoder/subtitle-carrier policy remain separate validation.

See `docs/playback-casting-review-2026-09.md` section 11 and PRs #519–#522 for
merge evidence and the release-specific test/review records.

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

### Parental rating ceiling

- Rule (issue #462): a gate on the caller's own ceiling takes it from
  `ResolveActingProfile`, never a client-sent `profile_id`/`max_rating`. (A
  gate on someone else's ceiling, such as the watch-party invite check, uses
  theirs.) Not every existing route follows the rule yet; see the gaps below.
  Discovery responses fail open on a resolve error, with the gated detail and
  playback routes as the boundary. Persisted results fail closed: AI-collection
  seeding, invite sending, taste-onboarding seed validation and the
  recommender (whose hero, discover and engagement builds are cached) do; party
  media changes do not (see the gaps).
- `internal/db/ratings.go` is the only ladder a gate may use, through
  `AllowedRatingsForMax` or `RatingAllowed`; nil means unrestricted. An empty
  slice is ambiguous: gates testing `len(allowed) > 0` read it as unrestricted,
  gates testing `$n::text[] IS NULL` as allowing nothing. Never produce one for
  a restriction.
- `maturityTierCase` (`internal/db/queries_recommender.go`) and
  `audienceClause` (`internal/embedding`) map ratings to soft tiers, know
  ratings the ladder does not, and must never gate.
- `SemanticSearch` is the one kNN query the HNSW index serves, and under it
  filters apply to only about `hnsw.ef_search` (100) candidates, so a selective
  filter comes back short. A short page is re-run once as an exact scan; a full
  page is as approximate as an unfiltered ANN query of that depth. The retry
  is a separate SQL text that selects `exactDistance` and orders by that
  column, which the index cannot serve.
  Never retry the same text under changed planner settings: a cached generic
  plan ignores them. A retry that fails (other than by its context ending)
  returns the short page. The recommender and onboarding kNN queries order by their
  `DISTINCT ON` key first, so they never use the index and are exact.
- Filter in SQL before cross-library dedup and before `LIMIT`. Library search
  filters both semantic recall legs (the lexical leg takes the vector leg's
  `SemanticFilter`), so fusion, rerank and the title fallback only see allowed
  titles. AI-collection seeding passes the creator's ceiling and, because the
  seed is saved, skips seeding on a resolve error instead of failing open.
- `max_age_rating` is canonicalized on write by `CanonicalMaxRating`; unknown
  values are a 400. Reads tolerate case and whitespace, and an unknown value
  restricts to the all-ages tier rather than lifting the ceiling. The boot data
  migration `canonicalizeProfileRatings` rewrites stored values to that meaning
  so the API and clients report the enforced ceiling.
- A ceiling change invalidates the profile's recommender caches, which are built
  under the ceiling it reads at build time and otherwise live up to 24h. When
  that read fails (`Hero.allowedRatings` ok=false), every recommender surface
  builds nothing. No recommender cache stores an empty result, so the next
  request retries; Discover's handler still waits out its 60-second empty
  window.
- Coverage is NOT complete, and no route-by-route audit exists. Server-derived
  enforcement covers: the #462 routes (media detail, seasons and episodes,
  media/episode/direct file streaming, subtitles, transcode-session creation,
  direct-play cast-token minting), browse, Recently added, library search, and
  AI-collection seeding. Never infer coverage elsewhere from this list; check
  the handler.
- Known gaps (examples, not exhaustive):
  - Ceiling taken from an owned `?profile_id=`, or the account's default
    profile without one, never the acting profile: the discovery routes behind
    `HeroHandler.resolveProfileID` (hero, recommendations, discover, anchor and
    engagement rails), the follow feed (`resolveViewerProfile`) and taste
    onboarding (`resolveProfile`).
  - Profile chosen the same way and no ceiling at all: the recap routes
    (`RecapHandler.resolveProfileID`), and continue-watching, which falls back
    to the acting profile rather than the default.
  - No ceiling on listings: the account's watch history
    (`/api/progress/recent`, `/history`), another member's recent watches,
    every live party server-wide (`/api/parties/active`, with title and
    poster), and `/api/calendar` (every show's upcoming episodes by date).
  - No ceiling on lookups by id: `/api/media/{id}/files`, `/next-episode`,
    episode files, artwork, cast, `/api/stream/info/{fileID}` (tracks and
    external subtitle filenames), and a party's `highlight.mp4` (membership
    only). Collections, watchlists and My Library accept any media id and read
    items back unfiltered, so a restricted profile can enumerate the library
    through them.
  - Transcode sessions rely on their creation-time check: the session cast
    token (`CreateCastToken`) and the session's playlists and segments check
    only account ownership, so a restricted session holding another profile's
    session id on the account can use it.
  - Watch parties: creating one applies no ceiling, and changing a party's
    media skips its ceiling check when the media or profile lookup errors or
    finds nothing; both are persisted.
  - No PIN anywhere: any session on the account can change any of its
    profiles' ceilings, and `ActivateProfile` checks only ownership, so a
    restricted session can switch itself to an unrestricted profile.

### Member profiles and follows

- Watch-history sharing is opt-in and rechecked on every read. Shared history
  uses only the account's default profile and completed rows.
- Follow feeds apply the viewing profile's parental ceiling, where the viewing
  profile is an owned `?profile_id=` or the default, not the acting profile
  (see Parental rating ceiling).
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
- The sweep's rate limit is claimed under `requeueMu`, and that exclusivity is
  pinned through `Scanner.testHookInRequeueClaim` rather than by racing
  goroutines. A 16-goroutine stress test passed EVERY run with the mutex deleted
  at `GOMAXPROCS=1`, `-race` included — the detector is right to stay quiet,
  since `sync.Map` is race-safe and this is a logical check-then-set — so a
  guard can survive its own mutation entirely on a single-CPU runner. The hook
  is a FIELD, not a package variable: as a global it fired for every `Scanner`,
  and a `t.Parallel()` anywhere in the package turned it into a false failure
  whose second "caller" was an unrelated `ScanLibrary` holding the mutex.
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

### Library type: the report and the retype (issue #510)

A library created with the wrong type is the defect behind #510. The owner's "TV
Shows" library was `type='movie'`, so `isTV := lib.Type == models.LibraryShows`
sent all 80 series through `ParseMoviePath`, stored them as
`media_items.type='movie'` with their files in `media_files`, and searched them
against TMDB's MOVIE index. Nothing matched, nothing surfaced it, and every scan
reported success. Code: `internal/db/queries_library_health.go` and
`queries_library_retype.go`, `internal/api/library_health.go` and
`library_retype.go`, SPA `AdminLibrariesTab` / `RetypeLibraryButton`.

The report (`GET /api/admin/library-health`, plus one log line per scan from
`OnScanComplete`):

- "Matched" is `tmdb_id`, never `match_status`. That column DEFAULTs to
  `'matched'` and `UpsertMediaItem` never writes it, so every row this report
  exists to find reads as matched with a NULL `tmdb_id`.
- Flags a library at or below a 5% match rate with at least 10 titles. When
  EVERY eligible library is starved it raises ONE install-level warning naming
  the provider instead — that pattern is a bad TMDB key, and per-library type
  warnings would send an admin the wrong way.
- That suppression needs TWO eligible libraries. With one, the explanations are
  indistinguishable, and suppressing would silence exactly the single-library
  install whose one library is mis-typed. A false warning costs a look at a
  settings page; a false all-clear costs what #510 cost.
- A library mid-scan is excluded from its own warning AND from the install-wide
  tally. The second half was missing: freshly scanned rows have no `tmdb_id`
  until enrichment finishes, so a first scan reads as starved, and on a
  two-library install that flipped the report to "check your TMDB key" and
  silenced the real warning on the mis-typed library beside it.
- Report only. Admin-gated and NOT on `/api/libraries`, which is member-visible.

The retype (`GET /{id}/retype/preview?type=`, `POST /{id}/retype`):

- It is a PURGE and a rescan, never a field edit. A bare `UPDATE libraries SET
  type` is actively harmful: existing rows keep the old type, their files stay
  in the wrong table, and `pruneDeletedFiles` branches on the same `isTV`, so
  those
  `media_files` rows become unreachable by any later prune. Permanent phantoms
  on top of a catalog that still reads as the old type.
- Two calls. The preview is read-only and counts casualties; the confirm echoes
  `items_to_delete` back and the transaction REFUSES on a mismatch (409). The
  recount happens inside the transaction after `SELECT ... FOR UPDATE` on the
  library row — checking outside would leave the window it exists to close.
- `expected_items` is a POINTER. Zero is a legitimate approval, so as a plain
  int64 an omitted interlock and an approved zero are the same value.
- The casualty list is the TRANSITIVE cascade closure of `media_items`, read
  from `pg_constraint` at query time. It was derived from `mergeChildren` plus
  one hand-coded exception, and a review showed that silently omitted
  `skip_markers`, `skip_marker_analysis` and `recap_conversation_turns` — a
  person's whole recap Q&A thread destroyed without appearing in the preview,
  while the comment claimed nothing could be missing. `mergeChildren` is pinned
  for DIRECT children only, so it could never have carried the second hop. A
  table reachable by several paths is counted ONCE (`skip_markers` hangs off
  both `media_files` and `episode_files`); the one blind spot is multi-column
  cascade keys, which `TestRetypeCascadeClosureCoversTheWholeSchema` fails on
  if one ever becomes reachable.
- The casualty descriptions are the retype's own, never `mergeChildren`'s `why`.
  Those describe a MERGE — ten of nineteen begin "re-parented:" — so the one
  screen whose job is to say what is about to be destroyed was telling an admin
  their live watch party would be re-parented.
- The scan slot is claimed before anything is touched and handed to the rescan,
  so the library is never unlocked in between. A refused retype releases it via
  `ReleaseScanSlot`, which frees an UNUSED claim only — otherwise a refusal
  leaves the library reading as scanning for the life of the process.
- The WATCHER is re-pointed at the new library value, inside the rescan
  goroutine and ahead of the scan — never inline in the handler, and the
  ORDERING is pinned through `onRescanProgressForTest` because polling for the
  final state cannot see it (an empty tree rescans in milliseconds).
  `WatchLibrary` walks every library path with `filepath.WalkDir`, which
  `LibraryHandler.Create` carries a post-mortem comment about because doing it
  synchronously caused 504s; inline, that put a multi-minute walk AFTER a
  committed purge on a 60s route, so the most destructive endpoint in the repo
  could report a gateway failure for work it had already done. On failure the
  entry is installed ANYWAY with the current value and `WatchLibrary` returns
  `ErrFSWatchUnavailable`. `w.watching` is also what `periodicScanLoop`
  iterates, so the previous behaviour — return early, or drop the stale entry —
  took the library out of automatic scanning entirely, not just out of file
  events. That is the state where the rescan is most likely to have failed too.
  `WatchLibrary` stores the `*models.Library` it was handed as a SNAPSHOT and is
  called only at boot and on library creation, so the periodic tick and the
  fsnotify debounce keep passing the pre-retype value to `ScanLibrary`, which
  branches on `lib.Type` rather than re-reading the database. Without this the
  first file event after a retype re-scans under the OLD parser and re-creates
  the exact phantom state the operation exists to remove. A review demonstrated
  it end to end; `Watcher.WatchedLibrary` exists so the next one can assert it
  from outside the package.
- The purge transaction runs on the SERVER-lifecycle context, not the request's.
  The route carries a 60s timeout and the DELETE scales with library size; a
  cancellation racing `Commit` is ambiguous, so the handler would answer 500
  with no rescan launched while the purge may have landed.
- The count interlock covers the ITEM count only, not the casualty counts shown
  beside it. Widening it would refuse the operation any time anyone watched
  something. It is also belt-and-braces now: `RowsAffected` is compared after
  the DELETE, because the recount's atomicity rests on `FOR UPDATE` conflicting
  with the FK's `FOR KEY SHARE` on the same row — real, load-tested by a review,
  and silently lost if anyone "corrects" it to `FOR NO KEY UPDATE`. The
  `FOR UPDATE` itself is pinned by NOTHING: replacing it with a plain `SELECT`
  passes every test, and the outcome stays safe only because `RowsAffected`
  turns the over-delete into a 409 rollback.
- Calling it with the type the library already has is the repair path, not a
  no-op: it purges rows whose type disagrees with the library's, which is the
  state hand-written SQL leaves behind.
- `libraries.type` also carries a CHECK constraint (movie|show). That is a real
  backstop but it fires INSIDE the transaction, after the DELETE; the Go-side
  type check is what stops `type <> <garbage>` matching every row.
- Deliberate non-goal: nothing is preserved across a retype. Re-parenting a
  movie row's history onto a show row is the premise the withdrawn repointing
  work proved false, and guessing wrong loses data silently instead of loudly.

Known gaps: the retype is not reversible and there is no undo; the rescan is
fire-and-forget, so a failure after the purge commits leaves an empty library
until someone scans again; the purge holds the `libraries` row lock for its
duration, which blocks `media_items` inserts for that library; the preview runs
one count per affected table and is not instant on a large library, and a
timeout there makes the confirm unreachable since it needs the preview's number;
the preview enumerates DELETIONS only, so the two `SET NULL` side effects go
unreported (a watch party on a KEPT title losing an episode that belonged to a
removed one, and the same for a recap turn's episode boundary); live watch
parties are deleted underneath `internal/watchparty`'s in-memory manager, which
is not notified, so participants stay connected to a room whose row is gone; the
rescan goroutine is a bare `go` like `Create`'s and `Scan`'s, so shutdown does
not wait for it and `addDirRecursive` ignores its context; and the report's
thresholds are reasoned, not calibrated against real installs.

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
