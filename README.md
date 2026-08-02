<div align="center">

<img src="docs/assets/aurora-banner.svg" alt="Aurora Pro — self-hosted media server" width="100%">

**The self-hosted media server that installs in one command and streams better than any subscription!**

<br>

<img src="https://img.shields.io/badge/Go-1.26+-00ADD8?logo=go&logoColor=white" alt="Go 1.26+">
<img src="https://img.shields.io/badge/React_19-·_Vite_7-61DAFB?logo=react&logoColor=black" alt="React 19 + Vite 7">
<img src="https://img.shields.io/badge/PostgreSQL_14+-pgvector-4169E1?logo=postgresql&logoColor=white" alt="PostgreSQL 14+ with pgvector">
<img src="https://img.shields.io/badge/FFmpeg-hw--accelerated-007808?logo=ffmpeg&logoColor=white" alt="FFmpeg">
<img src="https://img.shields.io/badge/Linux-systemd,_bare_metal-FCC624?logo=linux&logoColor=black" alt="Linux systemd">
<img src="https://img.shields.io/badge/license-personal_use-7C3AED" alt="Personal-use license">

<br><br>

[Install](#-install) · [Features](#-what-you-get) · [Semantic search](#-enabling-semantic-search-ollama) · [Configuration](#configuration) · [Updating](#-updating) · [Troubleshooting](#-troubleshooting) · [Development](#development)

</div>

---

Aurora is a media server written in Go with a React single-page app on top. It scans your movie and TV folders, matches them against TMDB, and streams to any device with a browser — direct play when the codecs allow it, hardware-accelerated FFmpeg transcoding when they don't. It runs bare-metal on Linux (systemd + native PostgreSQL): no Docker, no external services required, and everything — including the optional AI features — stays on your box.

## ✨ What you get

### 🎬 Streaming that gets out of the way
- **Direct play** over HTTP range requests, with **HLS transcode fallback** via FFmpeg
- **Hardware acceleration** auto-detected per host: NVENC, QSV, VAAPI, AMF
- **Smart Skip** — automatic intro & credits detection (sandboxed analysis workers), one tap to skip
- **Subtitles** — embedded tracks extracted to WebVTT, plus external SRT/VTT discovery
- **Casting** — AirPlay-compatible casting with codec-aware remuxing and secure cast tokens
- **Continue watching** — per-user resume positions, auto-complete at 90%

### 🎉 Watch together
- **Watch parties** with synchronized playback, live chat, reaction overlays, and WebRTC voice
- **QR / link invites** to pull friends into a room in seconds
- Admin **Rooms** panel to see and manage active parties

### 🧠 AI, running locally (optional)
- **Semantic search** — describe what you want in plain English; pgvector embeddings + a local chat model turn it into results, with classic trigram search as the always-on fallback
- **AI file matching** — uncertain filename→metadata matches get flagged into an admin review queue instead of silently mis-filing
- **Personalized home** — hero picks and discover rows tuned by your watch history, with a taste-onboarding flow for new accounts
- **Catch Me Up** — episode recaps so you can rejoin a show without rewatching
- All of it runs on **your** hardware through [Ollama](https://ollama.com) — no cloud calls, and Aurora works fine with it switched off

### 📚 A library that stays organized
- Multi-path libraries with **filesystem watching** and scheduled auto-scans
- **TMDB** metadata (movies + TV) with **TVDB** fallback — cast & crew, artwork, blurhash placeholders
- **Collections**, a release **Calendar**, **My Library**, and a ⌘K **search palette**
- Per-user **profiles** with avatars

### 📥 Requests
- End-user request flow backed by **Radarr / Sonarr** (including separate 4K instances)
- Approval workflow with request progress tracking

### 🛡️ Built to be operated
- **Auth**: cookie-based JWT + refresh tokens, Argon2 hashing, invite codes, rate limiting, **Google & GitHub OAuth** account linking
- **Admin dashboard**: users & roles, activity log, live transcode sessions, flagged-match review, logs, server panel, LLM settings, OAuth config, notifications
- **Backup & restore** built into the admin UI (`pg_dump` under the hood)
- **Auto-updater**: a 5-minute systemd timer plus an in-app **Update Now** button; optional signed-commit verification before anything is built as root
- **Hardened systemd unit**: `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome=read-only`, dedicated unprivileged `aurora` user
- **In-app bug reporter** (optional) that files GitHub issues with a screenshot or 30-second screen recording — see [`docs/bug-report-setup.md`](docs/bug-report-setup.md)

## 🚀 Install

One command on a fresh Debian / Ubuntu / Fedora / RHEL / Arch / openSUSE box:

```bash
git clone https://github.com/ronniekai999/AuroraPro.app
cd AuroraPro.app
sudo ./scripts/install.sh
```

The installer takes care of **everything**: the Go toolchain (with checksum verification against Go's official release index), FFmpeg, PostgreSQL + pgvector + pg_trgm, the `aurora` system user, the systemd unit, database role + schema, JWT secret generation, the frontend + backend build, and the auto-updater timer.

**No API-key signup required** — Aurora ships with bundled TMDB and TVDB application keys, so metadata works out of the box. You'll be prompted once for:

- **Media directory** — the folder(s) Aurora should read (see [permissions](#-media-folder-permissions) below)
- **HTTPS domain** *(optional)* — nginx + a free Let's Encrypt cert; press Enter to skip if your DNS isn't pointed at the server yet (see [adding HTTPS later](#-adding-https-later))
- **TMDB API key** *(optional)* — press Enter to use the bundled key, or paste your own to override

It ends with a health check, a schema verification, a semantic-search preflight, and the URL to open — plus pointed warnings when something needs you: media-folder access not granted, no HTTPS, or a host firewall blocking port 8484. Re-runs are **idempotent** — your JWT secret, database, and full configuration are preserved, including any keys you've added to `aurora.env` by hand.

### Unattended install

```bash
sudo AURORA_MEDIA_DIR=/srv/media ./scripts/install.sh
```

Non-TTY runs (CI, `ssh` without `-t`) prompt for nothing — no env vars are required at all.

### Opt-in extras

| Env var | What it does |
|---------|--------------|
| `AURORA_MEDIA_DIR=/path[,/path2]` | Grants the `aurora` user read access to your media (comma-separated for multiple paths) |
| `AURORA_DOMAIN=media.example.com` | Sets up nginx reverse proxy + Let's Encrypt HTTPS |
| `AURORA_CERTBOT_EMAIL=you@example.com` | Required if `AURORA_DOMAIN` is set |
| `AURORA_INSTALL_OLLAMA=1` | Installs [Ollama](https://ollama.com) and pulls the semantic-search models (`qwen3-embedding:0.6b` + `qwen3:4b-instruct`, ~3 GB total) |
| `AURORA_RADARR_URL=` + `AURORA_RADARR_API_KEY=` | Enables movie requests via Radarr |
| `AURORA_SONARR_URL=` + `AURORA_SONARR_API_KEY=` | Enables TV requests via Sonarr |
| `AURORA_RADARR_4K_URL/_API_KEY=`, `AURORA_SONARR_4K_URL/_API_KEY=` | Separate 4K Radarr/Sonarr instances |
| `AURORA_TVDB_API_KEY=` + `AURORA_TVDB_PIN=` | Override the bundled TVDB key / add your subscriber PIN (the fallback works out of the box without either) |
| `AURORA_GIT_TOKEN=<PAT>` | **For private repos** — writes `/root/.git-credentials` (mode 600) so the auto-updater can `git fetch` non-interactively. Use a fine-grained PAT scoped to `Contents: Read-only` on just this repo. |

### 📂 Media folder permissions

Aurora runs as the unprivileged `aurora` system user. Home directories default to `0700`/`0750` on modern distros, so a path like `/home/you/media/movies` that *you* can see is often **invisible to the service** — the Libraries form will tell you exactly that if it happens. Grant access the easy way (works any time, not just at install):

```bash
sudo AURORA_MEDIA_DIR=/home/you/media ./scripts/install.sh
```

or manually with ACLs:

```bash
sudo setfacl -m u:aurora:x /home/you                    # traverse each parent
sudo setfacl -R  -m u:aurora:rX /home/you/media          # read the media tree
sudo setfacl -dR -m u:aurora:rX /home/you/media          # new files inherit access
```

Storing media outside `/home` (e.g. `/srv/media`) avoids the issue entirely. Note the systemd unit mounts `/home` **read-only** for Aurora — it can scan and stream your files but never modify them.

### 🔐 Adding HTTPS later

Skipped the domain prompt? Aurora serves plain HTTP on `:8484` until a reverse proxy fronts it — fine on a trusted LAN, not fine on the open internet (logins are cookie-based). Once your DNS A record points at the server, either of these sets up nginx + Let's Encrypt and enables auto-renewal:

```bash
# Fast path (~30s): just the domain/HTTPS setup
sudo DOMAIN=media.example.com EMAIL=you@example.com ./scripts/setup-domain.sh

# Or a full installer re-run with the domain
sudo AURORA_DOMAIN=media.example.com AURORA_CERTBOT_EMAIL=you@example.com ./scripts/install.sh
```

`setup-domain.sh` is also the tool for pointing a **second** domain at the same server — it appends to the existing nginx config and expands the certificate instead of overwriting. Both paths pin Aurora's allowed origins to the domain, and the installer marks auth cookies `Secure` when a domain fronts the install.

## 🧠 Enabling semantic search (Ollama)

Semantic search is on by default but needs a local [Ollama](https://ollama.com) with two models. Either install with `AURORA_INSTALL_OLLAMA=1`, or at any time:

```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama pull qwen3-embedding:0.6b    # embeddings (1024-dim MRL, stored at 768 — CPU-friendly)
ollama pull qwen3:4b-instruct       # query parsing / reranking
sudo systemctl restart aurora
```

The installer writes `LLM_OLLAMA_URL=http://localhost:11434` into your config and every install run ends with a **preflight** that tells you whether Ollama is reachable and the models are pulled. Without Ollama, search quietly falls back to keyword/trigram matching — everything else works. Set `LLM_ENABLED=false` to switch the AI stack off explicitly.

<a id="configuration"></a>
## ⚙️ Configuration

Config lives at `/etc/aurora/aurora.env` (written by the installer, preserved across re-runs). Edit and `sudo systemctl restart aurora`.

| Key | Purpose |
|-----|---------|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | Session signing secret (auto-generated; keep private) |
| `TMDB_API_KEY` / `TVDB_API_KEY` + `TVDB_PIN` | Metadata providers — optional overrides for Aurora's bundled application keys (`TVDB_ENABLED=false` disables the TVDB fallback) |
| `LLM_ENABLED` | AI stack on/off (default on) |
| `LLM_OLLAMA_URL` | Ollama endpoint (installer pins `http://localhost:11434`) |
| `LLM_EMBED_MODEL` / `LLM_CHAT_MODEL` | Model overrides (defaults: `qwen3-embedding:0.6b`, `qwen3:4b-instruct`) |
| `REQUESTS_ENABLED` + `RADARR_URL`/`RADARR_API_KEY`, `SONARR_URL`/`SONARR_API_KEY` | Requests integrations |
| `AURORA_ALLOWED_ORIGINS` | CORS / WebSocket origins (same-origin always allowed) |
| `AURORA_SECURE_COOKIES` | Force the `Secure` flag on auth cookies — set automatically when a domain fronts the install (TLS terminates at nginx, so the Go server can't infer it) |
| `AURORA_VOICE_STUN_SERVERS` / `AURORA_TURN_URL` + `AURORA_TURN_USERNAME` + `AURORA_TURN_CREDENTIAL` | Watch-party voice ICE servers. Defaults to Google's public STUN, which covers most home NATs; behind CGNAT or symmetric NAT, point these at your own TURN relay (e.g. coturn) |
| `CACHE_IMAGE_DIR` / `CACHE_TRANSCODE_DIR` / `CACHE_SUBTITLE_DIR` | Cache locations |
| `LOG_DIR` / `LOG_LEVEL` | Logging |
| `AURORA_SOURCE_DIR` / `AURORA_UPDATE_BRANCH` / `AURORA_EXPECTED_REMOTE` | Auto-updater source (root-owned mirror) |
| `AURORA_UPDATE_REQUIRE_SIGNED` + `AURORA_UPDATE_ALLOWED_SIGNERS` | Require verified commit signatures before the updater builds as root. **Run `scripts/check-update-signing.sh` first** — if verification fails the updater stops deploying entirely, and recovering needs shell access |
| `AURORA_TRUSTED_PROXIES` | CIDRs whose `X-Forwarded-For` is honoured, e.g. `127.0.0.1/32,::1/128` for a local nginx. **Required behind a reverse proxy** — without it every request looks like it came from the proxy, so the per-IP auth rate limiter shares one bucket across all clients and audit logs record the proxy instead of the client. `install.sh`/`setup-domain.sh` set it for you |

**On disk:** binary at `/usr/local/bin/aurora` · app + static + migrations at `/opt/aurora` · cache at `/var/cache/aurora` · logs at `/var/log/aurora` + journald · state + source mirror at `/var/lib/aurora` · listens on port **8484**.

```bash
systemctl status aurora           # current state
journalctl -u aurora -f           # follow logs
systemctl restart aurora          # restart after a config change
```

## 🔄 Updating

**Automatic** — `aurora-update.timer` checks your origin every 5 minutes and does `git fetch` → rebuild → atomic swap → restart → health check, with automatic rollback to the previous binary if the new one fails its health check. Admins can also hit **Update Now** in the UI (Server tab), which triggers the same pipeline through a systemd path unit — no sudo involved.

```bash
systemctl status aurora-update.timer
journalctl -u aurora-update -n 50
```

**Manual rebuild** from a local checkout (faster than waiting for the tick, or when applying local changes):

```bash
cd <your-aurora-clone>
git pull
./scripts/redeploy.sh        # build SPA + Go binary, atomic-swap, restart
```

Use `--skip-npm` to reuse an existing frontend build, `--no-restart` to stage without bouncing the service.

**Reinstall** when an update touches `scripts/install.sh` itself (new state dirs, systemd unit changes):

```bash
cd /var/lib/aurora/source
sudo git pull
sudo ./scripts/install.sh
```

**Private repos**: the updater needs credentials to fetch — provide `AURORA_GIT_TOKEN` at install time. **Supply-chain hardening**: set `AURORA_UPDATE_REQUIRE_SIGNED=true` (plus a signing key / allowed-signers file) and the updater refuses to build anything without a verified commit signature.

## 🩺 Troubleshooting

| Symptom | Cause & fix |
|---------|-------------|
| Adding a library says **“the Aurora service user cannot access …”** | The `aurora` user can't traverse into your (mode `0700`/`0750`) home directory. Run `sudo AURORA_MEDIA_DIR=/path ./scripts/install.sh` or the [`setfacl` commands above](#-media-folder-permissions). |
| Adding a library says **“path does not exist on the server”** | The path must exist on the **server's** filesystem — check `ls -ld <path>` on the box, watch for typos. |
| Installer fails at **“Could not obtain a valid SHA-256”** for Go | go.dev's checksum endpoints occasionally serve HTML redirect pages. Re-run to retry, or `apt install golang` (any Go ≥ 1.26) and re-run — the installer accepts a pre-installed toolchain. |
| **Search feels keyword-only / embeddings missing** | Ollama isn't reachable or models aren't pulled. The install summary's semantic-search preflight prints the exact commands; see [semantic search](#-enabling-semantic-search-ollama). |
| Service won't start, log shows **migration 014** failing | pgvector isn't installed/visible. Re-run the installer (it installs pgvector and pre-creates the extension); if a stale row remains: `sudo -u postgres psql aurora -c "DELETE FROM schema_migrations WHERE version='014_semantic_search.up.sql';"` then restart. |
| **Port 8484 already in use** | `sudo ss -tlnp \| grep 8484` and stop the conflicting process (or move it). |
| Updater log spams **“could not read Username for github.com”** | Private repo without credentials — re-run the installer with `AURORA_GIT_TOKEN=<PAT>`. |

## 🏗️ Architecture

```mermaid
flowchart LR
    B["Browser<br/>React 19 SPA"] -->|"HTTPS"| N["nginx + certbot<br/>(optional)"]
    N --> A["Aurora<br/>Go · systemd · :8484"]
    B -.->|"LAN / direct"| A
    A --> P[("PostgreSQL 14+<br/>pgvector · pg_trgm")]
    A --> F["FFmpeg<br/>direct play · HLS · hw-accel"]
    A --> O["Ollama (optional)<br/>qwen3-embedding · qwen3"]
    A --> M["TMDB / TVDB"]
    A --> R["Radarr / Sonarr<br/>(optional)"]
```

A single Go binary serves the API, WebSockets (live scan progress, watch parties), and the built SPA. PostgreSQL holds the catalog with pgvector for embeddings and pg_trgm for fuzzy search. FFmpeg handles transcoding with per-host hardware-acceleration detection. Everything optional degrades gracefully when absent.

## 📦 Requirements

- **OS**: Linux with systemd (Debian/Ubuntu, Fedora/RHEL, Arch, openSUSE) — bare metal, no Docker in this repo
- **Disk**: ~500 MB for binary + cache + Go toolchain, plus your media; ~3 GB more if you enable the local AI models
- **RAM**: 1 GB minimum; 4 GB recommended with the local LLM enabled
- **PostgreSQL**: 14+ (installed automatically)

## 🧹 Uninstall

```bash
sudo ./scripts/uninstall.sh           # interactive, asks before each step
sudo ./scripts/uninstall.sh --force   # skip prompts (for automation)
```

Removes the binary, systemd units, config, cache, source clone, database, and the `aurora` user. Shared packages (PostgreSQL, FFmpeg, Go, nginx, certbot) are left in place.

<a id="development"></a>
## 🛠️ Development

```bash
go build ./...     # must be green
go test ./...      # must be green
```

- Branch off `main`; never commit to `main` directly. The pipeline (research → implement + tests → adversarial review → merge gate) is documented in [`docs/dev-workflow.md`](docs/dev-workflow.md).
- Testing a change against a live server end-to-end: [`docs/server-testing.md`](docs/server-testing.md) (`scripts/server-test-loop.sh`).
- Manual reverse-proxy configs (Caddy + nginx): [`docs/reverse-proxy/`](docs/reverse-proxy/).
- Frontend lives in `static/redesign/app` (React 19 + Vite 7 + TypeScript).

## 📄 License

Personal-use license — contact the maintainer for anything beyond personal use.
