# Installer design and rollout plan

## Research conclusion

Aurora's previous install path required users to clone the repository, enter
the checkout, and invoke a 1,700-line root installer. The desired Swizzin
experience is primarily about distribution and lifecycle UX:

- One stable curl/wget bootstrap
- A managed root-owned checkout
- Interactive and unattended modes
- Repeatable install, update, repair, and removal
- Clear platform checks and operational paths

The design references the official
[Swizzin quick start](https://swizzin.ltd/getting-started),
[repository](https://github.com/swizzin/swizzin), and
[project structure](https://swizzin.ltd/dev/structure). No Swizzin GPL source
was copied; Aurora implements the pattern independently.

## Current delivery decision

Aurora's repository is private and currently has no tags, releases, public
binary artifacts, signing manifest, or public installer repository. An
anonymous bootstrap therefore cannot fetch the application source directly.

The first rollout uses:

```text
https://aurorapro.app/install.sh
        │
        ├── host/root/architecture checks
        ├── private GitHub authentication through askpass
        ├── /var/lib/aurora/source managed clone
        └── scripts/install.sh full provisioning
```

The running Aurora server serves the exact repository-root bootstrap copied
into its deployed static tree. That gives the installer a stable public URL
while authorized users authenticate only for the private source checkout.

## Rollout gate

`https://aurorapro.app/install.sh` is not self-bootstrapping before the first
server deployment that contains this route. The existing production
installation must run this release's full installer once, then maintainers must
verify:

```bash
curl -fsSI https://aurorapro.app/install.sh
```

The Swizzin-style command should be published as the primary path only after
that request returns `200` with `Cache-Control: no-store`. Running the public
bootstrap once after the initial deployment also migrates the installed
updater, systemd units, and private credential helper.

## Implemented safeguards

- Download-then-execute curl/wget command that stops on partial/failed transfer
- Linux/systemd and amd64/arm64 preflight before source mutation
- GitHub HTTPS/SSH URL allowlist
- Hidden token prompt through `/dev/tty`
- Askpass authentication instead of token-bearing Git URLs, with inherited
  Git credential helpers reset before Aurora's dedicated helper is considered
- Root-only managed checkout with dirty-tree and remote-origin checks
- Ownership and write-bit validation before every privileged updater Git/build
  operation
- Shared installer/updater/redeploy `flock`
- Persistent root-only installer/updater logs
- Checksum verification for downloaded Go and Node.js toolchains
- Configuration merge helpers that never source/eval operator config
- Secure-cookie configuration when TLS terminates at nginx
- Root-owned, service-read-only deployed artifacts
- Exact, nonempty migration-set staging so deleted SQL cannot survive as stale
  deployment state
- Durable OS-identity, PostgreSQL `system_identifier` plus database/role OIDs,
  proxy, and certificate markers for fail-closed repair and purge decisions
- Same-session PostgreSQL cluster/owner guards immediately before destructive
  database and role DDL
- Durable nonce-bound PostgreSQL creation/recovery state with fsynced,
  monotonic `intent → role-ready → temp-ready → promoted` role/database OID
  checkpoints, so credentials and fresh-install retries converge across
  interruption or power loss
- Persistent systemd conditions plus updater/redeploy checks that keep Aurora
  and deployment jobs stopped until pending database recovery is finalized
- Updater-only env parsing so root builds do not inherit app secrets
- Separate deployed-revision marker so failed releases are retried
- Health rollback for binary/static/on-disk migration assets, with database
  migrations explicitly outside automatic rollback
- Safe noninteractive uninstall; destructive cleanup requires `--purge`
- Shell syntax, ShellCheck, helper, and HTTP endpoint CI coverage

## Follow-up release architecture

The source-build bootstrap is an intermediate distribution model. The
recommended stable-channel endpoint should eventually download signed,
versioned release artifacts instead of compiling a mutable branch as root.

Planned artifacts:

```text
aurora-vX.Y.Z-linux-amd64.tar.gz
aurora-vX.Y.Z-linux-arm64.tar.gz
checksums.txt
manifest.json
manifest.json.sig
SBOM files
```

Planned installed layout:

```text
/opt/aurora/releases/vX.Y.Z/
/opt/aurora/current -> releases/vX.Y.Z
/usr/local/sbin/auroractl
/etc/aurora/installer.conf
/var/backups/aurora/
```

Planned management interface:

```text
auroractl status
auroractl doctor
auroractl update
auroractl rollback
auroractl config validate
auroractl uninstall
```

## Release-phase acceptance criteria

- CI builds the frontend and Go binary with pinned toolchains.
- Target servers do not need Git, Go, Node.js, npm, or a compiler.
- A signed manifest and archive checksum are verified before extraction.
- Installs and updates stage into a new version directory.
- Activation is an atomic symlink switch.
- At least two known-good releases are retained.
- A failed health check restores the prior release.
- Configuration remains byte-for-byte unchanged unless a declared migration
  is required.
- Database backup and migration compatibility policy are explicit.
- Stable updates consume tagged releases, not mutable `main`.
- Debian/Ubuntu and amd64/arm64 integration tests exercise fresh install,
  reinstall, update, rollback, and safe/purge uninstall.

Until those release artifacts and signing keys exist, the documented
bootstrap remains branch-based and the signed-commit updater option should be
enabled wherever the repository's commit-signing policy supports it.
