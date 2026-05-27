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
remain on disk until the Phase 3 janitor sweeps them (30-day TTL).

## Capabilities across phases (all in current build)

- **Phase 1:** flag, launcher button, modal, file upload from disk,
  server endpoint, GitHub issue creation, attachment hosting, this
  doc.
- **Phase 2:** "Capture this page" button in the modal (in-browser
  screenshot via html2canvas, lazy-loaded chunk) + PII warning
  before capture.
- **Phase 3:** "Record screen" button (MediaRecorder +
  getDisplayMedia, 30s cap, WebM output, floating Stop pill while
  the modal is hidden) + per-user rate limit (5 submits / hour) +
  30-day automatic attachment janitor.

### Operational notes

**Rate limit:** in-process, per-user-ID, 5 submits per hour. When a
user exceeds the cap, `/api/feedback` returns HTTP 429 with a
`Retry-After` header. The frontend surfaces the server's error
message in the modal so the user sees how long to wait. State lives
in memory (not the DB) — restarting Aurora resets all counters.

**Attachment janitor:** a background goroutine sweeps
`<ImageDir>/bug-reports/` once per hour and deletes files older than
30 days. Runs only when `BUG_REPORT_ENABLED=true`. The goroutine
exits cleanly via the server-lifecycle context on graceful shutdown.
Logs at INFO when files are removed (count + TTL); WARN on individual
file delete failures (typically permission issues).

**Screen recording:**

- Browser support: Chrome / Edge / Firefox / Safari 16.4+. Modal
  surfaces a clear error on unsupported browsers.
- The user picks WHICH screen / window / tab to share via the
  browser's native picker — Aurora has no say. The PII warning
  reinforces that whatever they pick lands in the GitHub issue.
- 30-second hard cap. The floating Stop pill shows a live countdown.
  When auto-stop fires or the user clicks Stop (or the browser's
  native "Stop sharing" bar), the resulting `.webm` becomes the
  attachment.
- Audio is NOT captured (we explicitly request video-only) to skip
  the second permission prompt and avoid accidentally recording
  whatever the user is listening to.
- File size: a 30s VP9 capture at 1080p averages 3-8 MB. Files over
  the 25 MB attachment cap are rejected in the same path as
  oversized disk uploads.
