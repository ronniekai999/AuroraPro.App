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
  - The profile lock (below) stops a restricted session switching into a
    locked profile or changing ceilings. It does not stop the reads above:
    `?profile_id=` routes still accept any owned profile, and listings stay
    unfiltered.

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
  to bind: an ended session's still-valid access token acts as the account's
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
  profile routes, or link or unlink a sign-in identity (a new link would let
  it sign in again without the password, after its session ends). These
  checks fail closed when the acting
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
  step reached that on a single-profile account in one move; that step now
  gives the account's only such profile the tone lean and no ceiling. A
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
  and profile. Requests without a `profile_id` are answered for the account
  default on some routes, so a kid's Home showed the parent's hero pick on
  every load. When the binding cannot be read it shows no profile and opens
  the picker, which cannot be left without a pick, rather than guessing the
  default; if the profile list fails, nothing personalized loads at all. The
  catalog (Home's core rails, the browse grids) and a deep-linked `/title/:id`
  wait for the startup binding too, unless it cannot be read or the list fails
  (`catalogProfileSettled`), so the binding arriving at startup is not a
  switch and resets nothing. Only the latest hero request lands, and a switch
  clears the previous profile's hero. A switch also loads Home cold (its rails
  come down at once, so a slow or failed load shows the skeleton or the error,
  not the old rails), drops the Movies and Shows grids (aborting a Load More
  or a first page in flight), Continue Watching and the conversational rail,
  swaps My Library to the new profile's snapshot, sends an open title back
  through its `/title/:id` hydration, which leaves for Home if the new profile
  may not see it, and remounts search, collections, the calendar and member
  pages (`useOnProfileChange`). Each of these used to keep the previous
  profile's titles: the grids for the session, the conversational rail until
  the next search, Home's rails and Continue Watching until a refetch
  succeeded. A failed activation (a switch, a PIN unlock, the startup
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
  token's health, and the event socket's admin-only events (now playing,
  transcode status, server health; the role is fixed when `/ws` connects).
  The admin routes' guard refuses a non-admin and a scoped token itself,
  though `auth.RequireAdmin` and `RequireAuth` ahead of it already do. The
  one exception is an admin account with no unrestricted profile at all
  (`HasUnrestrictedProfile`): profile writes cannot produce one (the last
  unrestricted profile keeps its place, and an account's first profile
  cannot carry a ceiling, `CreateProfileFor`), but older data, a restore or
  hand-written SQL can, and a restricted session cannot
  repair it, so refusing there would leave the account, and on a one-admin
  install the server, with no admin at all. Its restricted sessions keep the
  admin powers. The web app shows its Admin tab, admin controls, scan bar
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
  so a socket opened then handed a kid's session the admin events. Anyone
  else's socket opens at once and never reopens; its role cannot change.
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
    step, the admin UI) follows the old values. The server enforces the
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
    title, and scan completions) go to the admin ACCOUNT, so a restricted
    session on it sees them in the notification list, over `/ws` and by web
    push; notifications have no profile, and push cannot be filtered by one.
    Scan progress (with the current file name) and library updates go to
    every socket, whatever its role or profile.
  - A restricted session on an admin account is held to the request quota,
    and the new-request alert skips its requester, so on a one-admin install
    a request it has held for approval alerts nobody.
  - An event socket keeps the role it connected with, either way. The web app
    reopens its own when its profile or that profile's admin powers change;
    any other socket on the session (a second device, a switch made
    elsewhere, a hand-opened one) keeps the admin events after a switch to a
    restricted profile until it reconnects. No first-party client reads
    those events (`useRealtime` ignores them), but the browser still
    receives them. While an admin's web app socket is closed (until startup
    settles, and for a moment at each reopen) a notification or request
    status is missed live; the bell has it on the next load.
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
    guards read the other profiles that strictly too, and
    `keepAnUnrestrictedProfile` reads the profile written as the ladder
    does, so such a value only refuses more there: limiting or deleting a
    profile stored with one needs another profile free of a limit by every
    reading, and a write cannot put the account in the exception's state.
    The web app trims as JavaScript does, which differs from Go on a few
    Unicode characters, so for such a value it can show or hide admin UI the
    server refuses or grants.
  - When the startup binding cannot be read, or the profile list fails, the
    startup load settles anyway (waiting would leave the app stuck), so
    collections and the requests list mount, and an admin's socket opens,
    under whatever the server has bound: after a fresh sign-in, the account
    default, not the profile this browser last used. With the binding
    unreadable they sit behind the profile picker, which covers the page but
    does not make it inert; a pick drops the requests list, remounts
    collections and reopens an admin's socket.
  - A request already past the admin guard completes after a switch to a
    restricted profile (a backup or restore already running, say). `/ws`
    fixes its role when it connects, so a database error then leaves an
    unrestricted admin's socket a user's until it reconnects (closed, and
    no first-party client reads those events).
  - Every admin-route request, and every admin-power check outside them that
    is reached, costs about three queries (the session row, its binding, the
    profile), one more for a restricted session (the exception's check); the
    scan bar's 4-second status poll is the steady one. A highlight reel
    checks membership first, so a member pays one query per Range request
    as before, a non-member admin about four, and a failed membership query
    is a 500 for an admin too.
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
    are not, nor are the write guards' strict reading of the other profiles
    (read loosely, a guard refuses less), nor is an admin account with no
    profile through a real database, nor the router's
    wiring of the QR and feedback handlers' store (dropped, an unrestricted
    admin silently loses those two powers). In the SPA, `showsAdminUI`,
    TopNav's use of its `adminUI` prop, the scan bar's hiding and the
    socket's reconnect are tested; the App wiring (computing `adminUI` and
    passing it to TopNav, the scan bar, the panels, collections and the
    player; the admin view's mount and its notice, the redirect, the detail
    page's admin actions, the socket's gate and key, collections and the
    requests list waiting for the startup load, dropping the requests list,
    remounting collections, hiding the token's health) has no App-level
    test. Settings still labels the account's role, admin included, in a
    restricted session.
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
  - The web app has no screen for changing another profile's ceiling or the
    default profile; ceilings are set in a profile's own onboarding or
    through the API.
  - A restricted session can still read and edit other profiles' watchlists
    and My Library, which check only account ownership (`?profile_id=` and
    the other routes listed under Parental rating ceiling likewise).
  - The macOS client cannot switch profiles at all; it uses the session's
    binding.
  - Nothing tests the TV's PIN panel or Back handling on a device. The SPA's
    App wiring (the switcher and the picker going through `switchProfile`,
    `activeProfileId` starting null, the personalized fetches waiting for
    `personalProfileReady`, `catalogProfileSettled`, the hero's
    latest-request guard, the keyed My Library snapshot, and what a switch
    resets: `resetForProfileChange` and its startup exemption, the cold Home
    load, the grid effects' profile dependency and the views' keys, though
    `useOnProfileChange` itself is tested) has no App-level test, and the
    room socket's connect-time profile and its retry
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
    The onboarding age step's lock for a restricted profile (`ceilingLocked`)
    is tested at its patch helper only; the server refuses the change
    regardless.
  - Account-level actions still open to a restricted session, for example:
    editing the member profile (`PUT /api/me/profile`, whose
    `share_watch_history` switch publishes the default profile's history),
    changing the account password (it needs the current one), approving a
    device pairing (the device binds to the restricted profile, or, when
    that profile has a PIN, to the most restrictive unlocked one, or, on an
    account with no password whose every profile is locked, to the most
    restrictive one without its PIN), the
    taste-onboarding routes (`/api/onboarding/skip`, `/seeds`, `DELETE
    /seeds`), which take any `?profile_id=` on the account, so a restricted
    session can mark another profile's onboarding done or change its seeds,
    follows,
    media requests, collections, watch parties and rooms, notifications,
    feedback and referral answers, push subscriptions, and logout, which
    signs out every session on the account.
  - A session a PIN write ended keeps its still-valid access token for up to
    one token lifetime, acting as the account's most restrictive profile, as
    a deleted profile's sessions do; it can read and write that profile's
    data, and other profiles' through the `?profile_id=` routes, but cannot
    manage profiles, pair a device or finish a sign-in link.
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
