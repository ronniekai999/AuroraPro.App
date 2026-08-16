# Referral prompt for invite-free SSO signups

**Status:** designed, not built. Decisions settled with the operator; implementation
is a fresh phase.

## The gap this fills

Aurora already models "this provider is trusted enough to skip the invite" as a
first-class, per-provider setting. `OAuthProvider` (`internal/api/oauth_provider.go:55`):

```go
// BypassInviteEnabled reports whether the provider's invite-bypass toggle is on.
// When true, new-user creation via this provider doesn't require an invite code.
// Per-provider because operators may trust some identity sources (Google
// Workspace) more than others (anonymous Discord).
BypassInviteEnabled(ctx context.Context) bool
```

Five providers implement it — `google`, `discord`, `twitch`, `facebook`, `twitter`
— each driven by an admin toggle `<provider>_bypass_invite` (`admin_handlers.go:1386`
onward).

When that toggle is **on**, the invite code is the thing that gets skipped — and the
invite code was the only record of where a new account came from. So the trusted
providers, the ones an operator most wants to grow through, are exactly the ones
that produce zero attribution. This closes that.

## Trigger condition

Ask **only** when all four hold at the OAuth callback:

1. a NEW user is being created (not a login, not an account link), and
2. creation came via an OAuth provider, and
3. that provider's `BypassInviteEnabled` was true, and
4. no invite claim was redeemed (the OAuth transaction carried no invite id, or it was rolled back).

(4) is not redundant with (3): a user may present a valid invite *and* use a
bypassed provider. If they came through an invite, attribution already exists and
the prompt is noise.

All four facts are available in the callback — see the claim-cookie handling at
`internal/api/oauth_handlers.go:441-452`.

## Decisions (settled)

| | |
|---|---|
| **Answer format** | Preset list + `Other` with free text |
| **Skippable** | Yes, with a visible Skip; asked once and never again |
| **Options + question text** | Admin-configurable |
| **Reporting** | Per-user column in the admin users list AND an aggregate panel |

## Data model — migration `046_referral_prompt`

```sql
ALTER TABLE users
  -- NULL = never eligible (password signup, invite used, bypass off).
  -- 'pending' = eligible and not yet resolved. 'answered' | 'skipped' = done.
  -- One column carries eligibility AND resolution, so "ask once" is a single
  -- state test and there is no way to be eligible-but-unmarked.
  ADD COLUMN referral_status TEXT
    CHECK (referral_status IN ('pending', 'answered', 'skipped')),
  -- The chosen option's KEY, not its label. Labels are admin-editable; storing
  -- the label would silently rewrite history every time one is renamed.
  ADD COLUMN referral_source TEXT,
  -- Free text, only when referral_source = 'other'.
  ADD COLUMN referral_detail TEXT,
  ADD COLUMN referral_answered_at TIMESTAMPTZ;

CREATE INDEX idx_users_referral_source ON users (referral_source)
  WHERE referral_source IS NOT NULL;
```

Store the **key**, not the label. The operator can rename "A Twitch stream" to
"Twitch" without mutating every answer, and a deleted option leaves answers
readable rather than orphaned — the aggregate panel shows unknown keys as
`<removed: key>` instead of dropping the rows.

Two admin settings, alongside the existing `<provider>_bypass_invite` keys:

- `referral_prompt_question` — text, default `"How did you hear about Aurora?"`
- `referral_prompt_options` — JSON `[{key, label}]`, default: friend, twitch,
  discord, reddit, search. `other` is implicit and always last; it is not in the
  list because it is not deletable — removing it would strand the free-text column.

## API

- `GET /api/me/referral-prompt` → `{ pending, question, options }`.
  `pending` is false unless `referral_status = 'pending'`, so the client cannot
  be tricked into showing it and the server is the only authority on eligibility.
- `POST /api/me/referral` → `{ source, detail? }` or `{ skip: true }`.
  Idempotent: a second call on a non-pending user is a no-op 200, not an error —
  double-submit from a slow network must not 500 on a brand-new account.
  Validates `source` against the CURRENT option keys plus `other`; rejects
  `detail` when `source != 'other'`; caps `detail` length.
- Admin: options/question ride the existing settings GET/PUT;
  `GET /api/admin/referrals/summary` → counts by key, plus `skipped` and
  `pending`, over an optional window.

## Frontend

- **Onboarding step.** `OnboardingFlow.tsx` already has a step machine
  (`avatar → name → age → style → titles → welcome`, line 37). Add `referral`
  before `welcome` — a new step, not a new gate, so it inherits the existing
  focus handling, `onb-stagger` motion, and reduced-motion coverage.
  The step renders only if `GET` said pending; otherwise the machine skips it, so
  password signups and invite users never see a flash of it.
- **Admin settings editor** — question field + option rows with add/remove, in the
  Sign-up section next to the bypass toggles it depends on.
- **Admin users column** — the resolved label, or `— (skipped)`.
- **Admin sign-ups panel** — breakdown by source with counts and percentages.

## Things to get right

- **Radios, not buttons.** This is a single-choice group; it needs a real
  `role="radiogroup"` with arrow-key navigation, or a native `<fieldset>` +
  `<input type=radio>`, which gets that for free. The repo has a documented
  history of hand-rolled widgets declaring a role without its keyboard contract.
- **The `Other` text field must be labelled and revealed accessibly** — not a
  placeholder-as-label, and its appearance announced.
- **Skip must be a real control in the tab ring**, not a low-contrast afterthought.
  `audit-glass-contrast.mjs` will need the new surfaces added to it.
- **The question is user-facing text from an admin.** Render as text, never as
  HTML.
- **`detail` is free text from an untrusted user.** Length-cap it, and treat it as
  data in the admin UI — it is displayed to an admin, which is exactly where an
  injection would matter.
- Answering must not be a hard gate on entering the app. If `POST` fails, log it
  and let the user through; attribution is worth less than a signup.

## Gate

`go build ./...` · `go test ./...` · `tsc -b` · `vitest` · `npm run audit` (six
checks + the browser-driven alignment pass), then the 4-angle adversarial review.
