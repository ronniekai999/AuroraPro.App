# Recovering and validating Aurora updates

A source checkout matching `origin/main` does not prove that the installed
binary and frontend were rebuilt. Older updaters advanced the checkout before
building and then skipped the same revision on the next attempt. A missing
`npm`, failed dependency install, or compiler error could leave old assets
running indefinitely while the UI reported an up-to-date checkout.

## Toolchain failures

The updater runs as a system service, not an interactive login shell. A Node
installation activated only by a user's shell profile is not sufficient.
Check the deployed unit and any drop-ins with:

```bash
sudo systemctl cat aurora-update.service
sudo journalctl -u aurora-update.service -n 80 --no-pager
sudo tail -n 80 /var/log/aurora/update.log
```

Provide a working `node` and `npm` on the service's PATH. A current compatible
Node 22.x installation is the existing CI choice; dependency engine requirements
in `static/redesign/app/package-lock.json` may be stricter than Vite's minimum.
The updater checks that both executables exist and their `--version` commands
run before changing the checkout. The existing Node version gate remains in
place; an unrecognised version string is different from an absent executable.

Install or repair the toolchain using the host's approved package source, or
configure a stable, administrator-owned toolchain directory in the service's
PATH. Do not add user-writable executable directories to this root service.
The updater intentionally does not install packages or execute remote setup
scripts unattended. After repairing the environment, retry **Update Now** or
start `aurora-update.service`. No new upstream commit is needed after a build
failure with the fixed updater.

## One-time bootstrap for an already-stalled older installation

Merging this fix alone cannot repair a missing npm installation or replace an
already-installed old workhorse that exits before installing anything. First
repair Node/npm. Then install the fixed workhorse from a trusted, reviewed
checkout containing the merged fix. This updates only the updater executable;
it does not rebuild or restart Aurora yet.

The recipe below uses the configured source mirror. Bring that mirror to the
reviewed merged revision through the normal verified update path first. If the
old updater has already fetched and merged the fix before failing its build,
the mirror may already contain it. Do not assume a random local clone is current.
It must have a clean tracked tree, match the configured upstream target, and
pass the configured signature policy. Never disable signature verification to
work around a missing signing key. This recipe deliberately does not fetch,
merge, install OS packages, or alter service units.

```bash
sudo bash <<'BASH'
set -euo pipefail
set -a
. /etc/aurora/aurora.env
set +a
: "${AURORA_SOURCE_DIR:?Missing configured source directory}"
: "${AURORA_EXPECTED_REMOTE:?Missing expected remote; reconcile configuration first}"
branch="${AURORA_UPDATE_BRANCH:-main}"
exec 9>/var/lock/aurora-deploy.lock
flock -n 9 || { echo 'Another deploy is running; retry after it finishes.' >&2; exit 1; }
cd "$AURORA_SOURCE_DIR"
[ "$(git remote get-url origin)" = "$AURORA_EXPECTED_REMOTE" ]
git diff --quiet HEAD
git diff --cached --quiet
sha="$(git rev-parse HEAD)"
[ "$sha" = "$(git rev-parse "origin/$branch")" ]
case "${AURORA_UPDATE_REQUIRE_SIGNED:-false}" in
  true|1)
    if [ -n "${AURORA_UPDATE_ALLOWED_SIGNERS:-}" ]; then
      git -c gpg.format=ssh \
        -c "gpg.ssh.allowedSignersFile=$AURORA_UPDATE_ALLOWED_SIGNERS" verify-commit "$sha"
    else
      git verify-commit "$sha"
    fi ;;
  *) echo 'WARNING: this host does not require signed update commits.' >&2 ;;
esac
tmp="$(mktemp /usr/local/bin/aurora-update.XXXXXX)"
trap 'rm -f -- "$tmp"' EXIT
git show "$sha:scripts/aurora-update.sh" > "$tmp"
grep -q '^DEPLOY_STATE_DIR=/var/lib/aurora-updater$' "$tmp" || {
  echo 'This checkout does not contain the deployment-state fix.' >&2; exit 1;
}
bash -n "$tmp"
backup="/usr/local/bin/aurora-update.bootstrap-backup.$(date -u +%Y%m%dT%H%M%SZ).$$"
[ ! -f /usr/local/bin/aurora-update ] || cp -p /usr/local/bin/aurora-update "$backup"
chmod 755 "$tmp"
mv -f -- "$tmp" /usr/local/bin/aurora-update
echo "Installed updater from $sha; prior workhorse backup: $backup"
BASH

sudo systemctl start aurora-update.service
sudo journalctl -u aurora-update.service -n 80 --no-pager
```

The final service start rebuilds and deploys, including Aurora's existing
viewer-drain and restart behavior. Schedule it for an acceptable interruption
window. `origin/<branch>` in the bootstrap recipe is the already-fetched local
tracking ref, not a new remote freshness check.

## Deployment state and retries

The root updater owns `/var/lib/aurora-updater` (mode 0700), separate from the
application-owned UI status and installation directories:

- `deployed` holds the last successful target SHA plus an artifact fingerprint.
  It is written only after restart, verification (below), and updater refresh
  succeed.
- `pending` records installation intent after both builds pass and before the
  first live-file mutation. A failure, crash, or rollback during installation
  leaves it present. It is cleared only after verification, updater refresh, and
  rollback snapshot retirement succeed.
- `build/` is an export of the target commit (`git archive`), where both the
  frontend and the binary are built. It is removed when the run ends. Nothing is
  built from the checkout itself, so untracked or ignored files there (a stray
  `.go` file, a leftover `static/v2`) can never reach an installed artifact, and
  a target without the SPA source fails instead of reusing an older bundle.
- `rollback/` holds the prior binary, static tree and migration files as a
  single generation.
  Both are copied into a private staging directory before one rename publishes
  the generation. Retries and newer targets preserve it intact while an install
  is pending. After health succeeds, one rename detaches the whole generation
  before recursive cleanup. An interruption during cleanup cannot leave one
  old component active alongside a new component; the next install captures
  the healthy live pair together. Abandoned staging and retired directories
  are cleaned under the shared lock before preparing another snapshot.

## What a deploy has to prove

After the restart, the updater accepts the new release only when, within about
a minute, all of these hold, and still hold for the same process a few seconds
later (so a binary that crashes right after its first answer, and is restarted
by `Restart=on-failure`, does not pass):

- `aurora.service`'s main process (`systemctl show -p MainPID`) is running
  exactly the binary just built: `/proc/<pid>/exe` hashes to it. A drop-in
  `ExecStart` pointing at some other file fails here.
- `GET /api/health` answers `status: "ok"` with `db_connected: true`. The route
  answers 200 `"degraded"` with the database down; that no longer passes.
- `GET /v2/` is byte-identical to the `index.html` just installed, so the
  server is serving the new frontend and not some other static directory.

The address comes from `/var/lib/aurora/serving.json`, which the server writes
once it has run its migrations and bound its listener: its pid, the bound
address, and whether it terminates TLS itself (and for which name). The updater
believes it only when its pid is the current main process. Otherwise it uses
`AURORA_HOST`/`AURORA_PORT` from `aurora.env`, else `127.0.0.1:8484`, over plain
HTTP. A TLS listener is probed with certificate checks off; which process answers
is established by its pid and executable, not by the certificate.

Any failure once installation has begun, including a failed `systemctl restart`,
a failed copy, a failed verification, an unexpected abort, `SIGTERM` from the
unit's `TimeoutStartSec`, or Ctrl-C, restores the rollback generation and
verifies the restored service the same way. When the failure came before the
restart and the running process already runs the restored binary, it is not
restarted. The status message names the check that failed, and whether the
restored release verified. Only `SIGKILL` (or power loss) can still leave a
half-installed tree; the `pending` record then blocks automatic retries.

The viewer drain and any Ollama model pull now run before the first live file
changes. They used to run after the swap, so for up to five minutes the old
backend served the new frontend.

Browser tabs left open across a deploy run the build they loaded, and the
previous build's chunks are deleted. The SPA compares the build id it was loaded
with (`<meta name="aurora-build">`) with the one `/v2/` serves, on focus, on
becoming visible, every five minutes, and at once when a chunk fails to load,
and shows a **Reload** notice when they differ. It never reloads by itself.

A failed frontend/dependency/Go build has not started installation, so the
same revision is retried normally. A failed or interrupted **installation** is
different: the same revision is paused to avoid restarting a broken release
on every timer tick. Inspect logs, service health, and any database migration
changes before explicitly retrying:

```bash
sudo /usr/local/bin/aurora-update --retry
```

`--retry` deliberately rebuilds even an otherwise-current deployment. It does
not bypass the shared lock, source cleanliness, expected-remote, signature,
ancestry, or toolchain checks. A newer upstream revision can supersede a valid
pending SHA; a malformed pending record requires explicit recovery. Do not
edit or remove the ledger simply to make the UI look healthy.

On installations with no successful ledger yet, the first fixed-updater run
performs a conservative rebuild, even when checkout HEAD matches upstream.
After a healthy deployment, the workhorse replaces its installed copy from the
exact verified commit so later updater fixes can propagate.

## Scope and verification limits

The fingerprint covers content, paths, and modes of the binary, installed
updater, static tree, and migrations. It detects replacements by manual
redeploys/installer runs that do not maintain this ledger. An idle check reads
these artifacts; it is not the old constant-time HEAD comparison. Symlinks and
other non-regular artifacts are rejected rather than followed. Custom layouts
using them need deliberate integration before adopting this updater.

This is not a transactional deployment redesign. Database migrations are **not**
rolled back; only the migration files are, so a restored binary does not apply
the failed release's migrations at its next start (`db.RunMigrations` ignores
applied versions that have no file). A rollback generation kept from an attempt
by an older updater has no migration snapshot, and leaves the new files in
place. Verification attests the running binary by content, not by Git SHA, and
runs only after a deploy: idle ticks check the installed files, not the running
process. `old_sha` in the UI status remains the source checkout at the start, not
a claimed previous running revision. The ledger is a record of successful
deployment, not continuous service-health monitoring. A slow box whose builds,
viewer drain (up to five minutes) and two verifications exceed the unit's
10-minute `TimeoutStartSec` is stopped by systemd; mid-install that triggers the
rollback above. `install.sh` and `redeploy.sh` still use their own
`localhost:8484` health checks.

Run the network-free regression suite on Linux:

```bash
bash -n scripts/aurora-update.sh
python3 scripts/aurora-update-test.py -v
sudo python3 scripts/aurora-update-test.py -v
```

The suite uses real temporary Git repositories, file operations, and locks with
stubbed build/service/health commands. The stubbed service keeps a main pid and
an executable per pid, and the stubbed curl answers only where that process
listens, so verification is tested against what runs rather than against a
restart count. It includes process kills during snapshot
preparation and retirement, plus a newer failed deployment that must restore a
matching binary/frontend pair. These checks do not model filesystem durability
after power loss or exhaustively cover storage failures. It validates updater
control flow, not
actual npm compilation, Go compilation, PostgreSQL migrations, systemd behavior,
or media playback. The repository's existing Go and SPA CI jobs remain necessary,
as does independent adversarial review of the final diff.
