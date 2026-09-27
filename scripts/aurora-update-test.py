#!/usr/bin/env python3
"""Run the actual updater against disposable roots and real local Git repos.

Only build/service commands are stubbed. No network, root, npm, Go, database,
or systemd is used. Absolute deployment paths are rewritten in a temporary
COPY; a restricted PATH makes missing-tool cases independent of the host.
"""
from __future__ import annotations

import argparse
import fcntl
import json
import os
from pathlib import Path
import shlex
import shutil
import stat
import subprocess
import tempfile
import unittest

parser = argparse.ArgumentParser(add_help=False)
parser.add_argument("--updater", type=Path,
                    default=Path(__file__).with_name("aurora-update.sh"))
options, unittest_args = parser.parse_known_args()
UPDATER = options.updater.resolve().read_text()
BASH, GIT = shutil.which("bash"), shutil.which("git")
if not BASH or not GIT:
    raise SystemExit("These tests require bash and git.")


class UpdaterTest(unittest.TestCase):
    def setUp(self) -> None:
        work = tempfile.TemporaryDirectory(prefix="aurora-updater-test-")
        self.addCleanup(work.cleanup)
        self.root = Path(work.name)
        self.bin, self.control, self.home = [self.root / x for x in ("bin", "control", "home")]
        for directory in (self.bin, self.control, self.home):
            directory.mkdir()
        self.source, self.seed, self.remote = [self.root / x for x in ("source", "seed", "remote.git")]
        self.live = self.root / "live"
        self.live_binary, self.live_updater = self.live / "aurora", self.live / "aurora-update"
        self.state_dir = self.root / "deploy-state"
        self.status = self.root / "ui-state/update-status.json"
        self.events, self.lock = self.root / "events", self.root / "deploy.lock"
        self.env = {
            **os.environ, "HOME": str(self.home), "GIT_CONFIG_GLOBAL": "/dev/null",
            "GIT_CONFIG_NOSYSTEM": "1", "GIT_TERMINAL_PROMPT": "0",
            "GIT_AUTHOR_NAME": "Updater fixture", "GIT_AUTHOR_EMAIL": "fixture@example.invalid",
            "GIT_COMMITTER_NAME": "Updater fixture", "GIT_COMMITTER_EMAIL": "fixture@example.invalid",
            "TEST_CONTROL": str(self.control), "TEST_EVENTS": str(self.events),
            "TEST_INSTALL_BIN": str(self.live_binary), "TEST_NODE_VERSION": "v22.22.2",
        }
        for key in list(self.env):
            if key.startswith(("AURORA_", "LLM_")) or key in {
                "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "BASH_ENV", "ENV"
            }:
                self.env.pop(key)
        for name in ("bash", "python3", "git", "dirname", "mkdir", "date", "mv", "chmod",
                     "rm", "tee", "mktemp", "install", "cp", "find", "seq", "sed", "tr",
                     "grep", "flock", "cat", "touch"):
            executable = shutil.which(name)
            if not executable:
                self.fail(f"Required fixture tool missing: {name}")
            (self.bin / name).symlink_to(executable)
        self.stub("node", '''
[ ! -f "$TEST_CONTROL/node-broken" ] || exit 42
printf '%s\\n' "$TEST_NODE_VERSION"
''')
        self.stub("npm", '''
case "${1:-}" in
  --version)
    [ ! -f "$TEST_CONTROL/npm-broken" ] || exit 42
    echo 10.9.0; exit 0 ;;
  ci|install)
    echo "npm:$1" >> "$TEST_EVENTS"
    [ ! -f "$TEST_CONTROL/deps-fail" ]; exit $? ;;
  run)
    echo "npm:build" >> "$TEST_EVENTS"
    [ ! -f "$TEST_CONTROL/build-fail" ] || exit 3
    out=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = --outDir ]; then shift; out="$1"; fi
      shift
    done
    [ -n "$out" ] || exit 4
    mkdir -p "$out/assets"
    cat "$AURORA_SOURCE_DIR/revision" > "$out/index.html"
    echo 'frontend module' > "$out/assets/app.js"
    exit 0 ;;
esac
exit 90
''')
        self.stub("go", '''
[ "${1:-}" = version ] && { echo 'go version fixture'; exit 0; }
echo 'go:build' >> "$TEST_EVENTS"
[ ! -f "$TEST_CONTROL/go-fail" ] || exit 5
out=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = -o ]; then shift; out="$1"; fi
  shift
done
[ -n "$out" ] || exit 6
printf 'binary ' > "$out"
cat "$AURORA_SOURCE_DIR/revision" >> "$out"
''')
        self.stub("curl", '''
echo 'health:check' >> "$TEST_EVENTS"
if [ -f "$TEST_CONTROL/health-fail" ] && grep -q new "$TEST_INSTALL_BIN"; then exit 22; fi
echo '{"status":"ok"}'
''')
        self.stub("systemctl", '''
[ "$*" = 'restart aurora' ] || exit 91
echo 'service:restart' >> "$TEST_EVENTS"
[ ! -f "$TEST_CONTROL/restart-fail" ]
''')
        self.stub("chown", "exit 0\n")
        self.stub("pgrep", "exit 1\n")
        self.stub("sleep", "exit 0\n")
        self.env["PATH"] = str(self.bin)
        self.git("init", "--quiet", "--initial-branch=main", str(self.seed))
        for name, text in {
            "scripts/aurora-update.sh": UPDATER,
            "static/redesign/app/package.json": "{}\n",
            "static/redesign/app/package-lock.json": "{}\n",
            "migrations/001.sql": "-- fixture migration\n",
            "revision": "old\n", ".gitignore": "aurora.new\n",
        }.items():
            path = self.seed / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
        self.git("-C", str(self.seed), "add", ".")
        self.git("-C", str(self.seed), "commit", "--quiet", "-m", "base")
        self.old = self.git("-C", str(self.seed), "rev-parse", "HEAD")
        self.git("clone", "--quiet", "--bare", str(self.seed), str(self.remote))
        self.git("clone", "--quiet", str(self.remote), str(self.source))
        (self.seed / "revision").write_text("new\n")
        self.git("-C", str(self.seed), "commit", "--quiet", "-am", "new release")
        self.target = self.git("-C", str(self.seed), "rev-parse", "HEAD")
        self.git("-C", str(self.seed), "push", "--quiet", str(self.remote), "main")
        (self.live / "static/v2").mkdir(parents=True)
        # Rollback assertions must not depend on the caller's directory umask.
        (self.live / "static").chmod(0o755)
        (self.live / "migrations").mkdir()
        self.live_binary.write_text("old binary\n")
        self.live_updater.write_text("old updater\n")
        (self.live / "static/v2/index.html").write_text("old frontend\n")
        (self.live / "migrations/001.sql").write_text("-- old migration\n")
        self.status.parent.mkdir()
        self.status.write_text('{"state":"sentinel"}\n')
        self.config = self.root / "aurora.env"
        self.config.write_text(
            f"AURORA_SOURCE_DIR={shlex.quote(str(self.source))}\n"
            f"AURORA_EXPECTED_REMOTE={shlex.quote(str(self.remote))}\nLLM_ENABLED=false\n")
        rewrites = {
            "/etc/aurora/aurora.env": str(self.config),
            "/usr/local/bin/aurora": str(self.live_binary),
            "/usr/local/go/bin": str(self.root / "absent-go"),
            "/var/lib/aurora-updater": str(self.state_dir),
            "/var/lib/aurora/": str(self.status.parent) + "/",
            "/var/log/aurora/": str(self.root / "logs") + "/",
            "/var/lock/aurora-deploy.lock": str(self.lock), "/opt/aurora": str(self.live),
        }
        runner = UPDATER
        for old, new in rewrites.items():
            runner = runner.replace(old, new)
        for forbidden in ("=/opt/aurora", "=/usr/local/bin/aurora", "=/var/lib/aurora",
                          "=/var/lock/aurora", "-f /etc/aurora"):
            self.assertNotIn(forbidden, runner)
        self.runner = self.root / "runner.sh"
        self.runner.write_text(runner)

    def stub(self, name: str, body: str) -> None:
        path = self.bin / name
        if path.is_symlink():
            path.unlink()
        path.write_text("#!/bin/sh\n" + body)
        path.chmod(0o755)

    def git(self, *args: str) -> str:
        result = subprocess.run([GIT, *args], env=self.env, text=True,
                                capture_output=True, timeout=15, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout.strip()

    def run_update(self, *args: str, expected: int = 0) -> dict:
        result = subprocess.run([BASH, str(self.runner), *args], env=self.env,
                                text=True, capture_output=True, timeout=30, check=False)
        log = self.root / "logs/update.log"
        details = result.stdout + result.stderr + (log.read_text() if log.exists() else "")
        self.assertEqual(result.returncode, expected, details)
        return json.loads(self.status.read_text())

    def head(self) -> str:
        return self.git("-C", str(self.source), "rev-parse", "HEAD")

    def count(self, event: str) -> int:
        return self.events.read_text().splitlines().count(event) if self.events.exists() else 0

    def flag(self, name: str) -> None:
        (self.control / name).touch()

    def fail_migration_copy(self) -> None:
        real_cp = shutil.which("cp")
        self.stub("cp", f'''
case "$*" in *migrations*) exit 28 ;; esac
exec {shlex.quote(real_cp)} "$@"
''')

    def restore_cp(self) -> None:
        (self.bin / "cp").unlink()
        (self.bin / "cp").symlink_to(shutil.which("cp"))

    def publish_release(self, revision: str) -> str:
        (self.seed / "revision").write_text(revision + "\n")
        self.git("-C", str(self.seed), "commit", "--quiet", "-am", revision)
        sha = self.git("-C", str(self.seed), "rev-parse", "HEAD")
        self.git("-C", str(self.seed), "push", "--quiet", str(self.remote), "main")
        return sha

    def assert_old_assets(self) -> None:
        self.assertEqual(self.live_binary.read_text(), "old binary\n")
        self.assertEqual((self.live / "static/v2/index.html").read_text(), "old frontend\n")
        self.assertEqual(self.count("service:restart"), 0)

    def check_bad_tool(self, name: str, missing: bool) -> None:
        if missing:
            (self.bin / name).unlink()
        else:
            self.flag(name + "-broken")
        status = self.run_update(expected=1)
        self.assertEqual(status["state"], "misconfigured")
        self.assertIn(name, status["message"])
        self.assertEqual(self.head(), self.old)
        self.assert_old_assets()

    def test_missing_npm_stops_before_merge(self) -> None:
        self.check_bad_tool("npm", True)

    def test_missing_node_stops_before_merge(self) -> None:
        self.check_bad_tool("node", True)

    def test_broken_npm_stops_before_merge(self) -> None:
        self.check_bad_tool("npm", False)

    def test_broken_node_stops_before_merge(self) -> None:
        self.check_bad_tool("node", False)


    def test_old_node_still_has_specific_error(self) -> None:
        self.env["TEST_NODE_VERSION"] = "v18.19.1"
        status = self.run_update(expected=1)
        self.assertEqual(status["state"], "misconfigured")
        self.assertIn("Node.js", status["message"])
        self.assertEqual(self.head(), self.old)
        self.assert_old_assets()

    def test_dependency_failure_does_not_run_build(self) -> None:
        self.flag("deps-fail")
        self.assertEqual(self.run_update(expected=1)["state"], "failed")
        self.assertEqual(self.count("npm:ci"), 1)
        self.assertEqual(self.count("npm:build"), 0)
        self.assertEqual(self.count("go:build"), 0)
        self.assertEqual(self.head(), self.target)
        self.assert_old_assets()
        self.assertFalse((self.state_dir / "pending").exists())

    def test_same_revision_retries_after_frontend_failure(self) -> None:
        self.flag("build-fail")
        self.run_update(expected=1)
        self.assertEqual(self.head(), self.target)
        self.assert_old_assets()
        (self.control / "build-fail").unlink()
        self.assertEqual(self.run_update()["state"], "success")
        self.assertEqual(self.count("npm:build"), 2)
        self.assertEqual(self.live_binary.read_text(), "binary new\n")
        self.assertEqual((self.live / "static/v2/index.html").read_text(), "new\n")
        self.assertEqual((self.state_dir / "deployed").read_text().split()[0], self.target)
        self.assertFalse((self.state_dir / "pending").exists())
        self.assertEqual(self.live_updater.read_text(), UPDATER)
        self.assertEqual(self.git("-C", str(self.source), "status", "--porcelain"), "")

    def test_same_revision_retries_after_go_failure(self) -> None:
        self.flag("go-fail")
        self.run_update(expected=1)
        self.assertEqual(self.head(), self.target)
        self.assert_old_assets()
        (self.control / "go-fail").unlink()
        self.assertEqual(self.run_update()["state"], "success")
        self.assertEqual(self.count("go:build"), 2)

    def test_successful_deployment_is_noop(self) -> None:
        self.run_update()
        before = self.events.read_text()
        self.assertEqual(self.run_update()["state"], "idle")
        self.assertEqual(self.events.read_text(), before)

    def test_checkout_at_target_without_marker_rebuilds(self) -> None:
        self.git("-C", str(self.source), "pull", "--quiet", "--ff-only")
        self.assertEqual(self.head(), self.target)
        self.assertEqual(self.run_update()["state"], "success")
        self.assertEqual(self.count("npm:build"), 1)

    def test_corrupt_deployed_marker_is_not_success(self) -> None:
        self.run_update()
        (self.state_dir / "deployed").write_text(self.target + " nonsense\n")
        self.assertEqual(self.run_update()["state"], "success")
        self.assertEqual(self.count("npm:build"), 2)

    def check_artifact_drift(self, relative: str) -> None:
        self.run_update()
        (self.live / relative).write_text("manually replaced\n")
        self.assertEqual(self.run_update()["state"], "success")
        self.assertEqual(self.count("npm:build"), 2)

    def test_binary_drift(self) -> None:
        self.check_artifact_drift("aurora")

    def test_asset_drift(self) -> None:
        self.check_artifact_drift("static/v2/assets/app.js")

    def test_migration_drift(self) -> None:
        self.check_artifact_drift("migrations/001.sql")

    def test_updater_drift(self) -> None:
        self.check_artifact_drift("aurora-update")


    def test_held_lock_changes_neither_head_nor_status(self) -> None:
        with self.lock.open("w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            status = self.run_update()
        self.assertEqual(status, {"state": "sentinel"})
        self.assertEqual(self.head(), self.old)
        self.assert_old_assets()

    def test_missing_flock_fails_closed(self) -> None:
        (self.bin / "flock").unlink()
        self.run_update(expected=1)
        self.assertEqual(self.head(), self.old)
        self.assert_old_assets()

    def test_dirty_source_is_not_overwritten(self) -> None:
        (self.source / "revision").write_text("local edit\n")
        self.assertEqual(self.run_update(expected=1)["state"], "failed")
        self.assertEqual(self.head(), self.old)
        self.assert_old_assets()

    def test_unsigned_commit_is_not_merged(self) -> None:
        with self.config.open("a") as config:
            config.write("AURORA_UPDATE_REQUIRE_SIGNED=true\n")
        self.assertEqual(self.run_update(expected=1)["state"], "failed")
        self.assertEqual(self.head(), self.old)
        self.assert_old_assets()

    def test_local_ahead_commit_is_not_built_as_verified_target(self) -> None:
        self.git("-C", str(self.source), "pull", "--quiet", "--ff-only")
        (self.source / "revision").write_text("unverified local\n")
        self.git("-C", str(self.source), "commit", "--quiet", "-am", "local")
        local = self.head()
        self.assertEqual(self.run_update(expected=1)["state"], "failed")
        self.assertEqual(self.head(), local)
        self.assertEqual(self.count("npm:build"), 0)
        self.assert_old_assets()

    def test_health_failure_rolls_back_and_does_not_loop(self) -> None:
        self.flag("health-fail")
        self.assertEqual(self.run_update(expected=1)["state"], "failed")
        self.assertEqual(self.live_binary.read_text(), "old binary\n")
        self.assertEqual((self.live / "static/v2/index.html").read_text(), "old frontend\n")
        self.assertFalse((self.state_dir / "deployed").exists())
        self.assertEqual((self.state_dir / "pending").read_text().strip(), self.target)
        before = self.events.read_text()
        self.run_update(expected=1)
        self.assertEqual(self.events.read_text(), before)
        (self.control / "health-fail").unlink()
        self.assertEqual(self.run_update("--retry")["state"], "success")
        self.assertFalse((self.state_dir / "pending").exists())

    def test_restart_failure_is_not_marked_deployed(self) -> None:
        self.flag("restart-fail")
        self.run_update(expected=1)
        self.assertFalse((self.state_dir / "deployed").exists())
        self.assertTrue((self.state_dir / "pending").exists())
        before = self.events.read_text()
        self.run_update(expected=1)
        self.assertEqual(self.events.read_text(), before)

    def test_explicit_retry_rebuilds_current_revision(self) -> None:
        self.run_update()
        self.assertEqual(self.run_update("--retry")["state"], "success")
        self.assertEqual(self.count("npm:build"), 2)

    def test_corrupt_pending_record_requires_explicit_recovery(self) -> None:
        self.state_dir.mkdir()
        (self.state_dir / "pending").write_text("corrupt\n")
        self.run_update(expected=1)
        self.assertEqual(self.head(), self.old)
        self.assert_old_assets()
        self.assertEqual(self.run_update("--retry")["state"], "success")

    def test_new_target_can_follow_failed_install(self) -> None:
        self.flag("health-fail")
        self.run_update(expected=1)
        (self.control / "health-fail").unlink()
        (self.seed / "revision").write_text("new fixed\n")
        self.git("-C", str(self.seed), "commit", "--quiet", "-am", "fix release")
        self.git("-C", str(self.seed), "push", "--quiet", str(self.remote), "main")
        self.assertEqual(self.run_update()["state"], "success")
        self.assertEqual(self.live_binary.read_text(), "binary new fixed\n")

    def check_partial_install_then_failed_recovery(self, newer_target: bool) -> None:
        # B promotes its binary, then fails before the static swap. The next
        # attempt must retain A as the rollback source rather than snapshot B.
        self.fail_migration_copy()
        self.run_update(expected=1)
        self.assertEqual(self.live_binary.read_text(), "binary new\n")
        self.assertEqual((self.live / "static/v2/index.html").read_text(), "old frontend\n")
        self.assertEqual((self.state_dir / "rollback-binary").read_text(), "old binary\n")
        self.assertEqual((self.state_dir / "rollback-static/v2/index.html").read_text(),
                         "old frontend\n")

        self.restore_cp()
        args = ("--retry",)
        if newer_target:
            self.publish_release("newer broken")
            args = ()
        self.flag("health-fail")
        self.run_update(*args, expected=1)
        self.assertEqual(self.live_binary.read_text(), "old binary\n")
        self.assertEqual((self.live / "static/v2/index.html").read_text(), "old frontend\n")
        self.assertEqual(stat.S_IMODE((self.live / "static").stat().st_mode), 0o755)

        # Repeated explicit failure must still roll back to A, not to either
        # failed candidate B/C.
        self.run_update("--retry", expected=1)
        self.assertEqual(self.live_binary.read_text(), "old binary\n")
        self.assertEqual((self.live / "static/v2/index.html").read_text(), "old frontend\n")

    def test_explicit_retry_preserves_original_snapshot(self) -> None:
        self.check_partial_install_then_failed_recovery(False)

    def test_new_target_preserves_original_snapshot(self) -> None:
        self.check_partial_install_then_failed_recovery(True)

    def test_interrupted_snapshot_is_never_published_or_used(self) -> None:
        real_cp = shutil.which("cp")
        self.stub("cp", f'''
case "$*" in
  *rollback-static*) mkdir -p "$4"; echo partial > "$4/partial"; exit 28 ;;
esac
exec {shlex.quote(real_cp)} "$@"
''')
        self.run_update(expected=1)
        self.assert_old_assets()
        self.assertEqual((self.state_dir / "rollback-binary").read_text(), "old binary\n")
        self.assertFalse((self.state_dir / "rollback-static").exists())
        self.assertEqual(list(self.state_dir.glob(".rollback-static.*")), [])

        # Another preparation failure leaves the already complete binary
        # snapshot intact; a later retry can finish and deploy normally.
        self.run_update("--retry", expected=1)
        self.assertEqual((self.state_dir / "rollback-binary").read_text(), "old binary\n")
        self.restore_cp()
        self.assertEqual(self.run_update("--retry")["state"], "success")


    def test_npm_install_failure_also_stops_before_build(self) -> None:
        # Exercise the supported no-lockfile fallback, not just npm ci.
        (self.seed / "static/redesign/app/package-lock.json").unlink()
        self.git("-C", str(self.seed), "commit", "--quiet", "-am", "no lockfile")
        self.git("-C", str(self.seed), "push", "--quiet", str(self.remote), "main")
        self.flag("deps-fail")
        self.run_update(expected=1)
        self.assertEqual(self.count("npm:install"), 1)
        self.assertEqual(self.count("npm:build"), 0)
        self.assert_old_assets()

    def test_bundle_fallback_does_not_require_node_or_npm(self) -> None:
        shutil.rmtree(self.seed / "static/redesign")
        bundle = self.seed / "static/v2"
        bundle.mkdir()
        (bundle / "index.html").write_text("committed bundle\n")
        self.git("-C", str(self.seed), "add", "-A")
        self.git("-C", str(self.seed), "commit", "--quiet", "-m", "bundle only")
        self.git("-C", str(self.seed), "push", "--quiet", str(self.remote), "main")
        self.git("-C", str(self.source), "pull", "--quiet", "--ff-only")
        (self.bin / "node").unlink()
        (self.bin / "npm").unlink()
        self.assertEqual(self.run_update()["state"], "success")
        self.assertEqual(self.count("npm:build"), 0)
        self.assertEqual((self.live / "static/v2/index.html").read_text(), "committed bundle\n")

    def test_incomplete_install_is_blocked_not_reported_idle(self) -> None:
        self.fail_migration_copy()
        self.run_update(expected=1)
        self.assertTrue((self.state_dir / "pending").exists())
        self.assertFalse((self.state_dir / "deployed").exists())
        self.assertEqual(self.count("service:restart"), 0)
        before = self.events.read_text()
        self.run_update(expected=1)
        self.assertEqual(self.events.read_text(), before)

    def test_failed_success_record_write_never_reports_success(self) -> None:
        real_mv = shutil.which("mv")
        self.stub("mv", f'''
for arg in "$@"; do
  case "$arg" in */deploy-state/deployed) exit 28 ;; esac
done
exec {shlex.quote(real_mv)} "$@"
''')
        status = self.run_update(expected=1)
        self.assertEqual(status["state"], "failed")
        self.assertFalse((self.state_dir / "deployed").exists())
        self.assertTrue((self.state_dir / "pending").exists())
        self.assertEqual(self.count("service:restart"), 1)

    def test_pending_record_written_before_live_mutations(self) -> None:
        real_mv = shutil.which("mv")
        self.stub("mv", f'''
for arg in "$@"; do
  case "$arg" in */deploy-state/pending) exit 28 ;; esac
done
exec {shlex.quote(real_mv)} "$@"
''')
        self.run_update(expected=1)
        self.assert_old_assets()
        self.assertFalse((self.state_dir / "deployed").exists())

    def test_unknown_cli_flag_does_not_mutate(self) -> None:
        self.run_update("--not-a-real-option", expected=2)
        self.assertEqual(self.head(), self.old)
        self.assert_old_assets()

    def test_help_does_not_mutate(self) -> None:
        self.assertEqual(self.run_update("--help"), {"state": "sentinel"})
        self.assertEqual(self.head(), self.old)
        self.assert_old_assets()


if __name__ == "__main__":
    unittest.main(argv=[__file__, *unittest_args])
