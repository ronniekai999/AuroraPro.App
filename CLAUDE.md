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
- Profile-keyed routes (`?profile_id=`, a body `profile_id`, a `{profileId}`
  segment) resolve through `resolveRequestProfile`: the acting profile when
  none is named, never the account default; a named profile must be the
  account's; a restricted session may name only itself (403
  `profile_restricted`). Fails closed on a resolve error. The account-wide
  history routes show a restricted session only its own rows, under its
  ceiling.
- The gated by-id routes (`docs/parental-ceiling.md` lists them) go through
  `internal/api/ceiling_gate.go`: lookups by id with the acting profile,
  profile-keyed routes with the resolved profile (so a parent naming the kid
  gets the kid's ceiling). The stream routes keep their own file check. Under a
  ceiling a missing id gets the same 404 body as an over-ceiling one, so these
  routes do not say which ids exist; for an unrestricted profile the gate
  skips the title lookup. The detail route (`GET /api/media/{id}`) does its
  own check on the title it loads (`RatingAllowed`), with the same 404 body;
  it always looks the title up, and a lookup error there is a 500. The gated
  writes (progress, mark watched, thumbs, star ratings, watchlist, My Library
  and collection adds) are gated because history, anchor rails and the lists
  read the title back. Party creation and party media changes still take any
  id (see the gaps). Deleting and
  clearing are not gated, so a profile can remove what it can no longer see,
  where it can name it. A progress write's episode is judged on its own show,
  not the id it is filed under.
- Coverage is NOT complete. `docs/parental-ceiling.md` is the route-by-route
  map; change its row when you change a route's gate. Never infer coverage
  from a summary; check the handler.
- Known gaps (examples, not exhaustive):
  - Data recorded before a ceiling: the recommender's anchors come from
    history with no ceiling, so pre-ceiling progress can still name an
    over-ceiling title in an anchor rail's "Because you watched", in the
    `nearest_anchor` captions on `/api/me/recommendations`, and in the LLM
    prompts behind the hero, discover and rail blurbs. Pre-ceiling 1-2 star
    ratings of over-ceiling titles likewise reach the hero and discover
    prompts (`LowRatedAnchors`). A watchlist's pre-ceiling entries (any list
    but My Library) are hidden from its reads, which also hides the row ids
    its item DELETE takes, so they go only with the whole list. `GET
    /api/me/rating` returns the profile's own stars for any id (no title
    data). Pre-ceiling taste seeds reach the Discover prompts
    (`TasteSeedAnchors`), and every pre-ceiling taste signal (seeds,
    progress, favourites, want-to-watch entries, thumbs-up, 4-5 star
    ratings) still pulls the taste vector, whose query has no rating filter;
    that steers results but names no title.
  - Timing: under a ceiling a missing id and an over-ceiling one get the
    same body, not the same time. The stream-info and detail routes answer a
    missing id after one query and an over-ceiling one after two to five, as
    the stream routes do, so repeated timing can tell them apart.
  - Cross-library copies: the detail, files, episodes and next-episode
    lookups add files of other items with the same TMDB id without checking
    those items' ratings, so a restricted profile can be offered a version
    (with its media id) whose stream then 404s.
  - Party media changes answer "unknown media for this party" for a missing
    id and "media exceeds this profile's content rating" for an over-ceiling
    one, before the host check, so any participant can tell the two apart.
  - The SPA's My Library snapshot is the profile's own (per account and
    profile), but can hold titles saved before its ceiling was set or
    lowered; they show until the server's filtered list arrives, or while
    offline. (Tonight's "Your list" rail for a restricted profile waits for
    the server's list and shows only the titles on it.)
  - The calendar, live-party, invite and collection listings fail open on
    a resolve error, like browse; a collection's name, description and AI
    prompt are shown as written; and a party's title still reaches a
    restricted session by code (`GET /api/parties/{code}`, and the public
    `/api/code/{code}/info`) and in notification text written when the
    invite, RSVP, reminder or reel was sent. The live-party and invite
    listings judge the party's title id; the title text and poster they show
    are the host's own for room starts and media changes, so a host can
    label an allowed title with another's name.
  - Transcode sessions rely on their creation-time check: the session cast
    token (`CreateCastToken`) and the session's playlists and segments check
    only account ownership, so a restricted session holding another profile's
    session id on the account can use it.
  - Watch parties: creating one applies no ceiling, and changing a party's
    media skips its ceiling check when the media or profile lookup errors or
    finds nothing; both are persisted.
  - The profile lock (below) stops a restricted session switching into a
    locked profile or changing ceilings, and `resolveRequestProfile` stops it
    naming another profile. Neither filters the listings and lookups above.
  - An unrestricted session may name any of the account's profiles, a
    PIN-locked one included, and read or write that profile's data. By
    design: the lock guards switching, not the data.
  - WS `/ws` sends every profile's progress events (media ids and
    positions) to all of the account's devices.

### Profile lock (PIN)

Opt-in, per profile: `user_profiles.pin_hash` (migration 060), argon2id
through `auth.Service`. Code: `internal/api/profile_handlers.go`,
`internal/db/queries_profile_pin.go`, SPA `lib/useProfileSwitch.ts` and
`ProfilePinDialog`, TV `TvViewModel.selectProfile`.

- `ActivateProfile` into a locked profile needs its PIN or the account
  password, unless the session already acts as it. The check runs before the
  unbound-token branch. A token with no session id is a 409
  `session_unbound`, a session row that is gone a 401 `session_ended`, and a
  revoked (rotated) one a 409 with no reason, never a 200: clients take a 200
  as a confirmed binding. The
  password is the recovery path, by the owner's choice. Making a locked
  profile the default (`SetDefault`) needs the same, since every session with
  no binding acts as the default, and `SetDefaultProfile` first binds the
  account's unbound sessions to the old default (revoked rows too: an access
  token resolves through its row after rotation), so on an account with a
  default, re-defaulting moves no other session whose row exists when it
  runs. It can move what has no row
  to bind: the still-valid access token of a session whose row is gone (a
  revoked row is kept) acts as the account's
  most restrictive profile, ties going to the default, and a token naming no
  session acts as the default, so for up to a token lifetime a re-default
  can change which profile either acts as, to the new default without its
  PIN among others. An account with no default
  has none to bind them to: there, when the new default has a PIN, its other
  unbound sessions are signed out instead, keeping only the row the asking
  session's access token names (a token older than its session's latest
  rotation keeps the old row, so that device signs in again too); with no
  PIN they move from the stand-in onto the new default, past no PIN.
- Setting or changing a PIN ends the account's other sessions that act as
  the profile, including ones that entered the old PIN: those bound to it,
  and the unbound ones when it is the default, revoked rows included
  (`SetProfilePIN`, under the user-row lock rotation takes). The rows are
  DELETED: a revoked row keeps resolving to its binding for its access
  token's lifetime, and a review used that window to lift the kid's ceiling
  and create an unrestricted profile. The caller's own session is kept; the
  others sign in again. Without this a kid's device left on the parent's
  profile (switching was free before the lock), or one that used a leaked
  PIN, kept it, since a session already acting as a profile skips its PIN.
  Clearing a PIN ends nothing. Activation's bind takes the user row FOR
  SHARE and rechecks the PIN state the handler judged
  (`SetActiveProfileForTokenIfPIN`), so a PIN set or changed in between is a
  403 `profile_pin_required`, not a bind; an attempt that found no PIN binds
  only while there is still none, so a PIN removed and set again in between
  is refused too. PIN writes run argon2id twice at
  most and have their own budget, 5 per 15 minutes per account and acting
  profile (`pinWriteLimiter`, in memory), so one session cannot spend the
  owner's.
- PIN attempts: each is counted BEFORE its argon2 check, in one UPDATE that
  refuses while a lockout runs (`ReserveProfilePINAttempt`). Counting after the
  check let concurrent guesses all pass the lockout read; a review drove 40
  through a limit of 5. The fifth miss starts a 15-minute lockout; a success
  resets the count; an expired lockout does not, so after the first one each
  miss re-locks. The database's clock decides lockouts.
- The account password has its own budget (5 per 15 minutes per account and
  acting profile, `passwordLimiter`) and a PIN lockout does not block it. If
  PIN misses also locked out the password, anyone on the account could keep
  the owner out indefinitely with one wrong guess per lockout, and even stop
  them changing the PIN. Per account alone, a kid's session spending the
  budget kept the owner's password out of every session; per session, a kid
  could multiply it by pairing devices, which all act as the kid.
- Refusals carry `error.reason`: `profile_pin_required` (nothing supplied, not
  counted), `profile_pin_invalid`, `profile_pin_locked` (with Retry-After; also
  a spent password budget), `profile_restricted`, `session_unbound`,
  `session_ended`.
- A restricted session is one acting as a profile with a non-empty
  `max_age_rating`. It may edit only its own name, avatar, language, subtitle
  and maturity settings. It cannot create, delete or re-default profiles, set
  or change a PIN, change any ceiling (re-sending its unchanged ceiling
  passes, and is not written), edit another profile's settings through the
  profile routes, link or unlink a sign-in identity (a new link would let it
  sign in again without the password, after its session ends), or edit the
  account's member profile (its `share_watch_history` switch publishes the
  default profile's history). These checks fail closed when the acting
  profile cannot be resolved, and refuse a session whose row is gone (401
  `session_ended`, `requireLiveSession`): its still-valid access token acts as
  the most restrictive profile, which with no restricted profile left is the
  unrestricted default. The handler's checks run before any lock, so every
  management write (create, delete, re-default, a PIN, a ceiling) rechecks
  under the account lock what its handler judged (`ManagerJudgement`,
  `recheckManager`): the session's row still exists (401 `session_ended`),
  the profile it acts as still has no limit (403 `profile_restricted`), and,
  for a PIN write or a re-default, the profile's PIN is still the one judged
  (403 `profile_pin_required`); a ceiling write also that the edited profile
  still has the limit the handler read (409 `profile_changed`, under
  `CeilingJudgement`). A PIN write ends the sessions acting as its profile,
  and a request from one of them already past its checks used to land after
  it, replacing the PIN just set or lifting a kid's limit; a parent
  tightening a kid's limit could likewise see a request judged a moment
  earlier put it back or lift it.
- An account keeps at least one profile without a ceiling: a ceiling on its
  last one, or that profile's delete, is a 409 `last_unrestricted_profile`
  (`keepAnUnrestrictedProfile`, which locks the user row first, so two such
  writes cannot each count the other's profile as the one left), and so is
  a ceiling on an account's first profile (`CreateProfileFor`): an account
  with no profile acts as an unrestricted stand-in. The
  management writes lock the user row `FOR NO KEY UPDATE`: that conflicts
  with itself, with activation's and a link's `FOR SHARE` and with the
  `FOR UPDATE` of rotation and the bound session inserts
  (`CreateRefreshTokenAtVersion`; a password login's or a registration's
  unbound insert takes no lock), but not with the foreign-key lock an
  insert of the account's children takes. `FOR UPDATE` deadlocked a profile
  delete with a recap question, which inserts a child of the profile and
  then one of the account. Without the last-unrestricted rule
  nothing on the account could manage profiles again, and onboarding's age
  reached that on a single-profile account in one move; an age entered
  there now gives the account's only such profile the tone lean and no
  ceiling. A
  profile that already has a ceiling passes, so a restricted session's own
  edits still round-trip it.
- The acting profile must not degrade to the account default for a session
  the server has lost. Revoked session rows are kept until `revoked_at` is
  older than the access-token lifetime (migration 061, `PurgeExpiredTokens`),
  because access tokens name their row and outlive its revocation; and a token
  whose row is gone anyway, or whose row names a profile that is gone or not
  the account's, resolves to the account's most restrictive profile.
  Deleting a profile deletes its sessions: the binding's foreign key
  cascades (migration 062). It used to be `ON DELETE SET NULL`, which put
  them on the default; deleting the rows first missed one bound in between by
  a refresh or a switch. A long-lived socket resolves its profile once, at
  connect (`Manager.CallerProfile`): the session row it names is rotated and
  purged while the socket stays open, and would then resolve to the most
  restrictive profile. A failed connect-time lookup is retried at the next
  change-media rather than leaving the check off for the socket's life.
- Binding a revoked (rotated) session row is refused (409): rotation already
  copied the old binding to its successor, so the write changed nothing that
  lasted. The SPA refreshes and retries once.
- Device pairing binds the new device to the approver's acting profile, so an
  approver on an unlocked profile can neither raise a ceiling nor hand out a
  locked default. When that profile itself has a PIN, the device gets the
  account's most restrictive unlocked profile instead
  (`MostRestrictiveUnlockedProfile`), which can be looser than a locked
  restricted approver's own, though never looser than a profile it could
  switch to without a PIN. With every profile locked the approval is a 409
  `profile_locked`, since the account password can still sign the device in,
  except on an account with no password, where pairing is the device's only
  way in and no route can give the account a password: the device then gets
  the account's most restrictive profile without its PIN, the approver's own
  when it ties (`MostRestrictiveProfilePIN`), never looser than any other
  profile on it. It still crosses that one profile's PIN: a kid on a locked
  profile can put a device on a sibling's that is more restrictive, or on
  the default when no profile has a limit, and the device reaches that
  profile's history and lists.
  The grant waits up to ten minutes for the device's poll, so the session
  insert rechecks under the user-row lock that the profile's PIN state is the
  one judged (`RefreshToken.BoundPINHash`: none, or the same hash): a grant
  whose profile has gained or changed a PIN since creates nothing, and the
  device pairs again. An approver whose own session row is gone cannot pair.
- Clients show the server's binding, never a remembered choice: the SPA reads
  `GET /api/profiles/active` at startup (one retry, `readSessionProfile`,
  alongside the profile list) and changes its display only after activation
  resolves, one switch at a time. It used to switch locally and activate
  fire-and-forget, so a failed call left a kid's UI on the kid profile while
  the server enforced the parent's ceiling. After a switch it shows the
  server's record of the bound profile (the same read), not the list's copy,
  which can predate an edit from another device (it falls back to the copy
  only when that read fails); the tab-visibility re-read re-lists the profiles
  each time for the same reason. The remembered choice only steers startup:
  the SPA re-activates the profile this browser last showed when it is
  unlocked (`resolveStartupProfile`), and shows it once the server has bound
  it, so a fresh sign-in on a browser a kid last used lands on the kid's
  profile, and one a parent last used on the parent's. Nothing personalized
  (hero, personalized rails, Continue Watching, taste onboarding, a title's
  recap and star rating, the My Library snapshot) loads until the session's
  profile is known (`personalProfileReady`); the snapshot is kept per account
  and profile. A request without a `profile_id` was answered for the account
  default on the discovery routes, so a kid's Home showed the parent's hero
  pick on every load; those routes now answer for the acting profile, and the
  wait keeps the app from showing content for a profile it has not confirmed.
  Tonight's hero leads with the title the profile left unfinished, from
  Continue Watching, with the recommender's picks in a filmstrip beside it
  (`lib/tonightSlate.ts`, derived each render, never stored; the strip
  lists the picks only, never the title to resume). It shows nothing until
  Continue Watching has answered or failed for the user and profile, or four
  seconds have passed (`heroLeadSettled`, `HERO_LEAD_WAIT_MS`; when there is
  no profile to ask for, once the startup load settles): shown earlier it
  put up a pick and then swapped it for that title. That the wait ran out
  is one visit's fact: a sign-out and a profile switch forget it, with the
  mark that the viewer is in the hero (`forgetHeroLeadWait`, called
  wherever Continue Watching's own answer is forgotten), so a return to the
  same user and profile waits again. A session that expires is a bare
  `setUser(false)`, not `resetUserState`, and while the app knows no
  profile for the account no profile changes either, so one effect clears
  the hero (its picks, its place in the slate, the catalog's stand-in),
  Continue Watching and the wait whenever nobody is signed in: the next
  sign-in on the tab used to be handed the last answer's title as the
  hero's lead. That effect covers Tonight's hero only; what else that path
  leaves in the tab is a gap older than this (see Known gaps). An answer
  that arrives after the four seconds takes the hero over only while the
  hero is still on the entry it opened on and the viewer has done nothing
  in it (pointer or focus in it, a pick chosen, the rotation paused).
  Otherwise the title comes up when the rotation next wraps round to it
  (its first tick is nine seconds after it starts; it does not run while
  the pointer or focus is in the hero, or once the viewer has paused it);
  either way it is the first card of Continue Watching. A touch or
  screen-reader viewer is not in the hero until they press something in
  it, so for them a late answer can change the title between aiming and
  pressing. The filmstrip hands back a place in the slate, which a press
  reads through a ref mirrored in a layout effect (`heroSlateRef`): in a
  passive one, a press in the frame the strip was drawn in read the slate
  of the commit before and put up another pick, or none. A switch puts the
  hero back on the lead (`heroOnLead`), so the new profile's Tonight opens
  on its own title, not on the place in the slate the previous profile had
  moved to. Only a pick is reported to
  the recommender as seen, at the place the server sent it at: never the
  title to resume, also when it is one of the picks (the server credits
  what is watched afterwards to the exposure), and never the catalog's
  stand-in. A session acting as a restricted profile gets the calmer
  Tonight: one title, two actions, no filmstrip, no rotation, and a last
  line that states the limit. Its rails are what it has started (when that
  is more than the hero's title), its own list and the two catalog shelves
  ("Movies", "Shows"), on larger cards; the recommender's rails are not
  shown to it and not asked for. "Your list" appears only once the server
  has answered for that profile's list in this session
  (`libraryServerFor`, cleared whenever the list is loaded from this
  browser's snapshot again, which is every change of user or profile, and
  on sign-out), and holds the titles the server listed; a listed title's
  card can still be drawn from this browser's copy of it. Pinned by
  `App.tonight.test.tsx` and `App.profileSwitch.test.tsx`. Of what forgets
  the wait, the switch's call and the signed-out effect are each pinned
  alone (a switch away and back; an expiry on an account with no profile);
  the call in `resetUserState` is not, since after a sign-out the other two
  run as well.
  When the binding cannot be read it shows no profile and opens
  the picker, which cannot be left without a pick, rather than guessing the
  default; if the profile list fails, nothing personalized loads at all. The
  catalog (Home's core rails, the browse grids) and a deep-linked `/title/:id`
  wait for the startup binding too, unless it cannot be read or the list fails
  (`catalogProfileSettled`), so the binding arriving at startup is not a
  switch and resets nothing. Only the latest hero request lands, and a switch
  clears the previous profile's hero. A switch also loads Home cold (its rails
  come down at once, so a slow or failed load shows the skeleton or the error,
  not the old rails), drops the Movies and Shows grids (aborting a Load More
  or a first page in flight) and Continue Watching,
  swaps My Library to the new profile's snapshot, sends an open title back
  through its `/title/:id` hydration, which leaves for Home if the new profile
  may not see it, and remounts search, collections, the calendar and member
  pages (`useOnProfileChange`). Each of these used to keep the previous
  profile's titles: the grids for the session, Home's rails and Continue
  Watching until a refetch succeeded. A search by description (Enter in a
  search field, or the search page's button; it was a "describe a vibe" bar
  on Home with a rail of its own) is the search page's: typing asks the
  server for a title search only (`mode=literal`), and the model-backed
  search (`mode=semantic`) runs once per ask. The ask carries the user and
  profile that made it and is handed to the page only while the app still
  acts as them, so after a switch the remounted page searches the same words
  by title and no model call is made on the new profile's behalf. The answer
  to the last ask is kept (`lib/describedSearch.ts`, one entry, under the
  ask's own key) so that Back from a result shows it again without another
  model call; it is forgotten on sign-out and on a profile switch. The
  server answers a description search with title matches both when it has
  no model and when its description search finds nothing, and says
  "literal" either way, so the page says exactly that and does not call
  them results by description. The search page has its own address: the
  first key typed in the top bar's field, Enter there from another page and
  a request's "Find it" push `/search` once (`showSearchPage`), so Back from
  a result is the results and Back from the results is where the viewer
  was. It used to be drawn over the address the viewer was typing at: Back
  from a result skipped the results and left the words in the bar over
  another page. The words are App state, never in the address (a reload of
  `/search` is the page with nothing typed); they stay in the bar on a
  title, a collection or My requests opened from the results
  (`keepSearch`), and go when the viewer leaves the search page any other
  way (a destination in the bar, Back out of the results), on a sign-out,
  and when the session expires (`resetUserState` and the signed-out effect:
  they used to outlive both, so the next account on the tab found them in
  the bar and had a search run for them). The search effect starts after
  the commit a key lands in, so until the answer for the words in the field
  is in, asked the way they are being asked, the page is searching
  (`settled`, `searching` in `SearchView`): it does not count the last
  answer under the new words, show its failure, or offer anything for it.
  Ctrl or Cmd K puts the focus in the search field (there is no palette;
  `lib/searchKeys.ts` moves the real focus through the results: Left and
  Right in drawn order, Down and Up by row on the page) and does nothing
  from another text field, while a player is up (`playerTarget`, so a
  minimized one too), or while a card's menu, the add-to-list sheet, the
  profile picker, a PIN prompt or any modal dialog is over the page
  (`pageCovered`, which the search page's Escape obeys as well; Escape
  closes the add-to-list sheet, and before any player: the sheet is painted
  above the player). The search page taking its address
  (`showSearchPage`: a key typed, Enter from another page, "Find it") is
  the one change of address that leaves a player on; in practice that is a
  minimized one. Pinned by `App.searchRequest.test.tsx`,
  `App.cardMenu.test.tsx`, `SearchView.test.tsx` and
  `lib/searchKeys.test.ts`, against a memory router and a DOM with no
  layout (the rows are given boxes); a real browser's history and the
  arrow keys on a laid-out page were checked by hand only. Those resets run in passive effects, after the commit that
  already names the new profile, and React could paint that commit: the
  previous profile's hero showed under the new name for a frame. Until they
  run (`profileSwitchPending`), Home, the grids, My Library and an open title
  render their cold state instead. A pick from the picker an unreadable
  binding opens is a switch for all of this, the hero included: the catalog
  behind the picker was fetched under the binding the server does have.
  Home's own library count (the "titles in your library" in the line under
  Tonight's rails; it opened the page, in a greeting, until the greeting was
  removed) waits
  for the startup binding too (`catalogProfileSettled`) and is asked again
  for each profile the session acts as: one request once the startup load
  settles and one per switch (Home's live catalog refresh also asks for it
  beside its catalog rails and sets it under the same key; see Live catalog
  updates), keyed on the user's id, not the user object
  that /me and other tabs' auth signals replace. Only the latest request
  lands (requests from both askers are numbered, and an answer lands only
  if no later-asked one has), and an answer shows only while the app acts as the user and
  profile it was asked for, so a switch's commit shows no count; the
  stored answer is dropped whenever the user's id, the profile or the
  startup settle changes, so a return to a profile, or the same user
  signing in again in the tab, waits for a new answer. It is keyed on the
  profile, not its ceiling: a ceiling changed elsewhere keeps the old
  count until the next switch, sign-in, reload or live catalog refresh, even
  after Home's rails have refreshed under the new one. It was fetched once per sign-in,
  before the binding was read, so a fresh sign-in that bound the default and then
  re-selected the profile this browser last showed counted the default's
  catalog, and a switch kept the previous profile's count. While it is in
  flight, and when it fails, that line falls back to the grid totals,
  which a switch resets (so a switch can briefly show the new profile's
  grid total first). A failed activation (a switch, a PIN unlock, the startup
  re-selection) re-reads the binding, because a lost answer can follow a bind
  that happened. The tab-visibility re-read starts once the startup load
  settles, also runs when another window of the browser records a switch (the
  `storage` event on the remembered profile), and drops an answer once a
  switch has started since the read. The TV re-lists the profiles each time
  its picker opens, shows the server's record of the bound profile (the list's
  copy when that read fails), and stays at the picker until activation
  succeeds, a refused PIN keeps the session's own profile and the page behind
  the picker, and it does not ask for the PIN of the profile the session is
  bound to (the server would accept any digits) or label it locked: an unlock
  lasts the session's life.
- The admin role belongs to the account, but a session acting as a restricted
  profile has none of its powers. The admin routes refuse it with 403
  `profile_restricted` (`refuseRestrictedAdmin`, behind `auth.RequireAdmin`).
  Outside them `adminPowers` decides, failing closed (a scoped token such as a
  cast token, which copies its minter's role, has none): reading other
  members' private collections and editing or deleting theirs, making a
  collection public, any party's reactions, info, highlight reel and QR code,
  other accounts' transcode sessions, every member's media requests (listing
  them, deleting another's, skipping the request quota), the bug-report
  token's health, the event socket's admin-only events (now playing,
  transcode status, server health; the role is fixed when `/ws` connects),
  and the admin alerts (`models.AdminNotificationTypes`: a member's new
  request, with its title, and scan results) in the notification list, its
  unread count and mark-read, and on the event socket, which sends them only
  to admin-role sockets (`Hub.BroadcastToUserAdmins`).
  The admin routes' guard refuses a non-admin and a scoped token itself,
  though `auth.RequireAdmin` and `RequireAuth` ahead of it already do. The
  one exception is an admin account with no unrestricted profile at all
  (`HasUnrestrictedProfile`): profile writes cannot produce one (the last
  unrestricted profile keeps its place, and an account's first profile
  cannot carry a ceiling, `CreateProfileFor`), but older data, a restore or
  hand-written SQL can, and a restricted session cannot
  repair it, so refusing there would leave the account, and on a one-admin
  install the server, with no admin at all. Its restricted sessions keep the
  admin powers. The web app shows its Admin entry, admin controls, scan bar
  and server panel only once the session is known to act as an unrestricted
  profile, or the account has none, or none without a limit
  (`showsAdminUI`); on `/admin` until then it says it is checking, or that it
  could not confirm the profile, and a switch to a restricted one leaves
  `/admin`. What it fetched with admin powers goes when they do: the
  requests list is dropped and collections remount, both waiting until the
  startup profile load settles (`catalogProfileSettled`), as the catalog
  does, and the bug-report token's health is hidden and fetched again.
  An admin's event socket opens only once the startup profile load settles
  (`catalogProfileSettled`) and reopens whenever the session's profile or
  that profile's admin powers change (`useRealtime`'s `connectionKey`): a
  new sign-in binds the default before the startup re-selection moves it,
  so a socket opened then handed a kid's session the admin events. Its
  notification feed is read at the same moments, dropping the previous
  profile's (`useNotificationSeed`, keyed like the socket by `realtimeKey`),
  since a feed read then showed the kid the parent's admin alerts. Anyone
  else's socket and feed open at once and are never reopened; their role
  cannot change.
- This holds only while the session stays restricted. A switch to any
  unlocked unrestricted profile restores every admin power, restore and role
  changes included, so on an admin account each unrestricted profile's PIN
  and the account password are the only barrier; the README still points
  owners to a separate, non-admin account for children as the stronger setup.
- Known gaps:
  - The lock is only as strong as the account password, which unlocks every
    profile and can be guessed through the sign-in and password-change
    routes at about 10 tries a minute per client address each (the profile
    budget does not cover them). The PIN prompt's fields and Settings' PIN
    field ask browsers and the common password managers not to fill or save
    them (`autocomplete="new-password"`, ignore attributes; "off" is ignored
    on password fields), but a password saved on a browser a child uses
    still signs in on the login page, and a browser or manager that ignores
    those hints can still offer it in the prompt, or offer to save what was
    typed there. None of this is tested in a real browser.
  - A switch in the web app does not close a player that is already open.
  - A profile another device edits shows its new name, ceiling and lock in
    an open web tab at the next switch or tab-visibility re-read; until then
    that tab's restricted-session UI (Settings' controls, onboarding's age
    field, the admin UI) follows the old values. The server enforces the
    current ones.
  - A lock protects only the profile it is on. A restricted profile can
    switch to any unlocked profile, including one with a looser limit or
    none; Settings warns about the unlocked profiles whose limit differs
    (it has no rating ladder of its own, so it also lists stricter ones).
  - A lock guards switching into a profile, not changing it: an unrestricted
    session can rename, restrict or delete a locked profile without its PIN,
    and a delete takes the profile's history with it.
  - A pairing grant's session insert rechecks the bound profile's PIN state
    only, not the ceilings: "most restrictive" is judged at approval, up to
    ten minutes before the device collects the grant.
  - Writes outside the management list (a rename or other cosmetic edit, a
    pairing approval, an unlink) do not recheck the session under the lock,
    so one from a session a PIN write ends in between can still land; a
    pairing's bound profile is still rechecked for its PIN when the device
    collects the grant.
  - A re-default, a PIN write or an edit whose profile was deleted meanwhile
    is refused (404; a ceiling edit gets 409 `profile_changed` when the
    deleted profile had a limit, and an edit with nothing to write still
    answers 200 with no profile), but
    an account can still have profiles and no default (the TV creates a
    first profile that is not the default on an account with none; a restore
    or hand-written SQL), and nothing reports it. Its unbound sessions then
    act as an unrestricted stand-in, whatever its profiles' ceilings, until
    one's first progress write creates an unrestricted, unlocked default
    (which linked sign-ins then land on). A linked sign-in picks a real
    profile (`MostRestrictiveProfilePIN`), and so does pairing in its
    no-password, every-profile-locked branch; an unbound approver otherwise
    hands the device an unbound session, the same stand-in, or, when the
    account is re-defaulted before the device collects the grant, the new
    default without its PIN. The web app,
    for a single such profile, shows it without activating it while the
    server acts as the stand-in. A linked sign-in on an account with no
    profile at all inserts an unbound session with no lock or recheck.
  - A password login binds the account default without its PIN: the
    password that signed in stands in for it. A sign-in through a linked
    identity does not (`oauthSignInProfile`): it binds the default only
    while that has no PIN, else the account's most restrictive unlocked
    profile, as pairing does, and with every profile locked it is refused;
    the session insert rechecks that profile's PIN under the account lock.
    An account with no password has no other way in, so there, with every
    profile locked, the sign-in gets the most restrictive profile without
    its PIN, as pairing does. It used to land on the default without its PIN
    whenever the account had no password, so anyone who had linked their own
    identity while on an unlocked profile kept a way past a PIN set later; a
    PIN write leaves linked identities in place, and they now land where any
    linked sign-in does. A link's callback checks that the session whose
    cookies it carries is live and unrestricted (`linkSessionMayManage`),
    since its access token outlives a PIN write, and the identity insert
    rechecks it under the account lock (`AddOAuthIdentityFor`), since the
    check runs before the provider round trip. The sign-in callback's use of
    the helper is pinned through `Callback` with a fake provider: the
    binding, the password refusal, and the no-password landing that needs
    the PIN state carried to the insert. That the insert is the rechecking
    one (`CreateRefreshTokenAtVersion`, against a PIN set mid sign-in) is
    pinned only at the query, not through the callback. The link's recheck
    reads the session row and its profile but not the token version, and a
    revoked row counts as live (`SessionLive`), so a logout or password
    change during the provider round trip still links the identity.
  - An account with no password (OAuth-only) has no recovery for a forgotten
    PIN short of the database. Nor does a password account whose owner has
    forgotten the password while every profile is locked: there is no
    password-reset route, and a linked sign-in is refused there. So does an
    account whose every profile is restricted: nothing on it can lift a
    ceiling or create an unrestricted profile. Writes can no longer produce
    one, but data from before the rule (onboarding on main restricted a
    single-profile account's only profile), a backup restore or hand-written
    SQL can, and nothing reports such accounts.
  - With a provider's invite bypass on (`BypassInviteEnabled`), anyone with
    an account there, a child included, can sign up a separate account with
    no ceiling at all.
  - Admin alerts (`internal/notify`: a member's new media request, with its
    title, and scan completions) go to the admin ACCOUNT; notifications have
    no profile. A session without `adminPowers` is not shown them in the
    list or its unread count (filtered in SQL before LIMIT,
    `notificationShown`), and its mark-read, one or all, leaves them unread,
    so a kid opening the bell cannot clear a new request off the parent's.
    The socket sends them to admin-role sockets only. Web push still
    delivers them to every device the account turned push on for, a kid's
    included: subscriptions belong to the account, not a profile, so push
    cannot be filtered by one, and every push badge counts them. The
    admin-only types are a hand-kept list (`models.AdminNotificationTypes`);
    a new admin-only type left off it reaches a restricted session, and
    nothing checks. A former admin's old alerts are hidden from it too, since
    a user has no admin powers, and its mark-reads leave them unread, so its
    push badges keep counting them until SQL clears them or the account is
    an admin again; shown to it instead, they would be shown to a
    restricted profile on that account. A newly made admin's alerts stay
    hidden until its access token, which carries the role, is refreshed,
    and in the web app until the bell's next read or the socket's next
    reconnect after that. A bell opened before an admin's startup profile
    load settles marks nothing read, and the rows that load while it stays
    open stay unread until it is opened again. Scan progress (with the
    current file name) and library updates go to every socket, whatever its
    role or profile.
  - A restricted session on an admin account is held to the request quota,
    and the new-request alert skips its requester, so on a one-admin install
    a request it has held for approval alerts nobody.
  - An event socket keeps the role it connected with, either way. The web app
    reopens its own when its profile or that profile's admin powers change;
    any other socket on the session (a second device, a switch made
    elsewhere, a hand-opened one) keeps the admin events after a switch to a
    restricted profile until it reconnects. No first-party client reads
    those events (`useRealtime` ignores them), but the browser still
    receives them. The admin alerts follow the same role, and the web app
    does read those: a tab whose socket has not yet reopened after a switch
    to a restricted profile (one made in another tab, until this tab's
    `storage`-triggered re-read lands) shows a new one in the bell and as a
    toast. While an admin's web app socket is closed (until startup
    settles, and for a moment at each reopen) a request status is missed
    live, and so is a notification created after that reopen's feed read
    but before the socket connects; the bell has it on the next load.
  - An admin account with no profile that creates one in Settings keeps
    acting as the server's unrestricted stand-in (the new profile is not
    the default), but the web app then knows a profile and no binding, so
    its admin UI hides until a reload (which falls back to the account's
    only profile, or asks for a pick when there are more); the
    tab-visibility re-read does not restore it.
  - The exception covers an account with no unrestricted profile, not one
    whose unrestricted profile cannot be reached: on an admin account with
    no password, a parent profile whose PIN is forgotten, or kept locked
    out by one wrong guess per 15 minutes (the password is the usual way
    past that, and there is none), leaves the server with no usable admin.
    The README tells owners of such accounts to set a password.
  - Nothing structural stops a future admin route skipping the guard beyond
    a test that `router.go` names `auth.RequireAdmin` only inside
    `requireAdmin`; another file mounting admin routes, a helper wrapping
    `auth.RequireAdmin`, or a handler checking `claims.Role` itself would
    not be seen.
  - In the exception's state, every restricted profile on the account keeps
    the admin powers, a child's included, not only the loosest; nothing
    reports such accounts, and leaving the state takes SQL or a restore
    (the web app cannot lift a ceiling from a restricted session).
  - The admin checks read a ceiling as the ladder enforces it
    (`db.HasCeiling`, which `HasUnrestrictedProfile` applies to each profile
    in Go): blank or any whitespace is none, an unknown value is one. They
    used to read it as SQL's `btrim` does, which strips spaces only, so a
    parent stored with a hand-written tab counted as restricted and the
    kid's session kept the admin powers. The profile-management checks read
    a ceiling more strictly (the handlers' checks any non-empty value, the
    SQL rechecks `btrim`), so a session on a whitespace value, which boot
    rewrites, can use the admin pages but not manage profiles. The write
    guards read the other profiles as the SQL rechecks do, and
    `keepAnUnrestrictedProfile` reads the profile written as the ladder
    does, so such a value never lets through a write the ladder's reading
    would refuse, and a write cannot put the account in the exception's
    state. A spaces-only value on another profile is free to the guards but
    a ceiling to the handlers, so the last other unrestricted profile can be
    limited or deleted beside one, and then no session bound to a profile
    can manage profiles until boot. The web app reads a ceiling as
    JavaScript's trim does, which differs from Go's on two characters
    (U+0085 and U+FEFF) and is looser than the handlers' reading and the
    guards' reading of the other profiles, so for such a value it can show or
    hide admin UI the server refuses or grants, and offer profile, sign-in
    method or onboarding actions the server then refuses (403 or 409).
  - When the startup binding cannot be read, or the profile list fails, the
    startup load settles anyway (waiting would leave the app stuck), so
    collections and the requests list mount, and an admin's socket opens
    and feed is read, under whatever the server has bound: after a fresh
    sign-in, the account default, not the profile this browser last used.
    With the binding unreadable they sit behind the profile picker, which
    covers the page but does not make it inert; a pick drops the requests
    list, remounts collections, and reopens an admin's socket and re-reads
    its feed.
  - A request already past the admin guard completes after a switch to a
    restricted profile (a backup or restore already running, say). `/ws`
    fixes its role when it connects, so a database error then leaves an
    unrestricted admin's socket a user's until it reconnects (closed, and
    no first-party client reads those events).
  - Every admin-route request, and every admin-power check outside them that
    is reached, costs about three queries (the session row, its binding, the
    profile), one more for a restricted session (the exception's check); the
    scan bar's 4-second status poll is the steady one. A highlight reel
    checks membership first and then everyone's ceiling, so a member pays
    about three queries per Range request (four for a restricted profile), a
    non-member admin about six, and a failed membership query is a 500 for
    an admin too.
  - Pinned: the admin routes' refusal through the router and its fail-closed
    and scoped-token cases at the middleware, `adminPowers`' cases, the
    collections list and the socket's role through a request, the
    exception through the router and its predicate against the database
    (`''`, spaces and a tab read as no ceiling and an unknown value as one,
    as the ladder reads them, `TestHasCeiling`; a result cut off mid-read
    and a store that cannot say grant nothing; a ceilinged first profile
    refused; limiting or deleting a tab-stored profile beside only
    restricted ones refused), and the party QR code and the feedback config
    at the handler (`admin_restricted_test.go`, `party_qr_test.go`,
    `queries_unrestricted_profile_test.go`). The other `adminPowers` sites
    are not, nor is the write guards' `btrim` reading of the other profiles
    (read as the ladder does, a guard refuses less), nor are the admin
    guard's readings of whitespace beyond spaces and a tab (a newline, say),
    nor is an admin account with no
    profile through a real database, nor the router's
    wiring of the QR and feedback handlers' store (dropped, an unrestricted
    admin silently loses those two powers). In the SPA, `showsAdminUI`,
    TopNav's use of its `adminUI` prop, the scan bar's hiding, the
    socket's reconnect and the feed's re-read (`useNotificationSeed`) are
    tested; the App wiring (computing `adminUI` and
    passing it to TopNav, the scan bar, the panels, collections and the
    player; the admin view's mount and its notice, the redirect, the detail
    page's admin actions, the socket's and the feed's gate and key, the
    feed's drop of the previous profile's rows and the bell's mark-all-read
    waiting for the feed's gate, collections and the requests list waiting
    for the startup load, dropping the requests list, remounting
    collections, hiding the token's health) has no App-level test. The
    admin alerts are pinned against the database (the list, the count and
    both mark-reads,
    `queries_notifications_test.go`), through the router for an
    unrestricted, a restricted and an exception session, through a `/ws`
    dial with the real dispatcher (`admin_restricted_test.go`), and at the
    dispatcher and the push test's badge (`dispatcher_test.go`,
    `push_handlers_test.go`). Settings still labels the account's role,
    admin included, in a restricted session.
  - Backups carry the argon2 PIN hashes; with 10,000 possible PINs, anyone
    holding a backup can recover them offline.
  - PINs are four digits. With the re-lock above, guessing averages about 50
    days of continuous attempts, assuming no correct entry in between: a
    correct PIN or password from anyone resets the count, and a guesser then
    gets the full five again. Attempts are counted per profile, so N locked
    profiles sharing one PIN cut that time N-fold.
  - Anyone on the account can keep a profile's PIN locked out with one wrong
    guess per 15 minutes; the password is the way past it. An account with
    no password has none: a restricted session can hold the owner out of a
    locked profile for as long as it keeps guessing, and logout, which it
    may call, ends every session on the account, the owner's included; the
    owner's next linked sign-in lands on the most restrictive unlocked
    profile. A restricted
    session can also keep spending the password budget of the profile it
    acts as (and of any unlocked profile it can switch into), so on the
    kid's own device the owner's password can be held off indefinitely. A
    session acting as another profile, or a fresh sign-in, still works. The
    budget is in memory, so it resets on a restart, and its fixed window
    allows two bursts across a window boundary; a spent budget's Retry-After
    gives the whole window, not the time left.
  - A deleted profile's devices keep their still-valid access tokens for up
    to one token lifetime, acting as the account's most restrictive remaining
    profile (ties go to the default, so it is the default when no remaining
    profile is stricter); their
    progress and feedback writes land on that profile. A backup restore can
    leave tokens in the same state.
  - The web app's Settings ("Profiles and parental controls") offers four
    ceilings (none, TV-G, TV-PG, TV-14); any other rating on the ladder is
    set through the API or by onboarding (which writes PG), and is shown
    there as stored.
  - The macOS client cannot switch profiles at all; it uses the session's
    binding.
  - Nothing tests the TV's PIN panel or Back handling on a device. The SPA's
    App wiring (the switcher and the picker going through `switchProfile`,
    `activeProfileId` starting null, the personalized fetches waiting for
    `personalProfileReady`, `catalogProfileSettled`, the hero's
    latest-request guard, the keyed My Library snapshot, and what a switch
    resets: `resetForProfileChange` and its startup exemption, the cold Home
    load, the grid effects' profile dependency and the views' keys, though
    `useOnProfileChange` itself is tested) has no App-level test, except what
    a switch or the startup re-selection shows: `App.profileSwitch.test.tsx`
    switches through the top bar
    and through the picker an unreadable binding opens, and fails if any
    commit puts the new name beside the previous profile's titles on Home,
    the grids, My Library or an open title, or the Parent's grid total in
    the line under Tonight's rails. That pins `profileSwitchPending` and the resets whose
    loss would show something: the hero, Home's rails, Continue Watching,
    a search by description (its results, a request answering after the
    switch, and that the new profile's page asks by title only), the grids, the Movies and Shows
    totals, their Load More aborts and loading flags, their effects'
    profile dependency, an open title and the My Library swap. It also
    fails if Home's own library count shows another profile's catalog on
    any commit after the startup re-selects a remembered profile, after a
    switch through either, or when the previous profile's answer arrives
    after one, if it is asked more than once per profile (/me replacing the
    user object included), or if a switch away and back shows the answer
    from before it. That pins the count's wait for
    `catalogProfileSettled`, its profile dependency, the profile half of its
    key, its dependency on the user's id rather than the user object, the
    drop of a stored answer when its inputs change, and its latest-request
    guard (the abort or the cancelled flag: the stub honours abort, so
    either alone passes). The tests sign in one user, so the key's user
    half and a new request for a new user id are unpinned (a dropped id
    dependency is only an exhaustive-deps warning, which fails no gate).
    Not the grids' next-page resets,
    which the next first page replaces before a Load More can run, nor the
    startup exemption, the hero's latest-request guard or the remounting
    views; and
    the room socket's connect-time profile and its retry
    are pinned only at the manager. The PIN state activation hands its bind is pinned at
    `checkUnlockHash` for every path (`TestTheUnlockReportsThePINStateItJudged`)
    and end to end only for a PIN removed and set again mid-activation; the
    bind's recheck itself is pinned. Most tests that wait on the account
    lock hold it `FOR NO KEY UPDATE`, so weakening any of its takers to `FOR
    KEY SHARE` fails one (activation, a link, each management write, the
    bound session insert, rotation; the last through
    `TestARotationInFlightCannotCarryABindingPastAWrite`), but weakening one
    to `FOR SHARE` fails a test only for the PIN write and
    `keepAnUnrestrictedProfile` (through a delete; a ceiling edit already
    holds its own lock), whose tests hold `FOR SHARE`: a create, a
    re-default, a ceiling edit's own lock, the bound session insert and
    rotation would pass. Unpinned besides: that the no-default re-default
    spares bound sessions, and the edit handler's 404.
    The onboarding age field's lock for a restricted profile
    (`ceilingLocked`) is tested at its patch helper and at the page (the
    field is disabled and nothing about content is written,
    `onboardingFlow.test.tsx`); the server refuses the change regardless.
    Three more rules of that flow, each pinned in `onboardingFlow.test.tsx`
    under the heading named: the limit an age sets is written when setup
    finishes, so every way out that does not finish it (`leave`: the
    header's Skip, "Continue to Aurora" on an empty list, Skip after a
    failed build) asks first when it would leave that limit unset
    (`limitToSet`, `limitLeftUnset`; "leaving without finishing"); picks
    refused under a limit the flow has just written are recognised by the
    refusal's status with that limit in force and confirmed by reading the
    grid again, because the server gives that refusal no code of its own
    (`recoverPicksUnderLimit`; "picks refused under the limit the build has
    just written"); and `main` is inert while the flow is up, and the flow
    is inert under the "Who's watching?" picker or a PIN prompt ("under the
    profile picker", and `App.onboarding.test.tsx` for the app's wiring).
  - Account-level actions still open to a restricted session, for example:
    changing the account password (it needs the current one), approving a
    device pairing (the device binds to the restricted profile, or, when
    that profile has a PIN, to the most restrictive unlocked one, or, on an
    account with no password whose every profile is locked, to the most
    restrictive one without its PIN), follows,
    media requests, collections, watch parties and rooms, notifications,
    feedback and referral answers, push subscriptions, and logout, which
    signs out every session on the account.
  - A session a PIN write ended keeps its still-valid access token for up to
    one token lifetime, acting as the account's most restrictive profile, as
    a deleted profile's sessions do; it can read and write that profile's
    data (and, when no profile on the account is restricted, so that it acts
    as an unrestricted one, other profiles' through the profile-keyed
    routes), but cannot manage profiles, switch profiles, pair a device,
    start, finish or remove a sign-in link, edit the member profile, or use
    the admin pages or powers.
  - A PIN write keeps only the session row its access token names, so a tab
    whose token predates its session's latest rotation ends its own session
    too; it signs in again.
  - Locking a kid's own profile signs out the kid's devices; signing one
    back in lands on the default, and the web app does not re-select the
    now-locked profile, so someone picks it with its PIN.
  - Nothing bounds concurrent argon2 checks server-wide (64 MiB each): one
    account can burst about five per locked profile, plus five per account
    and acting profile for the password.
  - The room socket keeps the profile it resolved at connect, ceiling
    included, so a switch made while it is open, or a change to that profile's
    ceiling, applies to its ceiling check from the next connect. Sockets
    (party room, party sync, `/ws`) also stay open after a PIN write, a
    profile delete or a logout ends their session, so a device left on the
    parent's profile keeps the parent's ceiling for change-media on an open
    room socket after the parent locks that profile, until it reconnects.
  - Switching the SPA to a restricted profile while it casts: the cast's
    later progress writes keep the outgoing profile, as the playback contract
    requires, so the server refuses them (403 `profile_restricted`) and the
    receiver's last position is lost, with a "could not save" toast on
    completion. The TV waits for the final save before activating; the SPA
    does not.
  - The same holds without casting: web tabs share one session, so when one
    tab switches it to a restricted profile, another tab's ongoing playback
    keeps writing progress for the outgoing profile and is refused.
  - The SPA does not re-read the session's profile after a 403
    `profile_restricted` on a data route.
  - A session that expires (`SESSION_EXPIRED_EVENT`) signs the tab out with
    a bare `setUser(false)`; `resetUserState` does not run. On an account
    with profiles the profile going to null runs the switch's resets. While
    the app knows no profile for the account (a new account before its
    first progress write, or a tab that has not listed the profiles since)
    nothing does, beyond Home's rails (`railsUserRef`), the notification
    count, the search field's words, the toasts, and Tonight's hero,
    Continue Watching and wait (the signed-out effects). What else App keeps for the previous user on that path (the
    browse grids and their totals, an open title) has not been audited: the
    next sign-in on the tab may be shown it until its own answers land. The
    grids' totals are not kept per owner. What reads them: a grid's count
    in the Library header and in the Filters sheet's "Show N movies"
    button, the layout a grid opens with and whether it has an A to Z strip
    (both by size), and Tonight's closing line, which falls back to them
    while Home's own count has not answered.

### Member profiles and follows

- Watch-history sharing is opt-in and rechecked on every read. Shared history
  uses only the account's default profile and completed rows.
- Follow feeds apply the viewing profile's parental ceiling, where the viewing
  profile is the session's acting profile or an owned `?profile_id=` it may
  name (`resolveRequestProfile`; see Parental rating ceiling).
- A member page's watch strip applies the viewing session's ceiling, and a
  session acting as a restricted non-default profile gets no strip on its own
  account's page: that history is the default profile's.
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
- In the web app the caller's invitation list (`hooks/usePartyInvites.ts`:
  the bell's rows, Tonight's live strip, the Together page) is stored with
  the user and acting profile it was asked for and given out to no other,
  and an answer for an owner that is no longer current is dropped. A profile
  switch is bound on the server before the app shows it, and for that moment
  the server answers for the new profile under the old one's name, so the
  list is also held to the live catalog refresh's rule (see Live catalog
  updates): no request starts while a switch or its PIN prompt is out, an
  answer is dropped when one is out or has started since it was asked for,
  and what was held back or dropped is asked for again when a switch ends,
  the one that ends on the profile already shown included (App counts the
  end of every switch made through its UI, `switchProfileWatched`). The
  "is out" half of the drop is covered by the "started since" half and by
  the start guard, as in the catalog refresh, so deleting it fails no test;
  it is kept in case the flag is ever set without a generation bump. Pinned
  by `usePartyInvites.test.tsx` and `App.invites.test.tsx` (a delayed
  activation from a restricted profile into an unrestricted one, every
  commit sampled). Not covered: a switch made only in another tab, which
  this tab's flag and counter do not see, until its `storage` or visibility
  re-read moves this tab; and a session moved by the startup re-selection,
  which is not a switch.
- A show's party needs an episode (`lib/partyEpisode.ts`): one created with
  none cannot be joined once it is playing. "Where a show starts" has one
  definition for a card's Play and "Watch together", the title page and the
  prewarm: the resume episode, else the earliest episode with a file, the
  regular seasons in order and the Specials (season 0) last. The title page
  opens on the season that walk ends in when nothing is in progress, so what
  it lists, what its Play starts and what its party opens on agree, also
  when the first regular season's files are gone; and when the viewer has
  moved the page to a season with nothing to play, its party is sent
  through the card's lookup rather than created with no episode. Play says
  so when it starts later than the first episode (`startsLaterNotice`).
  Known gap: a show with nothing to play anywhere reads every season before
  Play fails, and its party is still created with no episode.

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
- A remux's media time 0 is the key frame before `start_sec`
  (`-noaccurate_seek`; for demuxers without `AVFMT_SEEK_TO_PTS` — Matroska,
  MPEG-TS, AVI — with B-frames, a whole GOP earlier when the target sits within
  130 ms after a key frame). The variant playlist carries the measured start as
  the comment `#AURORA-MEDIA-START:<sec>` right before the first `#EXTINF`
  (`media_start.go`; never in the header, where hls.js files it on the fMP4
  init segment). It is measured once per session in the background, retried
  only inside the first playlist request (2.5 s budget, no lock held across
  ffprobe), and published only within `[start_sec - 60, start_sec + 1]`.
- The SPA's `startSecRef` is that media-clock origin, owned by the session's
  `RemuxClock` (`lib/mediaStart.ts`); `sessionStartSecRef` keeps the
  whole-second `start_sec` for the subtitle `start=` (an `Atoi`) and the
  receiver fallback. The clock adopts a start only before the element has
  played (a later one is refused, keeping `start_sec`); aligns to `start_sec`
  only with a reload of runway, retried on later loads while the playhead is
  short of it, never after a scrub; consumes the alignment's own `seeked` by
  position; and makes an unaligned party host send one seek with its true
  position once playback runs with the room running. A party guest is aligned
  instead to the room's projected position, under the same runway rule and
  only before it plays; once it has played, without runway, or while an
  explicit seek is pending, the drift loop and the seek handling own its
  position, and it sends nothing. Until a remux's first level load (natively,
  until its one fetch has been applied at `loadedmetadata` or has failed; the
  element's `progress`/`durationchange` retries attach only after it is
  applied, since any window reaching the clock ends the hold), a guest leaves
  explicit seeks and drift corrections unjudged when the room position is at
  or after `start_sec - 60` (`holdsPartyPosition`, at most 4 s), so a host's
  re-anchor into the key-frame gap is served in the window instead of
  rebuilding a still-booting guest. Native HLS fetches the variant playlist
  once and applies it at `loadedmetadata`, failing safe to `start_sec`.
  Transcodes and the Android TV client still anchor on `start_sec`.
- Sidecar subtitle cue shift (`ServeSubtitle`, `subtitleCueShift`): a
  transcode shifts by `start_sec`; a remux by `media_start=`, the measured
  start the web player sends beside `start=<start_sec>&remux=1`
  (`subtitleCueShiftQuery`), taken only as a plain decimal inside the
  publication window (`ParseClientMediaStart`); otherwise by the
  `ProbeSeekKeyframe` prediction, as before. A `media_start=` shift is the
  client's choice, so it is built in memory per request and never written to
  the subtitle cache (`ServeShiftedSubtitle`, with the file path's headers).
  A revalidation is a 304 that builds nothing and takes no budget
  (`http.ServeContent`'s own precondition check, run first). Any other request
  is charged its body's worst case, 1.5x its source plus 64 bytes
  (`InMemoryShiftBodyBound`, also the buffer it is built in), against a 64 MB
  budget from before the build until its send ends (`InMemoryShiftBudgetBytes`),
  and is sent under a two-minute write deadline. At most four rewrites run at
  once: a request waits for a slot until its context ends, holding its charge,
  and the slot is freed once the body is built. Sources are capped at 8 MB
  (`MaxInMemoryShiftSourceBytes`), and the read takes no more than the stat
  said. Whatever stops the shift (the cap, a full budget, an unreadable source)
  does so before anything is written, and the prediction is used, through the
  cache: logged once per track for the cap, once a minute for the budget. A
  client that leaves while waiting for a slot gets a 503. A measured start at
  or before 0 is no shift: the source is served as is.
  The server-derived shifts keep one cached file per (track, offset), and
  the extracted track is cached either way. The native path gives its
  variant fetch 8 s (`NATIVE_MEDIA_WINDOW_TIMEOUT_MS`), then fails safe as
  for a failed fetch. The player sends the measured start whether its clock adopted or
  refused it (`measuredStartSec`: cues are timed on the element). Until a
  boot knows its delivery (stream info, the session create, and for direct
  play on WebKit the AirPlay token mint) a pick is only recorded; the boot's
  restore reads the latest pick when the delivery can take it, so one made
  during the boot, Off included, wins over the pick the boot began with. Only
  the active `<track>`'s `error` rolls the pick back: one a boot or a later
  pick removed is ignored. A remux pick (the restore included) is then held
  while the clock awaits its first level load (natively, until the fetched
  result is applied at `loadedmetadata` or the fetch fails), and its
  `<track>` created once that settles. A restore keeps a `<track>` the boot
  already built, turning it back on after the restore's own disable, so each
  pick is requested once per boot.
- Known gaps: the native-HLS path is NOT verified on a real Safari or iPhone,
  and it assumes Safari's media time 0 is the first segment's start, as
  hls.js's is (unverified); older clients and a remux whose playlist reported
  no start still get the `ProbeSeekKeyframe` subtitle shift, a GOP off on the
  Matroska key-frame case, and so does a track created before a start that
  arrives late; a held pick waits for local loading, which a boot while
  casting does not start and a cast that connects during the hold stops
  (`stopLoad`); a `media_start=` shift is paid on every non-304 request
  (about 2 µs of CPU per cue: per MB ~20 ms for ordinary cues, ~50 ms for
  one-syllable karaoke cues and ~100 ms for timing lines alone, allocating 4
  to 15 times the source, mostly short-lived; up to ~0.85 s a request at the
  cap; `BenchmarkShiftedVTT`), where a cached shift was paid once per track
  and offset; a full budget (five clients not reading tracks at the cap, or
  forty-odd not reading ordinary ones, each for up to the two-minute send
  deadline) sends every other `media_start=` request to the GOP-off
  prediction until they finish, and so does a source above 8 MB; a
  native-HLS server slower than 8 s to its first variant playlist leaves that
  session's clock and subtitles on start_sec and the prediction; after the
  unreadable-playlist resume fallback the
  cached start describes segment 0 of a playlist that no longer lists it; a
  measurement that lands after the first request's budget reaches only
  players that have not started.
- Known party gaps: a host whose own measurement failed (no line in its first
  playlist, or a start refused as late) never adopts the measured start, so
  `hostReanchorSec` returns null and the room keeps the original key-frame
  offset whenever its guests did measure. On a host transfer, a new host
  whose clock measured a start but that, as a guest, neither aligned nor
  applied a party seek can send one stray re-anchor to its own position when
  it is mid rate-adjust (more than 0.5 s off) or its tick is stale. The
  guest's hold delays a seek that needs a rebuild anyway by up to its first
  level load (4 s at most). The pre-play alignment uses the room's position
  at the level load; boot latency after it is the drift loop's, as before. A
  party mixing old and new SPA bundles disagrees by the gap until everyone
  reloads: an old bundle still reads media time 0 as `start_sec`.
- Known gap: an HLS quality up-switch can still stall because new rungs start at
  the current absolute source position and no cross-rendition produced-edge
  contract exists.

### Auto-updater: what a deploy must prove

`scripts/aurora-update.sh`; runbook `docs/updater-recovery.md`; tests
`scripts/aurora-update-test.py` (they model the running process, not just
count restarts).

- Both halves are built from `git archive` of the target into
  `/var/lib/aurora-updater/build`, never from the checkout, whose tracked-only
  cleanliness check lets untracked or ignored files through. A target without
  the SPA source fails; there is no fallback to a leftover `static/v2`.
- The drain and the model pull run before any live file changes, so the old
  backend never serves the new frontend while it waits.
- A deploy counts only when the main pid right after the restart is still the
  main pid throughout (any change fails at once), its `/proc/<pid>/exe` hashes
  to the binary just built, `/api/health` says `status: ok` with
  `db_connected: true`, and `/v2/` is byte-identical to the installed
  `index.html` (`TestV2IndexIsServedByteForByte`), on two probes at least
  `VERIFY_SETTLE` seconds apart, within `VERIFY_TIMEOUT + VERIFY_SETTLE`
  seconds. Everything but a pid change is retried until then, including an exe
  mismatch: `Type=simple` reports the unit started before the child execs, and
  `/proc/<pid>/exe` is systemd's executor until it does. The anonymous health
  route still names no version. Root's Python runs with `-I` (the working
  directory is the checkout) and must run on 3.6 (RHEL 8, SLES 15): one
  `str.isascii()` failed every probe there. `test_embedded_python_runs_on_python_3_6`
  is a partial guard: it parses each embedded program with the oldest grammar
  `ast` still offers (3.7 on current Pythons, so 3.8 forms like `f"{x=}"` pass)
  and rejects a list of newer APIs; nothing in CI runs them on a real 3.6. A
  review ran the suite with PyPy 3.6 as the embedded `python3`; it passed. Root's
  curl runs with `-q` first (no `~/.curlrc`: a `-w` there changed the compared
  bytes). The
  served `/v2/` is compared with root's copies (the build output; the rollback
  snapshot), not the aurora-owned live file. A verification that fails takes
  up to about 100 s (the deadline is checked between probes of up to ~11 s).
- The port is always one that pid listens on, read from `/proc/<pid>/fd` and its
  TCP tables, so the answer comes from that process. How to speak to it comes
  from `/var/cache/aurora/serving.json` (`cmd/aurora/serving_record.go`, written
  after migrations and the bind) when the record names that pid and port, else
  from `TLS_*` in `aurora.env`; the port is then `AURORA_PORT`, else the pid's
  only listener, else 8484. `TestServingRecordContractMatchesUpdater` pins the
  path and keys on both sides.
- `/var/lib/aurora` is `root:root 0755` (the source mirror lives there): the
  server cannot write it, which is why the record and the drain snapshot
  (`stream-state.json`, which silently never existed there) are in
  `/var/cache/aurora`. That directory is the aurora user's, so root reads both
  with `read_untrusted` / `O_NOFOLLOW|O_NONBLOCK`, regular files only, capped.
- Leaving in phase `files` or `restarted` for any reason rolls back the binary,
  static tree and migration files and verifies the restored service; it hangs
  off the EXIT trap because the ERR trap does not run inside functions. The
  database is not rolled back. Past `verified`, failures keep the new release.
  Restored static files are touched: the server answers conditional requests
  from Last-Modified alone, and the snapshot's old mtimes would let a browser
  keep the failed release's `index.html` (a blank page).
- The SPA stamps a hash of the bundle, `public/` and the page as
  `<meta name="aurora-build">` (`vite-build-id.ts`); `lib/buildUpdate.ts`
  re-reads `/v2/` and shows a Reload notice (withdrawn when this tab's build is
  served again), never reloading by itself. `verify-pwa.mjs` checks it end to
  end under the production CSP. The notice lives outside the app's error
  boundary (`AppRoot.tsx`, pinned by `AppRoot.test.tsx`): when a deleted chunk
  takes the app down, the boundary asks for a check that only a still-mounted
  notice can answer.
- Known gaps: an install on a non-default port or terminating its own TLS gets
  this updater only through the manual bootstrap in `docs/updater-recovery.md`
  (the old one on the box never passes its own check, so never replaces
  itself); idle ticks check installed files, not the running process; TLS is
  probed with `--insecure`; bash before 5.1 writes heredocs to TMPDIR, so a full
  TMPDIR fails `service_endpoint` (and every status write); a crash more than `VERIFY_SETTLE` seconds after the
  first good answer is not seen; a SIGKILL mid-install still leaves a partial
  tree (the pending record blocks automatic retry); a rollback generation kept
  from an older updater has no migration snapshot, and a rollback to a binary
  that writes no record falls back to `aurora.env` for TLS; a migration longer
  than the window can never deploy; the Node gate reads the checkout before the
  merge; the unit's `TimeoutStartSec` is now 20 min and `TimeoutStopSec` 5 min
  (a rollback ignores TERM/INT/HUP and can need ~2 min), but units change only
  when `install.sh` or `redeploy.sh` reinstalls them, so an existing box keeps
  10 min and the 90 s default until then; a box whose build always outlasts the
  timeout while viewers are always present never deploys (the status stays at
  "Waiting…"); the drain counts any ffmpeg the aurora user runs (the
  skip-marker worker too); tabs opened on a build from before the build id
  carry none, so they are not told about the first deploy of it; a rollback
  generation kept from a failed updater run can be older than what
  `install.sh` or `redeploy.sh` installed since (neither touches `pending` or
  `rollback/`), so a later failed run can roll back past them; a rollback while
  the updater's own unit is deactivating queues aurora's restart (`--no-block`:
  under `systemctl stop`/`restart` a blocking one waits on that stop job,
  ordered `After=aurora.service`; after a start timeout it would not, but is
  queued too) and reports it unverified, or a failure when the queue is refused
  (a shutdown) or the restore had problems; a stop that arrives while the
  rollback's blocking restart is already running still waits until SIGKILL
  (`TimeoutStopSec`, 5 min), aurora down meanwhile; the next tick's "earlier
  install did not finish" status replaces whatever the rollback reported; `git archive` would honour
  an `export-ignore` a target's `.gitattributes` added (there is none); between
  the static swap and the restart, seconds in every script, the old backend
  serves the new `index.html`, so a tab checking then is told of the update
  early; diffutils is not needed (verification hashes, it does not `cmp`); `install.sh` (prebuilt-bundle fallback) and `redeploy.sh`
  (`--skip-npm`) can still install a bundle not built from the code beside it,
  and both keep their `:8484` health checks.
- The viewer drain is one `AURORA-DRAIN` block, identical in
  `aurora-update.sh`, `install.sh` and `redeploy.sh`
  (`scripts/drain-gate-test.sh` checks the copies, the hostile-file cases, that
  it reads the path `DefaultStreamStateFile` writes, and that each script waits
  before its first live change). `install.sh` re-runs and `redeploy.sh` used not
  to wait at all; they skip with `AURORA_SKIP_DRAIN=1` / `--no-drain`, and when
  the service is not running. `install.sh` stages and swaps its release files
  (binary, migrations, frontend) in `install_release_files`, on the line after
  the wait and right before the restart, nothing slow (prompts, Ollama) between
  them; config, units and the updater script still change earlier. It holds
  the deploy lock from the final `chown` and the timer start (a timer whose
  `OnBootSec` has passed fires the moment it starts, and that run would
  otherwise take the lock first and deploy) until the restart's health loop
  ends (30 tries at `:8484` of up to 5 s each: ~30 s normally, ~3 min at
  worst), and not longer: a daemon a child
  starts would inherit the descriptor. The source-mirror fetch earlier in
  install.sh still runs unlocked. Interrupts (and HUP, PIPE) are ignored from
  staging to the restart, and exit the script otherwise; output there is
  non-fatal. The updater removes only staging it created (`STAGED_RELEASE`);
  an idle tick used to delete an install.sh re-run's staged frontend. The block reads
  numbers with `10#` and a length cap: the aurora user writes the snapshot, and
  an invalid-octal timestamp used to abort the updater under `set -e`.

### Node build floor

- Install/update scripts distinguish an impossible build from an unsupported
  but potentially working Node release and report failures before fetching.
- The gate applies only when building the SPA from source. install.sh still
  reuses a prebuilt `static/v2` when the source tree is absent (it is gitignored,
  so never committed); the auto-updater has no such fallback.
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
  checks, or known-answer probes, as appropriate. The script uses no
  here-strings or heredocs: bash before 5.1, and any bash under
  `BASH_COMPAT=50`, writes every one to a file in TMPDIR (5.1 and later,
  one larger than the 64 KiB pipe buffer), and a full TMPDIR made a loop
  silently run zero times (exit 0). Loops take a `for` over ids (split
  once, with globbing off) or a process substitution. The ids loop and the
  roots loop are counted against what there is to read, since a process
  substitution fails without `/proc` and a stdin-reading command in the
  roots loop swallows the rest; the find loop is not counted, so a
  stdin-reading tool inside it can still cut the walk short (follow-up).
  Case 57 reruns four fixtures under `BASH_COMPAT=50` with every write
  failing.
- Answers must not depend on GNU coreutils versus uutils (Ubuntu 26.04's
  default `coreutils`). Three forms were measured to differ. `realpath -m`
  through a symlink loop fails under uutils; `classify_root` no longer calls
  it, walking a link's target as written, so a loop meets its depth cap and
  a `..` is resolved by the kernel, never lexically. `realpath -e` past a
  non-directory (`a.mkv/.`, `a.mkv/..`, or `a.mkv/` from a link's target; a
  FIFO likewise) fails under GNU with ENOTDIR and resolves under uutils;
  both of its call sites test `[ -e ]` first, so it only sees paths the
  kernel resolves. uutils `comm` (0.8.0 and 0.10.0, measured) rejects
  byte-sorted input where one path is another followed by a byte
  0x01-0x09 (`a.mkv` beside `a.mkv<TAB>.mkv`) and exits 1; its status is
  checked, so that is exit 2, and `--nocheck-order` is not to be added.
  The suite pins the first two with fakes on `PATH`.
- `classify_root` calls a missing component absent only when the kernel
  says why and the answer is ENOENT or ENOTDIR (asked with `builtin cd -P`
  in the C locale; a trailing slash after an executable non-directory too,
  while a non-executable one is blocked by the walk's `-x` test). EACCES
  from a filesystem that refuses this user under a searchable parent
  (FUSE without `allow_other`), ENAMETOOLONG and every other error are
  blocked. A video-named link the kernel refuses is skipped
  only when `classify_root` calls it absent; otherwise it is recorded as
  unresolved, and a library whose walk finds nothing else exits 2 (the
  kernel stops at 40 links and at this user's permissions, the scanner at
  255 links and the service user's). `find` emits in the filesystem's
  readdir order (tmpfs listed newest first on Linux 6.18), so a fixture
  that needs an order must assert it.
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

### Live catalog updates

New titles reach open web apps without a reload. Code:
`internal/api/library_updates.go`, SPA `lib/catalogUpdates.ts` and
`hooks/useCatalogVersion.ts`.

- `library_update` has one sender, `LibraryUpdates`, made per scan at every
  scan entry point: `TestLibraryUpdateHasOneSender` fails on another sender
  and `TestEveryScanFeedsLibraryUpdates` on a `ScanLibrary` callback that
  does not call `Observe`. It sends `items_added` while a scan adds files (the
  first at once, then at most every 10 s), `scan_completed` when a scan that
  added files completes (after the deferred TV enrichment), and
  `retype_rescan_completed` when a retype's rescan completes, whatever it
  added (a cancelled or failed scan sends no completion). Every socket gets
  it; it names the library and a file count, never a title.
- The SPA coalesces events (1.5 s plus up to 3 s of jitter, so tabs do not
  refetch in step) into `catalogVersion`, at most one bump per 10 s per tab
  whatever the server sends, held while the tab is hidden or the player is
  open (not minimized), plus one after a socket reconnect and one at an
  admin's scan-bar completion edge (which covers removal-only scans; it used
  to run the full Home reload). Each view records the version its data
  reflects and refetches when on screen and behind, one refresh at a time (an
  update mid-refresh re-runs it after it lands instead of aborting it, which
  starved refreshes on a busy server), abandoned after 30 s
  (`LIVE_REFRESH_TIMEOUT_MS`) so a hung request cannot stop a view's updates,
  and catches up when next shown:
  - Home refetches only its three catalog rails and its library count,
    recomposed under the personalized rails; never Continue Watching or the
    personalized rails, and the catalog's stand-in hero only when none is
    recorded (a first import into an empty library; the stand-in is what the
    hero shows when there is neither a title to resume nor a pick, and is
    never one of the picks). Running the full Home load per update
    reset the hero carousel every ten seconds. Every catalog-rails fetch (the
    full load's and the live refresh's) takes a number when it starts
    (`homeRailsSeqRef`), and its rails land only if no later-started fetch's
    have, so neither puts back rails that missed titles the other saw. The
    full load records the version it started at, so an update during it is
    caught up once its rails land. A live refresh whose rails are dropped
    that way checks again (`homeRefreshRetry`: a recompose can set the very
    array on screen and re-run nothing), so Home is not left a version
    behind. The count's own effect asks once per user and profile, and only
    the live refresh keeps it current (a full load does not ask), so it is
    tracked apart (`homeCountVersionRef`, the version it was last ASKED at,
    recorded when a request starts and put back when a switch drops that
    request's answer) and a refresh also runs when the count alone is
    behind. Recorded when an answer landed instead, a count request that
    kept failing ran a full refresh per recompose in a tight loop; a failed
    count now waits for the next update, unless a switch drops its refresh.
    Its requests are numbered across its own effect and this refresh, so an
    older answer landing last cannot put an older count back.
    A full load does not abort a live refresh. The refresh runs only under
    rails the current user and profile already have up, is aborted by a
    user, profile or settle change, stands down on a switch's first commit
    (`profileSwitchPending`), and is checked against the rails' owner when it
    lands; a switch clears that owner until the new profile's rails land, so
    the check holds on its own. No refresh starts while a switch or a PIN
    prompt is out (`isSwitching`, the start guard), and an answer that comes
    back while one is out, or once one has started since it was asked
    (`switchGeneration`), is dropped: the server may have answered it for a
    profile other than the one still named, either one a switch has bound that
    this tab does not show yet, or one bound in between by a switch that then
    ended on the profile already shown (another tab binding that back before
    this tab read the binding). Landing after such a switch has ended, it is
    dropped by the `switchGeneration` half alone: nothing is switching, no
    commit names a new profile, and, on Home, the rails' owner still matches.
    Since no refresh starts during a switch, one out during a switch began
    before it, so that half also drops everything the `isSwitching` half does;
    deleting the `isSwitching` half fails no test, and it is kept by choice, in
    case the flag is ever set without a generation bump. Where a switch changes
    the profile shown, the drop adds nothing once `isSwitching` is false: an
    answer gets past `isSwitching` only after `setActiveProfileId`, so it lands
    in the commit naming the new profile, which `profileSwitchPending` renders
    cold, or between that commit and its effects, whose resets then overwrite
    it (checked by hand with the `switchGeneration` half deleted; no test pins
    it); later, the refresh has been aborted, and the new profile's load fills
    the view. Where the profile shown stays and nothing was bound in between (a
    cancelled prompt), it drops an answer that was right. An answer that lands,
    and is dropped, after a switch that ended on the profile already shown is
    re-checked at once (`homeRefreshRetry`, `gridRefreshRetry`; a refresh the
    re-run starts records the current generation, so it cannot loop). One
    dropped while a switch was out (the re-run normally returns at the start
    guard), or a refresh the start guard kept from starting, waits for the
    prompt to close (`pinTarget`) or the new profile's load; after a switch
    with no PIN prompt that fails and stays on the profile shown, or whose
    binding read returns that profile, nothing re-checks it until something
    else re-runs the refresh (see the known gaps). A re-check starts a refresh
    only while the rails or the count is behind (and then asks for both). The
    dropped refresh had recorded Home's library count as asked
    (`homeCountVersionRef`), so the drop puts it back to the version it was
    asked at before, unless a later request has asked for it since; left as
    asked, once the rails had caught up to that version (a full load from it,
    or only the count behind), a re-check asked for nothing and the count
    stayed stale until the next update. The grids drop and re-check the same
    way; they record their version only when an answer lands, so a dropped one
    leaves them behind.
  - A grid refetches every loaded page, three at a time, and swaps them in
    without blanking; a Load More, an admin delete and a user, profile, sort or
    genre change abort it, and it stands down on a switch's first commit. A
    grid deeper than 5 pages is left stale rather than refetched or dropped.
    A grid has no featured band (the hero is Tonight's alone), so a refresh
    has no title at the top of the page to swap: its name, count, sort,
    layout and genres are in the Library header, which App renders above
    the grid and keeps mounted while the grid reloads, and nothing on the
    page rotates (`BrowseView.header.test.tsx`).
    Under the title sort, a grid whose whole list fits in the pages a grid
    keeps live (`CATALOG_REFRESH_MAX_PAGES`, read by `fitsInPages` in
    `lib/letterJump.ts`) has an A to Z strip; a longer list has none, and
    nothing in its place. The server has no request for "titles from M", so
    a letter with no loaded title is reached by asking for the pages that
    are left, in order, with the requests Load More makes
    (`hooks/useLetterJump.ts`): a few at most, never one past the last, and
    the grid is still live-refreshed afterwards. A jump is dropped when its
    list goes (another sort or genre, a profile switch, leaving the page),
    and stops when a page does not come. Nothing is read into the order the
    server lists titles in (its collation follows the machine's locale): a
    letter is on when a loaded title files under it, one not seen yet may
    still be further on until the whole list is loaded, after which the
    letters are exact, and a jump goes to the first title in the list as it
    is that files under the letter. Load More, and so a jump, stands down
    while a profile switch is out and drops an answer if one has started
    since it was asked, as the live refresh does (the start guard is pinned
    on both grids in `App.profileSwitch.test.tsx`; the drop is not, beyond
    what the switch's own abort already covers) (`App.library.test.tsx`).
  - The admin dashboard refetches its counts while its tab shows.
  - Home's rail buffers carry their owner (`railsUserRef`, `railsProfileRef`)
    and the titles removed for that owner (`removedFromHomeRef`, from a 👎 or
    an admin delete, replaced on an owner change and undone by a 👍), so a
    recompose shows neither another owner's catalog or anchor rails nor a
    removed card (a 👎'd title so stays off Home's catalog rails too). Not a
    Discover answer still out across an owner change: `refetchDiscover`
    splices it with no owner check (it predates this).
  Pinned by `App.liveCatalog.test.tsx` (a live refresh held across a profile
  switch on Home and on a grid, where Home's test fails only when its abort,
  the `switchGeneration` half, the owner check and the drop of rails older than
  a later-started fetch are all gone, and the grid's only when both its abort
  and its `switchGeneration` half are, one released before the new profile's
  rails land, which fails only when the abort, the owner clearing and the
  `switchGeneration` half are all gone, an update during Home's first load, a
  first import's hero, a full load and a live refresh landing in either order
  with commits sampled, a refresh started before a full load landing after it,
  the count catching up when the refresh that carried it had its rails dropped
  for a full load that landed first, and when a switch dropped it after a full
  load from its version had landed (without the count put back, the old count
  stays), one refresh, not a loop, when only the count fails, and, on Home and
  the Movies grid, a refresh the server answers for Kid while a no-PIN switch
  to Kid is out (delivered before the switch ends, it is dropped, and the test
  fails only with both halves of the drop deleted; delivered after another tab
  bound Parent back before this tab's binding read, it is dropped by
  `switchGeneration` alone and asked again under Parent, and without
  `switchGeneration` Kid's titles show under Parent's name) and a refresh out
  during a PIN prompt (landing while the prompt is open, dropped, with no
  request until it is cancelled and exactly one after, where without the start
  guard one dropped refresh ran over a hundred more a second; landing after the
  prompt was cancelled, dropped though it was right and asked again exactly
  once, so deleting `switchGeneration` fails that case only by the one
  request)), `AdminView.catalog.test.tsx` and the hook and helper tests.
- Known gaps: mid-scan, a new show has its folder title and no artwork until
  the completion event; files found in a scan's last seconds wait for the
  completion event, which for TV follows the deferred metadata pass; scans
  that only remove titles, the recovery sweep, and background metadata
  refreshes send nothing; genre lists are not refreshed; a title crossing a
  page boundary between a grid's page requests is missed until the next
  refresh, and Load More during an import can append a duplicate; a grid
  deeper than 5 pages never live-updates; a failed refresh leaves its view
  stale until the next update or showing; `onReconnect` does not fire when an
  admin's socket reopens for a new profile, so an event in that gap is missed;
  after a deploy every visible tab refetches its view as it reconnects, and a
  socket the hub drops for a full send buffer refetches on every reconnect;
  the one-at-a-time and Load More interplay, the reset of Home's buffers on
  sign-out, the count's numbering, an answer landing between the end of a
  switch that changes the profile shown and the effects of its commit
  (where the drop adds nothing, see above), the Shows grid's switch
  handling (line for line the Movies grid's code, pinned as listed above),
  the full load's fallback-hero gate, the count effect's ask-time version and
  the switch drop's check for a later count request (defensive: the count's own
  effect re-runs only on a change that aborts the refresh first) have no test,
  and the full load's guard is pinned against removal but not as a sequence
  rather than a version check (the equal-version case it adds is not reached by
  the current triggers); a switch with no PIN prompt that fails and stays on
  the profile shown, or a switch with no PIN prompt whose binding read returns
  the profile already shown (another tab raced it), runs nothing again, so a
  refresh the start guard refused during it, or one dropped while it was out,
  leaves the view behind until something else re-runs the refresh, such as the
  next update or showing (on Home also a full Home load, a recompose that
  changes the rails, a 👎 or an admin delete; on a grid a Load More, a sort or
  genre change or an admin delete); when a no-PIN switch that failed did bind
  (its answer lost) and its binding read failed too, the tab stays on the old
  profile while the server acts as the new one, and a refresh dropped after it
  is re-checked and, when behind, asked again under the new binding, so the new
  profile's titles show under the old name until the tab-visibility re-read, as
  does any later request's answer (the dropped answer may have been the old
  profile's, if the server answered it before the bind); a switch made only in
  another tab is seen by neither half of the drop, so a refresh the server
  answered for it lands under this tab's profile until the `storage` or
  visibility re-read moves this tab; a count request that fails is asked again
  only at the next update, switch, sign-in or reload (neither a Home visit nor
  the 30 s full load asks for it), or at the re-check after a switch drops the
  refresh that asked for it, and when only the count was behind, a failed rail
  request discards a count answer that succeeded; a first import's fallback
  hero is picked by the first live refresh and not replaced, so a show picked
  before its enrichment stays bare (no backdrop or overview) until a full Home
  load (returning or refocusing after 30 s) or a reload, and the live refresh
  does not ask for the personalized hero pool again (a full Home load does);
  the dashboard's side cards read at mount can land after, and overwrite, a
  refresh's newer numbers; the macOS and TV clients ignore the event.

### Signed out, toasts and My Library writes (web app)

Code: `components/AuthView.tsx`, `components/Toast.tsx`, App's
`changeLibrary` / `writeLibrary` / `restoreToLib`, `lib/libraryUndo.ts`,
`lib/devicePairing.ts`.

- The sign-in page's wall of frames and its form sit on one line and never
  wrap; the wall is drawn only from 980px (its 560px and the form column's
  420px). Wrapping, with the wall drawn from 900px, put the wall alone on the
  first line from 900 to 979px and the form a whole screen down.
  `scripts/verify-signed-out.mjs` renders both signed-out pages from the
  build at nine sizes: the first field and the submit button are in the
  first screenful (the account form at 320x568 is taller than the screen and
  is checked to scroll to its button instead), the wall is beside the form
  or not drawn, and on a touch screen each link in a sentence is a 44px
  target over its whole width.
- What the pages say of a refusal is a hand-kept list of the server's whole
  sentences with their statuses (`ANSWERS`, against
  `internal/api/auth_handlers.go`), never a word inside one: matched on
  "password", a 500 "failed to hash password" told its viewer how long a
  password must be. A 429 is "too many tries" whatever its words; every 5xx
  and anything unknown is "could not ... just now", about no field. Nothing
  checks the list against the Go source: a reworded server sentence falls
  back to that line. A refusal puts the focus in the field it is about (the
  form's first when none), and going between the two pages puts it on the
  new page's heading.
- "Connect a TV with a code" before signing in: a provider's round trip
  comes back to the front page, so the tab keeps that the viewer was on
  their way to pair (`rememberDeviceIntent`: a time in sessionStorage and
  nothing from the address; the destination is fixed). The next sign-in
  uses it once; a sign-out and ten minutes forget it.
- A toast is said to whoever is acting when it is raised. Toasts are
  dropped when nobody is signed in and when the account changes. Each
  takes the acting profile with its id (`nextToastId`, from a layout-effect
  mirror), and a profile switch drops the ones said to another profile
  (none is drawn on the switch's first commit, `profileSwitchPending`): a
  toast the switch itself causes, such as the bug report's "closed because
  this tab is now on another profile", is kept. A toast's action runs once.
- A title's My Library writes go to the server one at a time, in the order
  made (`changeLibrary`'s queue, keyed by profile and title; both routes
  are idempotent, so a write is sent whatever became of the one before it),
  also when its turn comes after a profile switch: it names its profile in
  the address, so the server takes it from a session acting as an
  unrestricted profile and refuses it (403) from one acting as a restricted
  profile, and either way nothing of it reaches the new profile's screen
  (the owner checks below). A write whose turn comes once the account it
  was made for is no longer the one signed in (a sign-out) is not sent: its
  401 would end whatever session the tab has by then. Each write's
  in-flight mark (`pendingLibOpsRef`, keyed by profile and title) is its
  own object, cleared only by that write, and a read of a profile's list
  re-applies only that profile's marks. A
  refused write takes back its own toast; only the latest write asked for
  a title is taken back on screen and said ("Couldn't …"), and a queue in
  which any write failed ends with the profile's list read again from the
  server, which stands. After a switch or a sign-out a refusal does none of
  this, and is not said (the list on screen is another's); that owner is a
  layout-effect mirror (`libraryWriteOwnerRef`), as the profile and the
  account are, so all three move in the switch's own commit. The toast's Undo
  only ever restores
  (`undoMayRestore`): nothing when the title is in the list, nothing on
  another profile's list. It was the toggle called again, which re-sent a
  failed removal and silently removed a title saved again by hand.
- Escape closes the add-to-list sheet before any player: the sheet is
  `z-[70]` and the player in the window `z-[60]`, siblings. A title page
  goes Back on Escape only when nothing is over it (`pageCovered`: the
  onboarding flow, a card's menu, any modal dialog, and a Radix dialog,
  which sets no `aria-modal` and is seen by the page it hides). A player
  that casts in the window or full screen is itself such a modal surface,
  and under it Escape still goes Back, as before, unless something else is
  over the page too; a cast minimised covers nothing. The trailer, the
  player's menus and the party's leave question take the key first
  (`lib/escapeLayers`); so does the recap, which stops the key itself.
- The toasts' corner (bottom left) is reached by two things of the
  player's. Its card while it casts minimized (`.player-cast-widget`) is at
  the bottom right, the window's width on a phone (and above a party's
  dock), and at the bottom left beside an open party rail from 640px to
  about 750px; index.css publishes where it stands (`--castcard-bottom`,
  `--castcard-h`, 64px for both of the player's cards, and, while a card
  is on the page, `--castcard-top`), and the update notice and the toasts
  stand 12px above `--castcard-top` at every width (`--corner-base`, by
  `html:has(.player-cast-widget)`). With a party's rail open, from 640px,
  the notice and the toasts end 16px left of the rail (narrower there, so
  they wrap; the notice measures its own height). In the window the
  player's play, skip and mute are in the corner, and a toast goes to the
  row above the timeline's lane (`--player-timeline-top` + 88px, the
  player's own `.player-lane-upper`). `scripts/verify-mobile-layout.mjs`
  checks both against the built stylesheet, the card's classes read from
  the player: a toast and the notice clear of the card, alone, with the
  dock at phone widths and beside the rail, and the card's buttons still
  reachable; with the rail open, with and without the card, the two clear
  of the rail and their buttons reachable. The card's height against
  `--castcard-h` is checked in `scripts/verify-player-lane.mjs`. A toast in the window can lie over the
  party's chat ticker for its few seconds; the renders put the card's
  markup on a page, and no real cast session was rendered.
- A failure is said in the app's own words, chosen by its kind, never the
  server's or the browser's text (`lib/failureWords`: lib/api's
  `NetworkError` for a request that got no answer, `APIError`'s status and
  `error.reason`; an abort says nothing). "Just now" is said only of a 5xx,
  a lost connection and the app's own failure; a 404 says the same whether
  or not the thing exists. The server's text is for the Admin page only, as
  a secondary line (`serverSaidForAdmin`); what is not yet on the helper
  still shows it: on the Admin page its panel loads (the update status
  among them), the update trigger, the AI providers' test, the stream
  diagnosis and the referral question's save as their only line, the
  download clients' connection test after "Failed:", and the manual match
  dialog after its own sentence (known gap). The browser's own alert,
  confirm and prompt boxes are not used: `noNativeDialogs.test.ts` reads
  every source file with a scanner that blanks comments only (it knows
  strings, template literals, regular expressions and both comment kinds;
  a test compares what it blanks with TypeScript's own comment ranges over
  every source file, so that holds for today's sources), with an
  allowlist of exempt files, empty since the Admin page moved off them. It matches written forms, so it does
  not see a box reached by another route: an alias of `window` or of the
  function, a computed key or `Reflect.get`, a cast whose type has
  parentheses, or a name built at run time; JSX text holding `//` or `/*`
  added later would hide code from it, and fail the TypeScript comparison.
  The app's own question (`ConfirmDialog`, one state in App) is cleared by
  a sign-out, an expiry and a profile switch. A title page whose title
  answers 404 is left (the step Back takes) and "This title is not
  available." is said where the viewer lands; a 404 that lands while a
  switch attempt is out is dropped, and the title is read again when the
  attempt ends (`titleReadDroppedRef`, set only while an attempt is out);
  one that lands after an attempt that started since its read has ended is
  dropped and read again at once. So one that changes nothing still
  leaves. A party join that did not happen, at App's entry points (the
  bell, Tonight's live strip, the calendar, a `/p/` or `/r/` link), is said by the reason the
  party hook gives beside its words (`joinRefusalWords`), never by its
  words; "just now" only for a 5xx reason, and a reason not listed gets
  the general sentence. Together shows the hook's own `error`, which is
  the app's sentences, not the server's.
- Pinned by `AuthView.test.tsx`, `Toast.test.tsx`, `lib/libraryUndo.test.ts`,
  `lib/devicePairing.test.ts`, `App.cardMenu.test.tsx` (a stub that holds
  and fails library writes), `App.profileSwitch.test.tsx` (a removal's toast
  and a refusal across a switch, every commit sampled; a queued Undo sent
  after one, taken or refused, and not sent after a sign-out; a title both
  profiles have, with the Parent's removal out across a switch; a title
  the Kid's stored copy holds and its list leaves out, with the Parent's
  save out across a switch; a queue that ends failed across a switch, its
  read of the Parent's list not asked for, and one whose read is already
  out at the switch, its answer kept off the Kid's) and
  `App.searchRequest.test.tsx` (a sign-out, an expiry, the TV intent).
- Known gaps: the owner half of `undoMayRestore` is pinned at the function
  only (once toasts go at a switch no press reaches it in the app); a
  queued write whose turn comes after a switch to a restricted profile is
  refused and lost with nothing said, so a parent who removed a title on a
  slow network, pressed Undo and switched to a kid's profile before the
  removal was answered keeps the removal, while the parent's list as this
  browser stored it at the switch holds the Undo's save, so a return to the
  parent shows the title saved until that profile's list is read, which is
  at once on the switch back (the same
  class as the progress writes a switch refuses, see Profile lock); the
  read at the end of a failed queue replaces the whole list, so if the
  server answered it before another title's save landed, and that save's
  mark is cleared before the answer arrives, that title leaves the screen
  until the next read (a suspicion from reading, not observed; the startup
  and switch reconcile has the same race); when the read at the end of a
  failed queue fails too, the
  screen keeps what the queue's last answer left on it until the next
  library read; when a removal and its Undo are both refused, the read
  puts the title back and the Undo's "Couldn't put … back" is still said;
  the layout-effect mirrors (`buildCardMenuRef`, `restoreToLibRef`, and
  the write owner `libraryWriteOwnerRef`) have no deterministic test: a
  press from a MutationObserver as a card is first drawn came after React
  had run the passive effects, so it passed with the mirror made passive,
  and every test passes with the write owner made passive too; a password
  manager's handling of the two forms (one password input whose
  `autocomplete` switches) was not tested.

### Admin page dialogs and the restore (web app)

Code: `components/admin/` (`AdminView.tsx`, `useConfirmedAction.tsx`,
`adminFailure.ts`, `restoreOutcome.ts`, `RestoreOutcomeAlert.tsx`),
`components/settings/ConfirmDialog.tsx`, and for the restore's record
`lib/restoreStatus.ts`, `hooks/useRestoreRecord.ts`,
`components/RestoreRecordNote.tsx` and `internal/api/admin_restore.go`.

- No native alert, confirm or prompt (the app-wide guard's allowlist is
  empty). Every confirmation is `ConfirmDialog` through
  `useConfirmedAction`: one request per question; the dialog stays up while
  it is out, and after `WAY_OUT_AFTER_MS` (10 s) offers a way out that
  closes it and sends or aborts nothing, the panel then saying what is
  still out and, when it lands, what came of it. While a request of a kind
  is out no new question of that kind is asked (delete library, delete room,
  purge, deny and stop stream: the opener is `aria-disabled` and described
  by the waiting line; the restore button is `disabled`, the retype's
  buttons and a user's menu `aria-disabled`, with no description). A refusal is said in
  the dialog; a 404 closes it, reads the list again and says the thing was
  already gone. A role question keeps the role it was asked about and sends
  nothing if the row has changed since; a role change that may have
  happened (5xx, no answer) reads the users again before saying so.
  Approve and deny keep the ids that are out in a set, so one row's answer
  never unlocks another row still out: the server's `Approve` checks the
  status and then writes it with nothing atomic between.
- The dialogs' and the actions' failures are said by kind through
  `adminFailure` over `lib/failureWords`, with the server's text as a
  capped second line (`serverSaidForAdmin`); a write that got no answer is
  said to have maybe happened. (The panel loads, two actions (the update
  trigger and the referral question's save) and two tests still show the
  server's text: see the failure-words bullet above.)
- A restore outlives its request (`internal/api/admin_restore.go`, runbook
  `docs/backup-restore.md`). Only the upload is the request's: once the file
  is on disk the check, the wipe and `pg_restore` run on the server-lifecycle
  context (`SetRootContext`) under the 60-minute `restoreTimeout`, on a
  goroutine that owns `backupRestoreMu` (the 409 for a second backup or
  restore) and the temp file, releasing both before it answers a client that
  stayed. A client that left gets nothing (logged as 499); the restore runs
  on. A failure past the wipe tells the admin to restore from the command
  line before restarting, never to retry: nobody can sign in to an empty
  database, and a restart on one makes the first account registered its
  admin. A shutdown
  still ends it (the lifecycle context, and systemd stops the unit's
  processes), as does the updater's deploy restart. A panic on that
  goroutine is recovered and recorded. The answers to a client that stayed
  are the old ones (400/500/200 and their sentences); Aurora never answers a
  restore with 502-504, which the web app reads as a proxy giving up.
- The record (`restoreTracker`, memory only, so a restart forgets it): the
  latest restore that got past its upload (refusals of the upload itself
  record nothing): `state` none/running/succeeded/failed, `step`
  checking/clearing/restoring, `database` unchanged/unknown/empty/restored
  (`unknown` while the wipe runs, and for a wipe or `pg_restore` the context
  cut short, a wipe whose psql lost its connection mid-statement
  (`wipeLeftDatabase`, which reads psql's exit code and, by line, libpq's
  words) or a recovered panic; a check cut short is `unchanged`),
  file, times, message, and `restart_required` (a restore succeeded since
  boot; a later refusal does not clear it). Two reads of it:
  `GET /api/admin/restore/status` behind `requireAdmin`, and
  `GET /api/restore/status` outside every session check, answered only to the
  latest restore's ticket (`X-Aurora-Restore-Ticket`, 32-128 base64url
  characters the client chose and sent with the upload; kept as SHA-256,
  compared in constant time; any other value is the same 404
  `restore_unknown`; without `message`, which can quote a row of the failing
  table and the ticket outlives the restore in that browser). The ticket read exists because the admin read cannot
  serve the person who started the restore when it matters: from the wipe
  until the commit there are no tables, so `RequireAuth`'s token-version
  check and the admin guard fail; a failure after the wipe leaves it so; and
  a success restores no sessions (dumps exclude `refresh_tokens` rows), so
  the admin guard answers `session_ended`. A malformed ticket on the upload
  is a 400 before the lock.
- The web app makes a ticket per restore (`lib/restoreStatus.ts`), keeps it in
  localStorage before the upload starts (put back on a 409, so another
  restore's ticket is not lost), sends it, and reads the record
  (`hooks/useRestoreRecord`): by ticket when one is kept (no session, so it
  works signed out and never sets off the session-expiry path), else through
  the admin route on the Admin page, which also asks it after a kept ticket
  the server no longer knows (so a restore running now is said and holds the
  button); again every 5 s while running, while a kept ticket gets no answer,
  and while one not yet seen has no record and was kept less than 66 minutes
  ago (`RESTORE_UPLOAD_WINDOW_MS`, past the route's 65-minute read deadline:
  another tab may still be uploading it, so it is waiting, not lost); every
  30 s after a success, so the restart clears it. A refused admin read is not
  retried unless a restore was running or this tab's own got no answer
  (`keepAsking`, with a doubling wait up to a minute). The ticket read sends
  same-origin cookies, for a proxy in front of Aurora. Dismiss forgets only
  the ticket the record was read with; on a note still waiting it only sets
  the ticket aside in this tab. The sign-in page shows it
  (`RestoreRecordNote`), since a reload during or after a restore lands
  there. The Admin page reads it once for every section (`AdminView`); the
  backup panel says it when this tab has no answer of its own
  (`restoreOutcome`'s outcome, with `lost` for no answer or a 502-504), and
  always while a restore runs, with the restore button and file input
  disabled, and in place of this tab's own answer when the record says more
  (a failure that touched the database); the other sections say a running
  restore and, when this tab has no answer and no request out, one the admin
  must act on (urgent words, or a lost ticket).
  Nothing is said while a restore request from this tab is out
  (`restoreOutcome`'s `out`, which outlives a remount): its ticket is kept
  before the server has a record of it, and a read then would call it
  unknown. `RestoreOutcomeAlert` titles an answer that never came "No answer
  came back about the restore from …", never "did not go through": it may
  still be running past its wipe. The server's text (`message`) is shown on the Admin page only
  (`restoreServerLine`); the sign-in page uses the page's words. The
  outcome of this tab's request still goes to the module store keyed by the
  account id from before the restore; the backup panel says it, or
  `RestoreOutcomeAlert` (mounted by App for `adminUI && user`) does when no
  backup panel is mounted as it lands. Nothing holds the page any more (the
  leave-this-page prompt is gone).
- Known gaps: a restart (a deploy by the auto-updater included, which does
  not wait for a restore: the drain block does not know of one, and the
  dialog and panel tell the admin to pause `aurora-update.timer`) still ends
  a running restore and forgets the record, so the browser that started it can say only that Aurora has no
  record of it; a restore cannot be cancelled; the ticket lives in one
  browser's localStorage (a private window or cleared site data loses it,
  and then only the admin read is left); a client older than the ticket
  restores without one; this tab's own outcome is still memory only and keyed
  by the pre-restore account id; the sign-in page's note is in no committed
  browser check (`verify-signed-out.mjs` keeps no ticket): it was rendered by
  hand once, at 390x844 and 1440x900 with its longest words, and on a phone
  as small as 320x568 it pushes the form's first field and button below the
  first screenful; a ticket kept in a browser has no expiry, so whoever uses
  that browser later can read the restore's state, step and file name (not
  its message) until it is dismissed or Aurora restarts; an answer
  that lands after its section was left is said nowhere, except a restore's
  outcome and the AI settings' restart notice; a dialog taller than the
  window keeps its focused button in view and lets the title scroll away.

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
