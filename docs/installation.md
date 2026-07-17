# Installing Aurora

Aurora uses a two-stage installer:

1. `https://aurorapro.app/install.sh` is a small public bootstrap.
2. The bootstrap maintains `/var/lib/aurora/source` and runs the full
   repository installer from that root-owned checkout.

This provides a Swizzin-style one-command experience while retaining Aurora's
existing database, systemd, update, and uninstall lifecycle.

## Before you begin

You need:

- A systemd-based Linux server
- amd64 or arm64
- Root access
- Outbound HTTPS
- `curl` or `wget` for the initial bootstrap download
- About 3 GB of free disk during installation
- A TMDB API key from <https://www.themoviedb.org/settings/api>

The installer has package-manager adapters for:

- Debian and Ubuntu (`apt`)
- Fedora, RHEL, Rocky, AlmaLinux, and CentOS (`dnf` or `yum`)
- Arch Linux (`pacman`)
- openSUSE and SLES (`zypper`)

Shell syntax, helper mocks, and unit tests run on Ubuntu CI; the privileged
fresh-install/reinstall/purge lifecycle is not yet integration-tested on a
clean VM. Every package-manager adapter is therefore best-effort. Package
availability depends on the distribution release. On Debian and Ubuntu, the
installer prefers a matching distro or PGDG pgvector package. If apt has no
candidate—as on Debian 12/PostgreSQL 15 and Ubuntu 22.04/PostgreSQL 14—it
downloads the pinned upstream pgvector v0.8.5 tag, verifies its SHA256, and
builds it against the exact server-major development headers. Ubuntu systems
must have the official `universe` component enabled for those headers.
RHEL-family systems may still require the PGDG repository for pgvector.

## Interactive installation

Use a root login shell. This gives package managers, Git, and the build
toolchains a predictable root environment.

```bash
sudo -i
curl -fsSLo /root/aurora-install.sh https://aurorapro.app/install.sh \
  && bash /root/aurora-install.sh
```

Downloading to a root-only path first ensures a failed or partial transfer
cannot be mistaken for a successful installation.

Using wget:

```bash
sudo -i
wget -qO /root/aurora-install.sh https://aurorapro.app/install.sh \
  && bash /root/aurora-install.sh
```

The source repository is currently private. If no token is already exported,
the bootstrap reads one from `/dev/tty` with echo disabled. Create a
fine-grained GitHub personal access token with:

- Repository access: the selected repository (normally
  `ronniekai999/AuroraPro.App`, or your private fork)
- Repository permission: `Contents: Read-only`

The bootstrap uses an askpass helper during the initial clone, so the token is
not embedded in the remote URL or shown in process arguments. The full
installer then stores it in Aurora's dedicated
`/root/.config/aurora/git-credentials` file with mode 0600 for noninteractive
scheduled updates. It is plaintext protected by root-only filesystem
permissions; root's general Git credential file is not modified. To rotate an
expired token, export the replacement as `AURORA_GIT_TOKEN` and rerun the
bootstrap.

Older Aurora installer revisions may have written a GitHub entry to
`/root/.git-credentials`. The new installer warns when that legacy global file
exists but does not edit it, because the entry may belong to another root-owned
workflow. Review it manually after migration and remove or rotate only the
obsolete Aurora credential.

For an SSH repository URL, configure a deploy key and `known_hosts` under
`/root/.ssh` first. The updater is a root systemd service with no interactive
SSH agent, so `git ls-remote <repo-url>` must work noninteractively from a root
shell. Do not also set `AURORA_GIT_TOKEN`.

Signed-commit enforcement is an updater policy. It does not verify the initial
checkout that the bootstrap runs as root.

## Inspect-first installation

Remote root installers deserve scrutiny. Download it before running it:

```bash
sudo -i
curl -fsSLo /root/aurora-install.sh https://aurorapro.app/install.sh \
  && less /root/aurora-install.sh \
  && bash /root/aurora-install.sh
```

Using wget:

```bash
sudo -i
wget -qO /root/aurora-install.sh https://aurorapro.app/install.sh \
  && less /root/aurora-install.sh \
  && bash /root/aurora-install.sh
```

## Unattended installation

Set the required values in the root shell:

```bash
sudo -i
(
  export AURORA_GIT_TOKEN=github_pat_xxxxx
  export TMDB_API_KEY=xxxxx
  export AURORA_MEDIA_DIR=/srv/media
  trap 'unset AURORA_GIT_TOKEN TMDB_API_KEY' EXIT
  curl -fsSLo /root/aurora-install.sh https://aurorapro.app/install.sh \
    && bash /root/aurora-install.sh
)
```

Useful optional settings (export them inside the same subshell before the
download):

```bash
export AURORA_DOMAIN=media.example.com
export AURORA_CERTBOT_EMAIL=admin@example.com

export AURORA_RADARR_URL=http://127.0.0.1:7878
export AURORA_RADARR_API_KEY=xxxxx
export AURORA_SONARR_URL=http://127.0.0.1:8989
export AURORA_SONARR_API_KEY=xxxxx

export AURORA_TVDB_API_KEY=xxxxx
export AURORA_TVDB_PIN=xxxxx
```

Before using `AURORA_DOMAIN`, point its DNS record at the server and allow
inbound TCP 80/443. The installer writes Aurora's named nginx vhost and certbot
may rewrite it. Aurora manages one hostname in that vhost. If an
operator-managed `aurora.conf` already exists, the helper refuses to edit or
claim it; move/rename it before opting into managed setup, or use the manual
reverse-proxy samples instead.

Multiple media directories are comma-separated:

```bash
export AURORA_MEDIA_DIR="/srv/movies, /srv/tv, /mnt/archive"
```

Use dedicated library directories. The installer canonicalizes paths and
refuses `/`, broad roots such as `/home`, `/var`, and `/mnt`, and critical
system/Aurora trees. Narrow children such as `/home/alice/videos`,
`/var/media`, and `/mnt/nas/media` are accepted.

## Bootstrap options

```text
--branch NAME   Install and track a branch
--repo URL      Install from an Aurora fork
--no-log        Disable /var/log/aurora-installer/install.log
--help          Show usage
```

Equivalent environment variables:

```bash
export AURORA_INSTALL_BRANCH=main
export AURORA_REPO_URL=https://github.com/owner/repo.git
```

Bootstrap installs accept only GitHub HTTPS and SSH repository URLs. The
managed source directory cannot be redirected or symlinked because root builds
run from it. Developers should use `scripts/redeploy.sh` for trusted local
working-tree deployments.

## What the installer changes

The full installer:

- Installs required system packages
- Installs checksum-verified Go under `/usr/local/go` and an Aurora-only Node.js
  build toolchain under `/usr/local/lib/aurora-node` when needed
- Installs FFmpeg, PostgreSQL, pg_trgm, and pgvector. Apt systems use a
  matching binary package when available, with a checksum-verified pgvector
  v0.8.5 source fallback when it is not.
- Creates the `aurora` system user and, for a local database, the Aurora
  PostgreSQL role/database
- Builds the React frontend and Go binary
- Installs and hardens the systemd service
- Creates the updater timer and admin-trigger path unit
- Optionally configures nginx and Let's Encrypt
- Starts Aurora and waits for `/api/health` to report `status=ok` with
  `db_connected=true`

When media directories are supplied, the installer recursively grants the
`aurora` account read/traverse ACLs. If ACL tools are unavailable it falls back
to `chmod o+rX` and parent-directory `o+x`; those fallback mode changes cannot
be safely reversed because the original modes are unknown. On repair after a
safe uninstall, the installer also reads the retained local PostgreSQL
`libraries.paths TEXT[]` values and idempotently replays access for the newly
created service account. Canonical roots whose access was changed are also
recorded in root-only recovery state, so uninstall can reverse named ACLs after
a library is removed from the database or when an external database cannot be
queried. External PostgreSQL installs must pass `AURORA_MEDIA_DIR` explicitly
because the installer does not connect to an external database as an
administrator.

Aurora records the exact UID, GID, local PostgreSQL cluster fingerprint
(including `pg_control_system().system_identifier`) and the owned database/role
OIDs,
managed media roots, proxy transitions, and exclusive certificate ownership
under `/usr/local/lib/aurora-installer`. It will not silently claim a
pre-existing `aurora` user/group or same-named PostgreSQL role/database.
Upgrades from a verified legacy Aurora service (unit + env + deployed binary)
are adopted automatically. Legacy four/five-field database markers are
deliberately not upgraded automatically: first verify that they still identify
Aurora's cluster, role, and database. For those markers or any other deliberate
adoption, run once with:

```bash
sudo AURORA_ADOPT_EXISTING_IDENTITIES=true \
  /var/lib/aurora/source/scripts/install.sh
```

If a seven-field marker proves the cluster and any still-present object but the
recorded database is genuinely absent, repair writes root-only resumable intent
before DDL. It then advances fsynced, monotonic `intent`, `role-ready`,
`temp-ready`, and `promoted` checkpoints containing the recovered role and
database OIDs. Database creation, provenance labeling, and promotion are
guarded against the recorded PostgreSQL cluster and object identities. It
retains the existing role credential when that exact role remains; when the
role is also absent, it creates a new nonce-marked role and persists the new
OID marker and matching `DATABASE_URL` while durable pending state remains.
Interrupted or power-loss recovery resumes from that state. This restores service
structure—not data; restore a
PostgreSQL backup instead when the old data is needed. A same-named object with
a different OID/provenance is never repaired over or adopted implicitly.
Uninstall refuses to run while this recovery marker exists; finish the full
installer first so no temporary database or credential is orphaned.
Persistent systemd conditions and direct updater/redeploy checks prevent
Aurora or a deployment job from starting while recovery is pending. An
existing Aurora service is stopped before recovery DDL and remains stopped
after an interrupted repair; rerunning the installer resumes recovery and
starts it only after the normal strict health gate.

When retained configuration points to an external `DATABASE_URL`, the
installer skips local PostgreSQL package provisioning and all local
superuser administration. The provider must already expose `pg_trgm` and
`vector` extensions to Aurora.

Main paths:

```text
/var/lib/aurora/source          managed root-only Git checkout
/var/lib/aurora/deployed-revision
/etc/aurora/aurora.env
/usr/local/bin/aurora
/usr/local/bin/aurora-update
/usr/local/sbin/aurora-uninstall   root-only recovery uninstaller
/usr/local/lib/aurora-installer    recovery helpers + ownership/ACL state
/usr/local/lib/aurora-node
/opt/aurora/static
/opt/aurora/migrations
/var/cache/aurora
/var/log/aurora                    application logs
/var/log/aurora-installer          root installer/updater logs
```

The service account cannot modify `/opt/aurora`; deployed assets are
root-owned. Aurora can write only its cache, log, and state locations.

## Reinstall and repair

Run the bootstrap already stored in the managed checkout:

```bash
sudo -i
/var/lib/aurora/source/install.sh
```

Reinstallation preserves the database and JWT secret. Configuration updates
are merged into the existing `/etc/aurora/aurora.env`; unknown keys and
operator customizations are retained. The previous file is backed up as
`/etc/aurora/aurora.env.bak`.

The stored `AURORA_EXPECTED_REMOTE` and `AURORA_UPDATE_BRANCH` values are used
as repair defaults, so installations that track a fork or non-`main` branch do
not silently switch back to Aurora's canonical repository.

This is data/configuration-safe, not a transactional release rollback. A bad
source revision can still fail the full installer health check, so back up
PostgreSQL before major updates or branch changes.

After nginx and certbot succeed for `AURORA_DOMAIN`, the installer sets:

```text
AURORA_ALLOWED_ORIGINS=https://your-domain
AURORA_SECURE_COOKIES=true
AURORA_TRUSTED_PROXIES=127.0.0.1/32,::1/128
```

Aurora-managed nginx uses exactly one managed hostname and overwrites incoming
forwarding headers with nginx's direct client address before proxying. An
explicit `AURORA_DOMAIN` request is considered incomplete—and the installer
returns nonzero—if its email is missing or certificate/proxy setup fails.

The standalone helper applies the same settings and is the proxy-repair path:

```bash
sudo DOMAIN=media.example.com EMAIL=admin@example.com \
  /var/lib/aurora/source/scripts/setup-domain.sh
```

## Updates

`aurora-update.timer` checks the selected branch every five minutes.

The updater:

1. Reads only updater-specific keys from `aurora.env`; it does not export
   database, JWT, or API secrets into build subprocesses.
2. Fetches the configured origin and verifies it matches the pinned remote.
3. Optionally verifies the commit signature.
4. Builds and stages the frontend, binary, migrations, and installer endpoint.
5. Restarts Aurora and requires `/api/health` to report `status=ok` with
   `db_connected=true`.
6. Records `/var/lib/aurora/deployed-revision` only after success.
7. Rolls back the binary, static assets, and on-disk migration files after a
   failed health check.

Because source HEAD and deployed revision are tracked separately, a failed
release is retried on the next update instead of being reported as current.
Database migrations already applied by a failed process are not reversed.
Create a PostgreSQL backup before major changes or switching branches.

Routine updater runs deploy application code only. Dependency/toolchain,
systemd-unit, nginx, and installer-policy changes require a bootstrap repair.

Pause automatic retries while investigating a bad release:

```bash
sudo systemctl disable --now aurora-update.timer
```

The in-app manual trigger uses `aurora-update.path` and remains separate. Stop
it too when you need a complete update freeze:

```bash
sudo systemctl disable --now aurora-update.path
```

Resume both after the branch is healthy:

```bash
sudo systemctl enable --now aurora-update.timer aurora-update.path
```

To require signed commits, configure an SSH allowed-signers file or a minimal
GPG trust store, then set:

```text
AURORA_UPDATE_REQUIRE_SIGNED=true
AURORA_UPDATE_ALLOWED_SIGNERS=/root/.config/aurora/allowed_signers
```

## Uninstall

Interactive:

```bash
sudo /usr/local/sbin/aurora-uninstall
```

Noninteractive safe removal:

```bash
sudo /usr/local/sbin/aurora-uninstall --yes
```

This keeps configuration, the PostgreSQL database and role, the Let's Encrypt
certificate, logs, and the root-only recovery uninstaller. It removes the
service, managed source, updater, Aurora-managed nginx site, Aurora Git
credential, cache, reversible ACLs, system account, and Aurora-owned Node.js
toolchain. Operator-managed nginx files are preserved. A later private
reinstall prompts for a token again and replays ACLs from retained local
database library paths. ACL fallback mode changes cannot be reversed.

Before deleting Aurora's service identity, uninstall verifies that every
recorded access and default ACL is gone. If a media mount is offline, ACL tools
are missing, or verification fails, uninstall exits nonzero and preserves the
service user/group plus `/usr/local/sbin/aurora-uninstall`. Restore the mount or
perform the exact cleanup printed in the error, then rerun the recovery
uninstaller. Pre-existing or marker-mismatched user/group/database identities
are never deleted.

Legacy external-database installs may predate durable media-root state. Supply
each such root explicitly (repeat the option for multiple roots):

```bash
sudo /usr/local/sbin/aurora-uninstall --yes \
  --media-path=/srv/movies --media-path=/mnt/nas/tv
```

If safe removal deletes an Aurora-managed HTTPS vhost, it records that
transition and resets retained cookie/origin/trusted-proxy settings for direct
HTTP. Reinstall without domain variables is therefore usable on port 8484;
provide `AURORA_DOMAIN` plus `AURORA_CERTBOT_EMAIL` to restore HTTPS.

To delete protected data too:

```bash
sudo /usr/local/sbin/aurora-uninstall --yes --purge
```

`--purge` must be paired with `--yes`. Shared system packages (including
PostgreSQL, FFmpeg, Go, nginx, and certbot) and media files are never removed.
Purge starts a detected stopped PostgreSQL service long enough to inspect/drop
Aurora's database and role, then returns it to stopped state. It fails nonzero
and preserves the recovery uninstaller if protected objects could not be
removed. Destructive PostgreSQL statements run only in the same `psql` session
that revalidates the recorded cluster, database OID, role OID, and database
owner immediately before the drop. Certificates are deleted only when Aurora
recorded ownership and the
Certbot lineage contains exactly the single managed hostname and no active
operator-owned nginx vhost serves that hostname or references the lineage;
shared, reused, or pre-existing lineages are retained.

For an external `DATABASE_URL`, Aurora never probes or drops a same-named local
database. Purge retains config and exits nonzero until you delete the external
Aurora data/role with that provider. Then acknowledge completion explicitly:

```bash
sudo /usr/local/sbin/aurora-uninstall --yes --purge --external-db-purged
```

## Troubleshooting

Bootstrap/install log:

```bash
sudo less /var/log/aurora-installer/install.log
```

Service startup:

```bash
sudo systemctl status aurora
sudo journalctl -u aurora -n 100 --no-pager
curl -fsS http://127.0.0.1:8484/api/health
```

Updater:

```bash
sudo systemctl status aurora-update.timer
sudo systemctl start aurora-update.service
sudo journalctl -u aurora-update -n 100 --no-pager
sudo less /var/log/aurora-installer/update.log
sudo cat /var/lib/aurora/update-status.json
```

If the managed source contains tracked changes or non-ignored untracked files,
the bootstrap refuses to overwrite them. Inspect with:

```bash
sudo git -C /var/lib/aurora/source status
```

Move or commit intentional changes before retrying. Do not make routine
development edits in the root-owned managed checkout; use a separate clone and
`scripts/redeploy.sh`.

## Secure the first administrator registration

Until a user exists, the first successful registration becomes administrator.
Aurora listens on port 8484, so do not expose a new server to untrusted clients
before claiming that account. Restrict the port with the host/cloud firewall,
or bind/tunnel it through SSH:

```bash
ssh -L 8484:127.0.0.1:8484 root@your-server
```

Then open `http://localhost:8484/` locally and register immediately. Apply the
same restriction to a newly configured HTTPS hostname until setup is complete.

## First rollout on an existing Aurora server

The public URL becomes available only after a build containing the installer
endpoint is deployed. For the initial migration:

1. Back up `/etc/aurora/aurora.env` and PostgreSQL. Commit/push or separately
   preserve any local patches in the old checkout.
2. While the legacy checkout's existing authentication still works, update it
   to the release containing this installer. Then remove any token-bearing
   userinfo from its origin, export the token separately, and deploy once:

   ```bash
   git fetch origin main
   git switch main
   git merge --ff-only origin/main
   git remote set-url origin https://github.com/ronniekai999/AuroraPro.App.git
   export AURORA_GIT_TOKEN=github_pat_xxxxx
   sudo --preserve-env=AURORA_GIT_TOKEN ./scripts/install.sh
   unset AURORA_GIT_TOKEN
   ```

   Never place the token in the Git URL. The installer rejects HTTPS origins
   containing userinfo and migrates authentication to Aurora's root-only
   credential file. This verified legacy service also supplies the provenance
   bridge used to record its existing Aurora UID/GID and local database
   identities. If those artifacts are incomplete, verify the identities
   manually and add `AURORA_ADOPT_EXISTING_IDENTITIES=true` to this one
   migration run.
3. Verify the public endpoint before announcing the new command:

   ```bash
   curl -fsSI https://aurorapro.app/install.sh
   ```

   It must return `200`, a shell-script content type, and `Cache-Control:
   no-store`.
4. Run the public bootstrap once with the same fork and branch. That refreshes
   the managed source, updater script, systemd units, credential location, and
   merged installer configuration.
5. Verify `/api/health`, `aurora-update.timer`, and
   `/var/lib/aurora/update-status.json`.

The old user checkout is not moved or deleted; scheduled updates switch to
`/var/lib/aurora/source`. If that managed path already has local changes, clean
or move it aside. If its origin differs from the selected repository, move the
entire managed checkout aside and rerun the bootstrap rather than forcing an
origin rewrite.

Until step 3 succeeds, keep the previous authenticated-checkout install path
available to operators; the live endpoint currently depends on the new Aurora
deployment.
