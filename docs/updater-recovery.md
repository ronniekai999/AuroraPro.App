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
  It is written only after restart, the health check, and updater refresh succeed.
- `pending` records installation intent after both builds pass and before the
  first live-file mutation. A failure, crash, or rollback during installation
  leaves it present. It is cleared only on success.

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

This is not a transactional deployment redesign. The existing install order,
HTTP health check, stream drain, and binary/static rollback remain; database
migrations are **not** rolled back. The HTTP check does not independently attest
the running binary's Git SHA. `old_sha` in the UI status remains the source
checkout at the start, not a claimed previous running revision. The ledger is a
record of successful deployment, not continuous service-health monitoring.

Run the network-free regression suite on Linux:

```bash
bash -n scripts/aurora-update.sh
python3 scripts/aurora-update-test.py -v
sudo python3 scripts/aurora-update-test.py -v
```

The suite uses real temporary Git repositories, file operations, and locks with
stubbed build/service/health commands. It validates updater control flow, not
actual npm compilation, Go compilation, PostgreSQL migrations, systemd behavior,
or media playback. The repository's existing Go and SPA CI jobs remain necessary,
as does independent adversarial review of the final diff.
