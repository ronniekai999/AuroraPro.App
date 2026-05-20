# Aurora Media Server

A self-hosted media server written in Go. Streams your movies and TV shows
to any device with a browser, with TMDB-enriched metadata, hardware-accelerated
transcoding, real-time watch parties, semantic search, and a polished React UI.

Aurora installs bare-metal on Linux via systemd + native PostgreSQL.

## Install

One command, on a fresh Debian / Ubuntu / Fedora / RHEL / Arch / openSUSE box:

```bash
git clone https://github.com/aurora-media/aurora.git
cd aurora
sudo ./scripts/install.sh
```

The installer takes care of everything — Go toolchain, FFmpeg, PostgreSQL +
pgvector + pg_trgm, the `aurora` system user, systemd unit, database role
+ schema, JWT secret generation, the build, and the auto-updater timer.

You'll be prompted once for:

- **TMDB API key** — free at [themoviedb.org/settings/api](https://www.themoviedb.org/settings/api)
- **Media directory** — the folder(s) Aurora should read

That's it. The installer prints the URL when it's done.

### Unattended install

Pass everything via environment variables to skip every prompt:

```bash
sudo TMDB_API_KEY=xxxxx \
     AURORA_MEDIA_DIR=/srv/media \
     ./scripts/install.sh
```

### Opt-in extras

| Env var | What it does |
|---------|--------------|
| `AURORA_DOMAIN=media.example.com` | Sets up nginx reverse proxy + Let's Encrypt HTTPS |
| `AURORA_CERTBOT_EMAIL=you@example.com` | Required if `AURORA_DOMAIN` is set |
| `AURORA_RADARR_URL=` + `AURORA_RADARR_API_KEY=` | Enables movie requests via Radarr |
| `AURORA_SONARR_URL=` + `AURORA_SONARR_API_KEY=` | Enables TV requests via Sonarr |
| `AURORA_TVDB_API_KEY=` + `AURORA_TVDB_PIN=` | TVDB metadata fallback |
| `AURORA_GIT_TOKEN=<PAT>` | **For private repos** — writes `/root/.git-credentials` (mode 600) so the auto-updater can `git fetch` non-interactively. Use a fine-grained PAT scoped to `Contents: Read-only` on just this repo. |

The installer is **idempotent** — re-run it any time to rebuild after a
`git pull`. Your JWT secret, database, and configuration are preserved.

## After install

```bash
# Open Aurora in your browser
http://localhost:8484/        # or https://your-domain/ if you set AURORA_DOMAIN
```

1. Register your first account — it becomes the admin
2. Admin → Libraries: add your media folders
3. Aurora scans, matches against TMDB, and pulls metadata

## Operating it

```bash
systemctl status aurora           # current state
journalctl -u aurora -f           # follow logs
systemctl restart aurora          # restart after a manual config change
$EDITOR /etc/aurora/aurora.env    # edit configuration

# Auto-updater (checks every 5 min for changes pushed to your origin)
systemctl status aurora-update.timer
journalctl -u aurora-update -n 50
```

Config lives at `/etc/aurora/aurora.env`. Cache at `/var/cache/aurora`.
Logs at `/var/log/aurora` and via journald.

### Upgrading Aurora

**Routine updates** are handled automatically by the 5-min `aurora-update.timer`
— it does `git fetch` + rebuild + restart when origin has new commits.

**Manual rebuild** from a local checkout (when the auto-updater is wedged,
you're applying local changes, or you want a faster turnaround than the
5-min tick):

```bash
cd <your-aurora-clone>
git pull
./scripts/redeploy.sh        # build SPA + Go binary, atomic-swap, restart
```

`redeploy.sh` is the right tool for the routine "I edited code, deploy it"
loop. It builds the V2 SPA (`npm ci && vite build`), builds the Go binary,
atomic-swaps `/opt/aurora/static/`, copies migrations, restarts the service,
and polls `/api/health` until it answers. Use `--skip-npm` to reuse an
existing frontend build, or `--no-restart` to stage files without bouncing
the service.

**Reinstall** the systemd units / sudoers / ACLs when an update touches
`scripts/install.sh` itself (new state directories, systemd unit changes,
schema-side ACL adjustments):

```bash
cd /var/lib/aurora/source
sudo git pull
sudo ./scripts/install.sh
```

The installer is idempotent — your JWT secret, database, and config are
preserved across runs.

## Uninstall

```bash
sudo ./scripts/uninstall.sh           # interactive, asks before each step
sudo ./scripts/uninstall.sh --force   # skip prompts (for automation)
```

Removes the binary, systemd units, config, cache, source clone, database,
and `aurora` system user. Shared packages (PostgreSQL, FFmpeg, Go, nginx,
certbot) are left in place.

## Reverse proxy (manual setup)

If you'd rather configure the reverse proxy yourself instead of letting
`install.sh` provision nginx + certbot, sample configs are in
[`docs/reverse-proxy/`](docs/reverse-proxy/): Caddyfile + nginx.conf.

## Requirements

- **OS**: Linux (Debian/Ubuntu, Fedora/RHEL, Arch, openSUSE)
- **Disk**: ~500 MB for the binary, cache, and Go toolchain — plus whatever
  your media occupies
- **RAM**: 1 GB minimum; 4 GB recommended if you enable the local LLM for
  semantic search
- **PostgreSQL**: 14+ (installed automatically by `install.sh`)

Aurora has no Docker support in this repo — it's a bare-metal install.

## Features

- **Auth**: JWT + refresh tokens, invite codes, rate limiting, Argon2 hashing
- **Libraries**: Multi-path libraries with filesystem watching + auto-scan
- **Metadata**: TMDB (movies + TV), TVDB fallback, cast & crew, artwork
- **Streaming**: Direct play via HTTP range; HLS transcode fallback (FFmpeg)
- **Hardware accel**: NVENC, QSV, VAAPI, AMF — auto-detected per-host
- **Subtitles**: Embedded extraction (WebVTT) + external SRT/VTT discovery
- **Watch progress**: Per-user resume, auto-complete at 90%, continue-watching
- **Watch parties**: Synchronized playback, reactions overlay, WebRTC voice
- **Semantic search**: Local LLM embeddings via Ollama (optional)
- **Requests**: Radarr / Sonarr integration for end-user requests
- **Admin**: Built-in backup + restore, user management, integrations UI

## License

Personal-use license. See [LICENSE](LICENSE) if present, or contact the
maintainer.
