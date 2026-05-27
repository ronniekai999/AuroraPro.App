# Bug Report Feature — Admin Setup

The in-app "Report a Bug" feature lets authenticated Aurora users file
GitHub issues directly from the SPA. A floating launcher in the bottom-
left opens a modal with name / title / description fields plus an
optional screenshot or short recording attachment. On submit, the
Aurora server creates a labeled issue in your configured GitHub repo
and links the user to it.

The feature is **off by default**. Enabling it requires four env vars.

## What you need

1. **A GitHub repository** where bug reports will land. Public or
   private — both work, but private repos require a broader PAT scope
   (see step 2).
2. **A GitHub Personal Access Token (PAT)** with permission to create
   issues in that repo.
3. **A public-facing base URL** for your Aurora instance (the same URL
   users hit in the browser). This is used to build attachment URLs
   that GitHub's image renderer can fetch.

## Step 1 — Generate the PAT

Visit https://github.com/settings/tokens and choose **either** a
fine-grained or classic token:

### Option A — Fine-grained PAT (recommended)
- **Resource owner:** the account or org that owns the bug-report repo
- **Repository access:** only the bug-report repo
- **Permissions:**
  - **Issues:** Read and write
  - **Contents:** Read (required by GitHub even for issue-only flows)
  - **Metadata:** Read (auto-included)
- **Expiration:** 90 days, with a calendar reminder to rotate

### Option B — Classic PAT
- **Scope:**
  - `public_repo` if the bug-report repo is public
  - `repo` (full) if private
- **Expiration:** 90 days

Copy the token immediately — GitHub only shows it once.

## Step 2 — Set the env vars

Add these to wherever your Aurora env config lives (`docker-compose.yml`,
systemd unit, `.env` file, etc.):

```bash
# Master toggle. Set to true to enable the feature.
BUG_REPORT_ENABLED=true

# The repo where issues are filed, in "owner/repo" format.
BUG_REPORT_GITHUB_REPO=your-org/aurora-bug-reports

# The PAT from step 1.
BUG_REPORT_GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# The externally-reachable base URL of your Aurora server.
# Used to build attachment URLs in issue bodies. NO trailing slash.
BUG_REPORT_PUBLIC_BASE_URL=https://aurora.example.com
```

Restart Aurora to pick up the env changes.

## Step 3 — Verify

Sign in to Aurora as any authenticated user. You should see a small
"Report bug" pill in the bottom-left corner of any view. Clicking it
opens the modal.

To smoke-test the full flow:
1. Fill in title + description
2. Optionally attach a small PNG screenshot
3. Submit
4. Toast should show `Bug reported — issue #N created. <URL>`
5. Click the URL to confirm the issue exists in your repo with labels
   `bug` and `user-report`

## What gets stored where

- **Issue body** — submitted directly to GitHub as Markdown. Contains
  the user's description, attachment URL (if any), and a footer with
  their submitter name + Aurora username for triage context.
- **Attachment** — written to `<Cache.ImageDir>/bug-reports/<uuid>.<ext>`
  on the Aurora server. Public-served at
  `<PUBLIC_BASE_URL>/api/feedback/attachments/<uuid>.<ext>`.
  The UUID is a 128-bit random hex string — anyone with the URL can
  view the attachment, same security model as Aurora's existing
  party-share-image endpoint. Phase 3 will add a 30-day janitor; for
  now, attachments stay forever until you manually clean them.

## Troubleshooting

### "Bug reporting is enabled but misconfigured" toast
You set `BUG_REPORT_ENABLED=true` but forgot one of the other vars.
Aurora logs the missing var at startup — check the server log for the
`bug report client init failed` line.

### "Bug reporting attachments require BUG_REPORT_PUBLIC_BASE_URL"
You're submitting with an attachment but the public URL isn't set. Set
`BUG_REPORT_PUBLIC_BASE_URL` to your externally-reachable Aurora URL
(no trailing slash) and restart.

### "GitHub rejected the configured token"
The PAT is invalid, expired, or revoked. Generate a fresh PAT (step 1)
and update `BUG_REPORT_GITHUB_TOKEN`.

### "GitHub rejected the request (token may lack issue-write scope)"
The PAT exists but doesn't have the right scope. For fine-grained
tokens, ensure **Issues: Read and write** is selected for the target
repo. For classic tokens, use `repo` (private repo) or `public_repo`
(public repo).

### "GitHub repo not found or token lacks access"
Either the repo string is wrong (typo in owner/repo) or the PAT isn't
authorized for that repo. Double-check the spelling and the token's
repository-access scope.

### Attachments don't render in the GitHub issue body
GitHub's image proxy needs to be able to reach
`<PUBLIC_BASE_URL>/api/feedback/attachments/...` from the public
internet. If your Aurora server is firewalled or behind VPN-only
access, the URL is in the issue body as a link, but the inline image
preview won't render. Move Aurora behind a public reverse proxy (or
use a Cloudflare Tunnel) to fix.

## Disabling

Set `BUG_REPORT_ENABLED=false` (or unset all four vars) and restart.
The launcher button disappears immediately on the next user session.
Already-filed issues remain in GitHub; already-uploaded attachments
remain on disk until you manually delete them or the Phase 3 janitor
lands.

## What ships in Phase 1 vs later

- **Phase 1 (this PR):** flag, button, modal, file upload from disk,
  server endpoint, GitHub issue creation, attachment hosting, this doc.
- **Phase 2:** "Capture this page" button in the modal (in-browser
  screenshot via html2canvas) + PII warning before capture.
- **Phase 3:** Live screen recording (MediaRecorder + getDisplayMedia,
  30s cap) + per-user rate limit + 30-day attachment janitor.

### Phase 1 operational notes

The Phase 1 MVP intentionally **does not** include per-user rate
limiting — that's deferred to Phase 3. While enabled, any authenticated
user can submit reports in rapid succession, which would:

- Drain the GitHub PAT's primary rate budget (5,000 requests/hour) OR
  trip the secondary "abuse detection" limiter (~30/min sustained),
  breaking the feature for everyone for an hour.
- Fill the attachment cache dir at `<ImageDir>/bug-reports/` until
  disk-full takes Aurora's other image caches offline.

For Aurora deploys serving more than a small trusted user base (e.g.
non-family/friends environments) BEFORE Phase 3 lands, consider:

- Adding a CDN- or reverse-proxy-level rate limit on `/api/feedback`
  (e.g. nginx `limit_req`, Caddy `rate_limit`, Cloudflare WAF).
- Periodically checking disk usage of `<ImageDir>/bug-reports/` and
  manually pruning old files until the Phase 3 janitor lands.

Phase 3 will add `auth.RateLimiter`-backed per-user throttling (default
5 submits / user / hour) and a 30-day automatic attachment janitor.
