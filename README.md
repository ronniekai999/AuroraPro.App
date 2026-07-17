# Aurora Media Server

A self-hosted media server written in Go. Streams your movies and TV shows
to any device with a browser, with TMDB-enriched metadata, hardware-accelerated
transcoding, real-time watch parties, semantic search, and a polished React UI.

Aurora installs bare-metal on systemd Linux with native PostgreSQL.

## Quick install

Start a real root login shell, then run the public bootstrap:

```bash
sudo -i
curl -fsSLo /root/aurora-install.sh https://aurorapro.app/install.sh \
  && bash /root/aurora-install.sh
```

For the one-time production rollout, deploy this release through the existing
authenticated checkout and verify the endpoint returns HTTP 200 before
announcing the command; see the [rollout guide](docs/installation.md#first-rollout-on-an-existing-aurora-server).

This is the Swizzin-style entrypoint: no manual clone or `cd` step. The small
bootstrap validates the host, checks out a root-owned managed source tree at
`/var/lib/aurora/source`, and hands off to Aurora's full idempotent installer.

The source repository is currently private. On an interactive install, the
bootstrap securely prompts for a fine-grained GitHub token with
`Contents: Read-only` access. The token is not put in the Git URL; it is stored
in `/root/.config/aurora/git-credentials` with mode 0600 so scheduled updates
can authenticate without changing root's general Git credentials.
Once distribution becomes public, the same command works without a token.

You'll also be prompted for:

- A [TMDB API key](https://www.themoviedb.org/settings/api)
- Optional media directories Aurora should be allowed to read

Prefer to inspect privileged scripts first:

```bash
sudo -i
curl -fsSLo /root/aurora-install.sh https://aurorapro.app/install.sh \
  && less /root/aurora-install.sh \
  && bash /root/aurora-install.sh
```

See [the full installation guide](docs/installation.md) for wget, forks,
branch selection, private-repository authentication, and troubleshooting.

### Unattended install

Run from a root login shell and provide every required value in the
environment:

```bash
(
  export AURORA_GIT_TOKEN=github_pat_xxxxx
  export TMDB_API_KEY=xxxxx
  export AURORA_MEDIA_DIR=/srv/media
  trap 'unset AURORA_GIT_TOKEN TMDB_API_KEY' EXIT
  curl -fsSLo /root/aurora-install.sh https://aurorapro.app/install.sh \
    && bash /root/aurora-install.sh
)
```

Common opt-in settings:

| Environment variable | Purpose |
|---|---|
| `AURORA_DOMAIN=media.example.com` | Configure nginx + Let's Encrypt HTTPS |
| `AURORA_CERTBOT_EMAIL=you@example.com` | Required with `AURORA_DOMAIN` |
| `AURORA_RADARR_URL` + `AURORA_RADARR_API_KEY` | Enable Radarr requests |
| `AURORA_SONARR_URL` + `AURORA_SONARR_API_KEY` | Enable Sonarr requests |
| `AURORA_TVDB_API_KEY` + `AURORA_TVDB_PIN` | Enable TVDB fallback metadata |
| `AURORA_INSTALL_BRANCH=main` | Select the managed update branch |
| `AURORA_REPO_URL=https://github.com/owner/repo.git` | Install an Aurora fork |

Re-running the bootstrap preserves database data and the JWT secret, and merges
managed values into `/etc/aurora/aurora.env` without discarding custom or
future settings. As with any source deployment, back up the database before a
major update or branch change.

## After installation

Open `http://your-server:8484/`, or `https://your-domain/` when HTTPS was
configured. The first registered account becomes the administrator.

Keep port 8484 (and a new HTTPS hostname) restricted to trusted clients until
you create that account. On an internet-facing server, use a firewall or an SSH
tunnel so an unknown visitor cannot claim the initial administrator role.

Useful commands:

```bash
sudo systemctl status aurora
sudo journalctl -u aurora -f
sudo systemctl restart aurora
sudoedit /etc/aurora/aurora.env

sudo systemctl status aurora-update.timer
sudo journalctl -u aurora-update -n 50
```

Runtime locations:

| Purpose | Path |
|---|---|
| Managed root-only source | `/var/lib/aurora/source` |
| Configuration | `/etc/aurora/aurora.env` |
| Deployed static files and migrations | `/opt/aurora` |
| Binary | `/usr/local/bin/aurora` |
| Root-only recovery uninstaller | `/usr/local/sbin/aurora-uninstall` |
| Cache | `/var/cache/aurora` |
| Application logs | `/var/log/aurora` and journald |
| Root installer/updater logs | `/var/log/aurora-installer` |

Deployed code under `/opt/aurora` is root-owned and read-only to the
`aurora` service account.

## Updates and repair

The systemd timer checks the configured branch every five minutes. It builds
and stages changes, restarts Aurora, and records a release as deployed only
after `/api/health` reports `status=ok` with `db_connected=true`. A failed
health check restores the prior binary, static bundle, and on-disk migration
files, then retries later. Database migrations already applied by a failed
process are not automatically reversed.

To request a routine update immediately:

```bash
sudo systemctl start aurora-update.service
```

To repair dependencies or refresh installer-managed systemd/nginx files:

```bash
sudo -i
/var/lib/aurora/source/install.sh
```

The full repair installer preserves data/configuration but is not a
transactional release rollback mechanism.

Developers deploying a local checkout can still use
`./scripts/redeploy.sh`; it is not the recommended fresh-install path.

## Uninstall

```bash
sudo /usr/local/sbin/aurora-uninstall

# Non-interactive safe removal: keeps config, database, certificate, and logs
sudo /usr/local/sbin/aurora-uninstall --yes

# Explicit destructive purge
sudo /usr/local/sbin/aurora-uninstall --yes --purge
```

`--yes` removes the service, managed source, updater, Aurora-managed nginx
site, Aurora Git credential, cache, ACLs, system account, and Aurora-owned Node
build toolchain. It keeps config, database/role, certificate, logs, and the
root-only recovery uninstaller above. Operator-managed nginx files are never
claimed or removed. A later reinstall replays read ACLs from the retained
`libraries.paths` database values for the new service identity. If the managed
HTTPS vhost was removed, retained config is reset to usable direct HTTP; pass
`AURORA_DOMAIN` and `AURORA_CERTBOT_EMAIL` on reinstall to restore HTTPS.
If an ACL cannot be verified clean (for example, an offline media mount),
uninstall exits nonzero and preserves the Aurora user/group and recovery
uninstaller so cleanup can be retried safely.
Legacy external-database installs can supply missing roots with repeatable
`--media-path=/absolute/path` options.

For an external database, delete Aurora's data/role with the provider before a
destructive purge, then acknowledge that separate cleanup:

```bash
sudo /usr/local/sbin/aurora-uninstall --yes --purge --external-db-purged
```

## Requirements

- Linux with systemd
- amd64 or arm64
- `curl` or `wget` for the initial download
- Shell/helper CI runs on Ubuntu; the full privileged provisioning lifecycle is
  not yet integration-tested. All distribution package adapters are best-effort.
- 3 GB free disk recommended for source, build tools, and caches
- 1 GB RAM minimum; 4 GB recommended for local-LLM features
- Root access and outbound HTTPS

The installer provisions verified Go under `/usr/local/go` and an Aurora-only
Node.js toolchain under `/usr/local/lib/aurora-node`, plus FFmpeg, PostgreSQL,
pg_trgm, and pgvector. On apt systems without a matching pgvector package, it
verifies and builds pinned pgvector v0.8.5 against the installed PostgreSQL
major version. Media-directory setup recursively changes ACLs and may fall
back to `chmod o+rX`; fallback mode changes cannot be reversed reliably. The
installer refuses `/` and broad/critical system roots—use a dedicated path such
as `/srv/media` or `/mnt/nas/media`. Root-only recovery state records
installer-owned UID/GID, local database, proxy/certificate, and managed media
paths; pre-existing same-named identities are not claimed or deleted
implicitly. The local database marker includes PostgreSQL's immutable cluster
system identifier plus the database and role OIDs, preventing a replacement
cluster—or unrelated objects recreated under the same names—from being
mistaken for the originals. Verified legacy Aurora deployments are adopted
during migration. Four/five-field database markers from installer previews
require one explicit adoption run to add complete object identity. Otherwise,
explicit adoption requires
`AURORA_ADOPT_EXISTING_IDENTITIES=true` after the operator verifies ownership.
Fresh database creation uses a root-only, fsynced recovery journal with
nonce-bound role/database OID checkpoints. Aurora, its updater, and manual
redeploy stay stopped while that journal is pending; rerun the installer after
an interruption to resume safely.
Aurora has no Docker install path in this repository.

For a manual reverse proxy, use the sample
[Caddy and nginx configurations](docs/reverse-proxy/) and set
`AURORA_ALLOWED_ORIGINS=https://your-domain` plus
`AURORA_SECURE_COOKIES=true`. Also set `AURORA_TRUSTED_PROXIES` to only the
proxy addresses/CIDRs that connect directly to Aurora (for a same-host proxy:
`127.0.0.1/32,::1/128`).

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
- **Bug reporting** (optional): in-app launcher that files GitHub issues with screenshot / 30s screen-recording attachments — see [`docs/bug-report-setup.md`](docs/bug-report-setup.md) for the PAT-generation walkthrough
- **Admin**: Built-in backup + restore, user management, integrations UI

## License

Personal-use license. See [LICENSE](LICENSE) if present, or contact the
maintainer.
