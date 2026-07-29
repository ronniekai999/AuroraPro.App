# Referral prompt — implementation plan

_Companion to [`PLAN.md`](PLAN.md) (the settled design). This document is the result of
a full-codebase research pass: it verifies every anchor the design cites, corrects the
few places where the design's sketch and the code disagree, and lays out the build
layer by layer with exact insertion points._

Read with [`docs/dev-workflow.md`](../../docs/dev-workflow.md): one branch off `main` →
implement + tests → build/test gate → adversarial review → squash-merge.

**Status: researched, ready to build.** Every `file:line` below was verified against
the tree at `b889716`.

---

## 1. What the research confirmed

The design doc survives contact with the code. All four trigger conditions resolve at
**one line**: `resolveOAuthUser`'s tier-3 branch already computes
`bypassInvite := provider.BypassInviteEnabled(ctx)` (`internal/api/oauth_handlers.go:765`)
and holds `inviteClaimID` in scope at the `CreateOAuthUserWithIdentity` call
(`oauth_handlers.go:796`). Eligibility is exactly:

```
tier 3 fired  ∧  bypassInvite  ∧  inviteClaimID <= 0
```

(A tier-3 signup with a claim consumes it via `FinalizeInviteCode` at
`oauth_handlers.go:812` — attribution exists, no prompt. A tier-3 signup without a
claim only proceeds when bypass is on, per the gate at `:766`.)

Better still, `CreateOAuthUserWithIdentity`
(`internal/db/queries_oauth_identities.go:250-286`) already owns a transaction around
the user INSERT — so `referral_status = 'pending'` can be stamped **inside the same
INSERT**, and the design's "no way to be eligible-but-unmarked" invariant costs one
threaded parameter, not new machinery. The invite-finalize failure path rolls back via
`DeleteUser` (`oauth_handlers.go:818`), which discards the pending mark with the user —
correct for free.

Other anchors, verified:

| Design claim | Reality | |
|---|---|---|
| Migration `046` is next | Latest is `045_qwen3_embedding` | ✔ |
| Step machine at `OnboardingFlow.tsx:37` | `STEP_ORDER` / `INPUT_STEPS` consts at `:37-39` | ✔ (see §2.3) |
| Settings ride existing GET/PUT | Whitelist map in `UpdateSettings`, `admin_handlers.go:1041-1100` | ✔ (see §2.4) |
| Admin users list column | `GET /api/users` → bare `[]models.User`; adding a column = store + model edit only, no handler change (`auth_handlers.go:701-708`) | ✔ |
| Repo has a11y history with hand-rolled widgets | `lib/radiogroup.ts:1-25` documents it; `.stage-opt` + `nextRadioIndex` is the blessed pattern (`SettingsView.tsx:199-235`) | ✔ |
| `audit-glass-contrast.mjs` needs new surfaces | `SURFACES` array at `scripts/audit-glass-contrast.mjs:228-256`; unregistered anchors **fail** the audit, they don't skip | ✔ |

## 2. Corrections and discoveries (design ⇄ code deltas)

Things the research surfaced that the design doc doesn't know. None change the settled
decisions; all change how we build them.

### 2.1 Setting keys carry an `oauth_` prefix

`PLAN.md` names the toggles `<provider>_bypass_invite`. The **stored** keys are
`oauth_<provider>_bypass_invite` (`oauthSettingKeys`, `admin_handlers.go:1424-1459`);
the unprefixed form is the *JSON field name* in the admin API
(`google_bypass_invite`, `admin_handlers.go:1386`). Cosmetic, but worth pinning before
someone greps for the wrong key.

### 2.2 The migration sketch needs `IF NOT EXISTS`

House convention (every migration since 001, e.g. `036_users_last_login.up.sql`) is
`ADD COLUMN IF NOT EXISTS` / `DROP ... IF EXISTS` so migrations are re-runnable. The
runner (`internal/db/pool.go:129-210`) applies each file as a single transaction keyed
by **full filename** and sorts lexicographically — `046_referral_prompt.up.sql` is
correct as named. Down migrations are never executed by any code path (verified: zero
references to `down.sql` outside the files themselves) — write one anyway, terse,
matching convention.

### 2.3 `STEP_ORDER` has no conditional-step mechanism — and three lists, not one

`OnboardingFlow.tsx:37-39` has `STEP_ORDER` (navigation), `INPUT_STEPS` (progress bar
"Step N of {INPUT_STEPS.length}", derived at `:400`), and the `Step` union type. All
module-level consts; `stepIndex`/`inputIndex` (`:221-222`) read them directly. A
conditional `referral` step therefore needs a **derived** step list, not a splice —
§4.5 hoists a pure `buildSteps()` into a lib module so it's unit-testable and there is
one source of truth instead of three.

### 2.4 The generic settings PUT has a partial-write hazard — fix it while we're here

`UpdateSettings` (`admin_handlers.go:1034-1178`) validates **and writes in the same
loop**, over Go's randomized map iteration, with no transaction. One malformed key can
persist an arbitrary subset of the valid keys before the 400. Today's 16 keys are
saved one-per-panel so nobody noticed; our editor saves `referral_prompt_question` +
`referral_prompt_options` **together**, which makes the hazard real (a bad options
blob could land the question row anyway). The fix is a 10-line refactor: pass 1
validates all keys, pass 2 writes. It hardens every existing key too, and ships as its
own commit.

### 2.5 The adjacent admin column is broken — fix it in scope

`AdminUser.oauth_provider` is declared (`lib/api.ts:1219`) and rendered as the
"Sign-in" column (`AdminView.tsx:2304`), but `GetAllUsers` (`queries.go:275-298`)
**never selects `oauth_provider`** — the column reads "password" for every user,
including OAuth signups. The referral column is only meaningful for OAuth signups; the
column that identifies them must actually work. One-line select + scan addition, plus
the model field it feeds. (Also noting for the record: `users.metadata_lang` is a
column with zero readers — precedent that columns can be added and never wired.
`046`'s columns get wired end-to-end in this same PR precisely so they don't join it.)

### 2.6 Attribution-loss edges the design doesn't cover

Three ways a `pending` user can *never be asked* under the letter of the design
("a new step" in a flow that doesn't always run):

1. **Flow-level "Skip for now"** (`OnboardingFlow.tsx:406-409`, also `:724`, `:843`)
   closes the whole flow from any step. A user who skips at `avatar` never reaches
   `referral`, and since taste-onboarding is then `completed`, the flow never shows
   again. Attribution silently lost — and this button is prominent.
2. **Libraries without embeddings.** `TasteOnboardingGate` shows the flow only when
   `eligible && !completed` (`TasteOnboarding.tsx:38`), and eligibility is
   `LibraryHasEmbeddings()` (`onboarding_handlers.go:351-358`). On a non-embedded
   library the flow — and the referral step inside it — never renders.
3. ~~Second profiles~~ — not an edge: the gate re-runs the flow per profile, but by
   then `referral_status != 'pending'`, the server says `pending: false`, and the
   step filters out. The design's server-authoritative `GET` handles this. ✔

Resolution **R1** (§4.5) closes 1 and 2 with the same small mechanism, and is the one
place this plan extends the settled design. It's flagged as a decision; everything
else works without it, leaving those users honestly `pending` in the admin panel.

## 3. Technology stance — "latest open source", honestly

The impressive move here is **zero new dependencies**. The stack is already current —
React 19.2, Vite 7, TS 5.9, zod 4, Go 1.26, pgx v5 — and the repo's own history
argues against novelty for its own sake: `@radix-ui/react-radio-group`, the shadcn
`ui/` scaffolding, and `recharts` are all *installed with zero importers* (verified;
`do/ui-mockups/option-b/IMPLEMENTATION_PLAN.md:454` records the same for the menu
primitives), while `lib/radiogroup.ts` exists precisely because a hand-rolled,
audited pattern beat an imported one after four shipped keyboard-contract bugs.

What we use, deliberately:

- **The repo's hardened primitives** — `nextRadioIndex` + `.stage-opt`
  (`[aria-checked]`-driven state, contrast-corrected, focus-ring-safe:
  `index.css:1807-1841`) for the radio group; `glass-panel` composition and the
  `text-white/N` alpha tiers for surfaces.
- **PostgreSQL doing the analytics** — `CHECK` constraint carrying the state machine,
  partial index from the design, `COUNT(*) FILTER` + `GROUP BY` for the summary in
  one round-trip, and the repo's `NOW() - INTERVAL '1 second' * $n` idiom
  (`queries_recommender.go:386`) for a safely-parameterized window. No aggregation in
  Go, no analytics dependency.
- **Survey science in the UI** — options are **shuffled per mount** (Fisher–Yates,
  `Other` pinned last) to neutralize primacy/"first-shown" bias, and Skip stays a
  first-class control because forcing attribution manufactures data rather than
  collecting it. This is the well-documented HDYHAU ("how did you hear about us")
  guidance: randomize response order; never require the answer.
- **CSS bars, not a chart library**, for the admin breakdown — recharts would enter
  the bundle for one horizontal bar list. A `div` with a computed width, `.toLocaleString()`
  counts, and percentages is fully accessible and matches the dashboard's existing
  `StatTile`/key-value-grid idiom (`AdminView.tsx:2150-2190`).

The one modern-dependency question worth asking — zod for the admin options editor —
is answered *no* for now: zod 4 is in `package.json` but in no built chunk; first real
use would add ~15 kB gz to the admin chunk to validate a ≤12-row list. A ~30-line
`parseReferralOptions()` in `lib/referral.ts` mirrors the Go validator, is unit-tested,
and costs nothing. (If the admin surface later grows real form complexity,
react-hook-form + zod are sitting there ready.)

## 4. The build

Five layers, ordered as commits. New Go files: `internal/db/queries_referral.go`,
`internal/api/referral_handlers.go` (+ tests). New frontend files:
`src/lib/referral.ts`, `src/lib/onboardingSteps.ts`, the step component inside
`OnboardingFlow.tsx`, and an admin section inside `AdminView.tsx` (+ tests).

### 4.1 Migration `046_referral_prompt`

`migrations/046_referral_prompt.up.sql` — the design's SQL, brought to house
convention (`IF NOT EXISTS`, single `ALTER` with comma-separated adds per
`020_oauth_providers.up.sql:22-24`, why-comment in the `036` register):

```sql
-- 046 — referral attribution for invite-free SSO signups.
--
-- When a provider's oauth_<p>_bypass_invite toggle is on, new-user creation
-- skips the invite code — and the invite code was the only record of where an
-- account came from. These columns carry a one-shot "how did you hear about
-- Aurora?" answer for exactly those signups.
--
--   referral_status: NULL = never eligible (password signup, invite used,
--     bypass off). 'pending' = eligible, not yet asked-and-resolved.
--     'answered' | 'skipped' = resolved. One column carries eligibility AND
--     resolution, so "ask once" is a single state test and there is no way to
--     be eligible-but-unmarked. Stamped atomically inside the tier-3 INSERT
--     (queries_oauth_identities.go / CreateOAuthUserWithIdentity).
--   referral_source: the chosen option's KEY, not its label — labels are
--     admin-editable; storing the label would rewrite history on rename.
--   referral_detail: free text, only alongside source = 'other' (enforced
--     here so the invariant can't drift from the API).
--
-- No backfill: existing users predate the question; inventing an answer would
-- be exactly the fabricated attribution this feature exists to avoid.
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS referral_status TEXT
        CHECK (referral_status IN ('pending', 'answered', 'skipped')),
    ADD COLUMN IF NOT EXISTS referral_source TEXT,
    ADD COLUMN IF NOT EXISTS referral_detail TEXT
        CHECK (referral_detail IS NULL OR referral_source = 'other'),
    ADD COLUMN IF NOT EXISTS referral_answered_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_users_referral_source ON users (referral_source)
    WHERE referral_source IS NOT NULL;
```

`.down.sql`, terse inverse per convention:

```sql
ALTER TABLE users
    DROP COLUMN IF EXISTS referral_status,
    DROP COLUMN IF EXISTS referral_source,
    DROP COLUMN IF EXISTS referral_detail,
    DROP COLUMN IF EXISTS referral_answered_at;
```

(The partial index drops with its column. `CHECK` passes on NULL, so NULL = "never
eligible" needs no special case. The cross-column `referral_detail` CHECK is one line
of hardening the design implies but didn't write.)

### 4.2 Store layer

**Stamp at creation** — `CreateOAuthUserWithIdentity` gains a `referralPending bool`
parameter; the INSERT gains
`referral_status = CASE WHEN $6 THEN 'pending' END` (NULL otherwise). Constraints
honored: the raw `*pgconn.PgError` propagation stays untouched (the caller's 23505
username-retry and email-collision disambiguation at `oauth_handlers.go:833-852`
depend on it, documented at `queries_oauth_identities.go:268-272`). Call site
(`oauth_handlers.go:796`) passes `bypassInvite && inviteClaimID <= 0`. The password
paths (`CreateUser` `queries.go:49`, `CreateFirstAdmin` `:393`) omit the column →
NULL → never eligible, with **zero changes**.

**New file `internal/db/queries_referral.go`:**

```go
// GetReferralStatus returns the user's referral_status ('' when NULL).
func (q *Queries) GetReferralStatus(ctx context.Context, userID int64) (string, error)

// ResolveReferral atomically resolves a pending prompt. Returns false when the
// user was not pending (already resolved or never eligible) — the idempotent
// no-op the API contract requires. detail is nil unless source == "other".
//   UPDATE users SET referral_status=$2, referral_source=$3, referral_detail=$4,
--        referral_answered_at=NOW()
//   WHERE id=$1 AND referral_status='pending'
func (q *Queries) ResolveReferral(ctx context.Context, userID int64, status, source string, detail *string) (bool, error)

// ReferralSummary: one round-trip, grouped by source over answered users, plus
// skipped/pending counts. windowDays 0 = all time; windowed on users.created_at
// (signup date) so all three buckets share one timeframe — "of the signups in
// the last N days, what did they say", which is the operator's actual question.
//   COUNT(*) FILTER (WHERE referral_status='skipped') etc. +
//   GROUP BY referral_source, window via created_at >= NOW() - INTERVAL '1 second' * $1
func (q *Queries) ReferralSummary(ctx context.Context, windowDays int) (*models.ReferralSummary, error)
```

The single-statement `UPDATE ... WHERE referral_status='pending'` **is** the
idempotency mechanism: a double-submit's second UPDATE matches zero rows, returns
`false`, handler answers 200. No transaction, no read-modify-write race.

**`GetAllUsers`** (`queries.go:277,289`): add `oauth_provider` (§2.5 fix),
`referral_status`, `referral_source`, `referral_detail` to select + scan.
**`models.User`** (`models.go:16-44`): four new pointer fields tagged `omitempty`,
following `LastLoginAt`'s documented "only `GetAllUsers` selects this" pattern
(`models.go:25-31`).

### 4.3 API — `internal/api/referral_handlers.go`

One config helper both endpoints share, so validation and display can't drift —
defaults live here (read-site fallback, the repo's dominant defaults layer, per
`request_handlers.go:359-380`):

```go
// referralPromptConfig returns the admin-configured question and options,
// falling back to defaults when unset or unparseable (slog.Warn on the latter).
// Defaults: "How did you hear about Aurora?" · friend/twitch/discord/reddit/search.
// 'other' is implicit, always valid, never in the list.
func (h *ReferralHandler) promptConfig(ctx context.Context) (question string, options []models.ReferralOption)
```

| Endpoint | Auth | Behavior |
|---|---|---|
| `GET /api/me/referral-prompt` | user | `GetReferralStatus`; unless `'pending'` → `{"pending":false}` (nothing else leaks). Pending → `{"pending":true,"question":…,"options":[{key,label},…]}`. Server is the only authority; the client can't be tricked into showing the prompt. |
| `POST /api/me/referral` | user | Body `{"source":k,"detail"?:s}` or `{"skip":true}`. Validate (table below) → `ResolveReferral`. Not-pending → **200** `{"pending":false}` no-op. Success → 200 `{"pending":false}`. |
| `GET /api/admin/referrals/summary?days=N` | admin | `ReferralSummary`. Shaped-empty-payload on a virgin instance (the `EmbeddingStatus` pattern, `admin_handlers.go:769-792`), never an error: `{"total":0,"answered":0,"skipped":0,"pending":0,"by_source":[],"window_days":0}`. `by_source` rows: `{key,label,count}` — `label` null for keys no longer in the options list, which the panel renders as `<removed: key>` instead of dropping rows. |

Validation (pure function `validateReferralAnswer`, table-tested):

| Rule | Response |
|---|---|
| `skip` xor `source` — exactly one | 400 |
| `source` ∈ current option keys ∪ `{"other"}` | 400 (stale-options race accepted: client logs and continues; attribution < signup) |
| `detail` present ⇒ `source == "other"` | 400 |
| `detail` trimmed, ≤ 200 chars, control chars stripped | 400 over cap |
| `days` (admin) integer 0–3650 | 400 |

Routes: the two `/api/me` endpoints register **flat**, next to notifications
(`router.go:896-903`) — same reasoning as notifications, don't inherit the `/api/me`
group's Discover-sized timeout. The summary goes inside the `/api/admin` group
(`router.go:906-908`, `RequireAdmin` already applied).

Security posture, restated from the design: the question is admin text rendered as
text (React escapes; no `dangerouslySetInnerHTML` anywhere in this feature);
`detail` is untrusted user text length-capped at the API and treated as data in the
admin UI — the exact place an injection would matter.

### 4.4 Settings

Two whitelist entries in `UpdateSettings`' `allowedKeys` (`admin_handlers.go:1041+`),
after the §2.4 validate-then-write refactor lands:

- `referral_prompt_question` — trimmed length ≤ 200; empty allowed (= revert to
  default; matches `GetSetting`'s "missing ≡ empty" semantics at
  `queries_phase4.go:548`).
- `referral_prompt_options` — the repo's **first JSON-valued setting** (verified: all
  ~45 existing keys are scalars). Validator: parses `[{key,label}]`; 1–12 entries;
  `key` matches `^[a-z0-9][a-z0-9_-]{0,31}$`, unique, ≠ `other` (it's implicit and
  not deletable — removing it would strand the free-text column); `label` trimmed
  1–64; raw value ≤ 4 KiB (well under the 1 MiB `decodeJSON` cap,
  `helpers.go:159`). The `settingRule.validate func(string) bool` signature can't
  explain *why* a blob was rejected — which is why the admin editor validates
  client-side first (§4.6) and the server check is the backstop.

Neither key ends in a secret suffix (`admin_handlers.go:751-764`) → served cleartext,
correctly. Defaults are **not** seeded by migration — no precedent since migration
006, and a seed would make "operator cleared it" indistinguishable from "never
configured".

### 4.5 Onboarding flow step

**Where the state comes from.** `TasteOnboardingGate` (`TasteOnboarding.tsx:26-63`)
already fetches `/api/onboarding/status` on mount; it additionally fetches
`GET /api/me/referral-prompt` in parallel and passes the result into `OnboardingFlow`
as a prop. Fetch failure ⇒ not pending (the gate's own ethos, `TasteOnboarding.tsx:40-43`:
never block the app on a nicety). Because `pending` arrives before the flow mounts,
password/invite users never see a flash of the step — the machine simply never
contains it.

**New `src/lib/onboardingSteps.ts`** — the §2.3 fix, replacing three hand-synced
consts with one tested function:

```ts
export type Step = 'avatar' | 'name' | 'age' | 'style' | 'titles' | 'referral' | 'welcome' | 'loading'
export function buildSteps(opts: { referralPending: boolean }): {
  order: readonly Step[]     // navigation
  inputs: readonly Step[]    // progress bar — referral counts: "Step N of 6"
}
```

`stepIndex`/`inputIndex` (`OnboardingFlow.tsx:221-222`) and the progress bar (`:400`,
already `INPUT_STEPS.length`-derived) read the built arrays. `referral` slots between
`titles` and `welcome`, exactly as designed.

**The step itself** — a new `ReferralStep` in `OnboardingFlow.tsx`, copying the Glow
radiogroup verbatim (`SettingsView.tsx:199-235`): `role="radiogroup"` +
`aria-label` = the question text, `role="radio"`/`aria-checked`/roving `tabIndex`
buttons styled `.stage-opt`, arrow keys via `nextRadioIndex` with **state-before-focus**
(the `ProfilesGate.tsx:224-249` lesson), only `radio` children inside the group
(the `:293-299` lesson — Skip lives outside the group element).

- **Shuffle**: `shuffleReferralOptions()` in `lib/referral.ts` — Fisher–Yates with
  injectable RNG (deterministic tests), run once in a `useState` initializer so the
  order is stable within a mount; `Other` appended last, always.
- **Other's text field**: revealed when `other` is checked — a real `<label>`
  ("Where, specifically? (optional)"), never placeholder-as-label; wrapped in an
  `aria-live="polite"` container so its appearance is announced; focus is **not**
  yanked (arrowing across `Other` must not trap the keyboard); 200-char
  `maxLength` mirroring the API cap.
- **Skip**: a visible, full-contrast button in the tab ring next to Continue —
  `POST {skip:true}`, then advance. Also: if the flow-level "Skip for now"
  (`OnboardingFlow.tsx:406`) fires **while the referral step is showing**, the user
  has seen and declined the prompt — send `{skip:true}` before `skip()` closes the
  flow. (Flow-skip from other steps is edge 1 in §2.6 → R1.)
- **Submit semantics**: fire on advancing out of the step (the `goTo` leave-hook
  precedent — appearance commits on leaving `style`, `OnboardingFlow.tsx:235-255`).
  Failure: `slog`-equivalent `console.warn`, **advance anyway** — answering is not a
  gate on entering the app; the server-side `pending` simply survives for R1.
  Server idempotency makes double-fires harmless.
- **Motion**: step content joins `.onb-stagger` (≤ 5 direct children — the delay list
  stops at `:nth-child(5)`, `index.css:4028-4032`); any new `opacity: 0` starter is
  added to the **second** reduced-motion selector list (`index.css:4082`) — the first
  list would leave it permanently invisible. `audit:motion` enforces this.
- **Focus**: the flow has no step-change focus management today (only `autoFocus` on
  name, `:531`); the referral step at minimum gets a sensible initial tab target
  (the group's roving stop). The flow-wide gap is real but out of scope — noted for
  the a11y backlog rather than smuggled in.

**R1 — close the attribution-loss edges (§2.6) — RECOMMENDED, needs a yes/no.**
Extend the gate's show condition from `eligible && !completed` to
`(eligible && !completed) || referralPending`, and let `buildSteps` also take
`taste: boolean`: when only `referralPending` is true the flow renders a minimal
`referral → welcome` pass (no `loading` step — nothing to seed, `welcome`'s button
calls `onDone` directly). This is small — the mechanism is `buildSteps` either way —
and it means a flow-skipper or a no-embeddings library still gets asked *once*, on a
later session, with the step's own Skip resolving it permanently. Maximum exposure:
two encounters. Without R1 those users stay honestly `pending` (visible in the
summary panel) and are never asked; the feature still ships. Default if unanswered:
**build R1** — the flow-level skip is prominent enough that v1 without it
measurably undercuts the point of the feature.

### 4.6 Admin surfaces (`AdminView.tsx`, OAuth tab)

The bypass toggles live in the **OAuth** tab (`ADMIN_TAB_LABELS`, `AdminView.tsx:1817`)
— the design's "Sign-up section". Three additions, all following the tab's existing
per-panel state conventions (lazy fetch on tab entry, `AbortController`, glass-panel
sections):

1. **Referral prompt editor** — a `glass-panel rounded-2xl p-5` section above the
   provider cards (it spans providers). Question `<input>` with the default as
   placeholder; option rows (key + label inputs, remove button); "Add option"; an
   informational, non-editable `Other — free text (always shown)` row. **Keys lock
   after creation** (existing-at-load rows render the key read-only) — renaming a key
   silently orphans history, which is the exact failure the store-the-key decision
   exists to prevent; rename the *label* instead. Client-side `parseReferralOptions()`
   (shared from `lib/referral.ts`) gates the Save button with per-row error text,
   because the server's `settingRule` can only say "invalid". Saves ride
   `updateSettings({referral_prompt_question, referral_prompt_options})`
   (`api.ts:2101-2112`) — both keys in one PUT, safe after §2.4.
2. **Users-table column** — `Referral` between `Sign-in` and `Created`
   (`AdminView.tsx:2274-2283` head, row map, `colSpan={6}`→`7` at `:2326`).
   Cell logic mirrors the `last_login_at` idiom (`:2307`): resolved label; for
   `other` → `Other — "<detail, truncated 60>"` rendered as text (React-escaped —
   `detail` is attacker-controlled and this is the admin's screen);
   `— (skipped)`; `Pending`; `—` for never-eligible. Label resolution uses the
   current options with `<removed: key>` fallback.
3. **Sign-ups panel** — below the editor: `answered / skipped / pending` stat row,
   then per-source rows — label, count (`.toLocaleString()`), percentage of
   answered, and a CSS-width bar (`aria-hidden`; the numbers are the accessible
   content) — plus a window `<select>` (7/30/90 days/all time) driving `?days=`.
   Data via new `getAdminReferralSummary()` in the `api.ts` referral block.

New `api.ts` feature block (banner comment, interfaces, typed fns — house pattern):
`ReferralPromptState`, `getReferralPrompt`, `submitReferral`,
`AdminReferralSummary`, `getAdminReferralSummary`; `AdminUser` gains the three
referral fields (and `oauth_provider` starts actually arriving, §2.5).

### 4.7 Audit registration

- `SURFACES` in `audit-glass-contrast.mjs` (`:228-256`) gains entries for the step's
  secondary text and the Skip control, each with a **unique JSX anchor** — the audit
  throws on missing/non-unique anchors by design, so anchors double as drift alarms.
- `audit:motion` will catch any new keyframed animation not neutralized in the
  reduced-motion block — the step reuses existing `onb-*` classes precisely so the
  existing coverage applies.
- No breakpoint/alignment impact expected (the step lives inside the existing flow
  shell); the browser-driven check needs Chromium per
  [`docs/dev-workflow.md`](../../docs/dev-workflow.md) step 4.

## 5. Tests

| Layer | What pins it | Model |
|---|---|---|
| Go unit | `validateReferralAnswer` (every 400 row in §4.3), options-JSON validator (key regex, dupes, `other` rejection, caps), eligibility predicate `bypassInvite && claim<=0` | table tests, the `oauth_link_test.go` register |
| Go handler | POST idempotency contract (second call → 200 no-op), GET pending-only disclosure | `httptest`, no live DB (house style — `internal/api` has no DB fixtures) |
| Frontend unit | `buildSteps` (referral in/out, input counts, R1 minimal pass), `shuffleReferralOptions` (Other always last; deterministic with injected RNG), `parseReferralOptions` (mirror of Go validator) | colocated `lib/*.test.ts`, pure — no jsdom pragma needed |
| Frontend component | radiogroup contract: exactly one tab stop that **roves**, arrows move-and-check, Other reveal is labelled, Skip reachable in the tab ring | `keyboardWidgets.test.tsx` model incl. its `tabStops` identity helper; `// @vitest-environment jsdom` |
| Smoke (live) | `check_get "/api/me/referral-prompt" 200` with `.pending == false` for the standing test user; admin summary shape check | `scripts/aurora_smoke_test.sh` conventions |

Note: these are the **first tests touching the onboarding flow** (current coverage:
none) — `buildSteps` extraction is what makes that cheap.

## 6. Sequencing and gate

One branch (`feat/referral-prompt` per workflow naming; this repo squash-merges), one
PR — the feature is cohesive and the frontend is unshippable without the API. Commit
sequence keeps review sane:

1. `UpdateSettings` validate-then-write hardening (§2.4) — standalone, pre-feature.
2. Migration 046 + store layer + eligibility stamp (§4.1–4.2) + Go tests.
3. API endpoints + settings whitelist (§4.3–4.4) + Go tests.
4. Flow step + gate fetch + `buildSteps` [+ R1 if approved] (§4.5) + unit/component tests.
5. Admin editor, users column (+ §2.5 fix), summary panel (§4.6).
6. Audit surface registration (§4.7) + smoke-test additions.

Gate, per [`docs/dev-workflow.md`](../../docs/dev-workflow.md) and `PLAN.md`:
`go build ./...` · `go test ./...` · `tsc -b` · `vitest` · `npm run audit` (six
checks + browser alignment; Chromium required) → 4-angle adversarial review → merge.
Post-merge: `bash scripts/server-test-loop.sh --trigger-update` against the live
instance, then a manual end-to-end pass — fresh SSO signup on a bypassed provider →
prompt appears once → answer lands in the users table and summary panel → second
login shows nothing.

## 7. Decisions on the table

| # | Question | Default |
|---|---|---|
| D1 | **R1**: minimal `referral → welcome` pass for flow-skippers and no-embeddings libraries (§2.6/§4.5)? | **Yes** — small, shares `buildSteps`, closes the biggest attribution leak |
| D2 | Summary window keyed to `created_at` (signup date) rather than `referral_answered_at` (§4.2)? | **Yes** — all three buckets share one timeframe; "of last month's signups, what did they say" |
| D3 | Flow-level "Skip for now" pressed *while the referral step is visible* counts as referral-skip (§4.5)? | **Yes** — they saw it and declined; prevents R1 from re-nagging that user |

Everything else in this document implements `PLAN.md` as settled.
