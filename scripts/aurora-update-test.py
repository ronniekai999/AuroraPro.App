#!/usr/bin/env python3
"""Run the actual updater against disposable roots and real local Git repos.

Only build/service commands are stubbed. No network, root, npm, Go, database,
or systemd is used. Absolute deployment paths are rewritten in a temporary
COPY; a restricted PATH makes missing-tool cases independent of the host.

The service is modelled, not just counted. The fake systemctl keeps a main pid
and, at each restart, copies the installed binary to <proc>/<pid>/exe, as an
exec would; it writes the serving record a real binary writes. The fake curl
answers as that process: only on the address it listens on, with the health
and frontend it would serve. So verification is exercised against what RUNS,
and a test can make the running process differ from what was installed.
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
import time
import unittest

parser = argparse.ArgumentParser(add_help=False)
parser.add_argument("--updater", type=Path,
                    default=Path(__file__).with_name("aurora-update.sh"))
options, unittest_args = parser.parse_known_args()
UPDATER = options.updater.resolve().read_text()
BASH, GIT = shutil.which("bash"), shutil.which("git")
if not BASH or not GIT:
    raise SystemExit("These tests require bash and git.")


# The service the updater restarts. MainPID and <proc>/<pid>/exe model what
# systemd runs; a restart execs whatever the installed file holds at that
# moment, unless exec-elsewhere models a drop-in ExecStart pointing elsewhere.
PROC_SOCKETS = r"""
# proc_sockets PID HOST:PORT — model PID's /proc/<pid>/fd and TCP tables.
proc_sockets() {
  _port="${2##*:}"; _host="${2%:*}"; _inode=$(( $1 + 5000 ))
  mkdir -p "$TEST_PROC/$1/fd" "$TEST_PROC/$1/net"
  ln -sf "socket:[$_inode]" "$TEST_PROC/$1/fd/3"
  ln -sf "socket:[$(( _inode + 1 ))]" "$TEST_PROC/$1/fd/4"
  case "$_host" in
    '[::]') _table=tcp6 _addr=00000000000000000000000000000000 ;;
    0.0.0.0) _table=tcp _addr=00000000 ;;
    127.0.0.1) _table=tcp _addr=0100007F ;;
  esac
  printf '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n' > "$TEST_PROC/$1/net/tcp"
  cp "$TEST_PROC/$1/net/tcp" "$TEST_PROC/$1/net/tcp6"
  printf '   0: %s:%04X %s:0000 0A 00000000:00000000 00:00000000 00000000   997        0 %s 1 0000000000000000 100 0 0 10 0\n' \
    "$_addr" "$_port" "$_addr" "$_inode" >> "$TEST_PROC/$1/net/$_table"
  # ESTABLISHED (01) from local port 40000 to PostgreSQL: not a listener.
  printf '   1: 0100007F:9C40 0100007F:1538 01 00000000:00000000 00:00000000 00000000   997        0 %s 1 0000000000000000 20 4 0 10 -1\n' \
    "$(( _inode + 1 ))" >> "$TEST_PROC/$1/net/tcp"
}
"""

SYSTEMCTL_STUB = PROC_SOCKETS + r"""
case "$*" in
  'show -p MainPID --value aurora') cat "$TEST_CONTROL/mainpid"; exit 0 ;;
  'restart aurora') ;;
  *) exit 91 ;;
esac
echo 'service:restart' >> "$TEST_EVENTS"
if [ -f "$TEST_CONTROL/restart-fail" ]; then echo 0 > "$TEST_CONTROL/mainpid"; exit 1; fi
if [ -f "$TEST_CONTROL/restart-fail-once" ]; then
  rm -f "$TEST_CONTROL/restart-fail-once"; echo 0 > "$TEST_CONTROL/mainpid"; exit 1
fi
pid=$(cat "$TEST_CONTROL/nextpid")
echo $((pid + 1)) > "$TEST_CONTROL/nextpid"
mkdir -p "$TEST_PROC/$pid"
if [ -f "$TEST_CONTROL/exec-elsewhere" ] && grep -q new "$TEST_INSTALL_BIN"; then
  echo 'binary from elsewhere' > "$TEST_PROC/$pid/exe"
else
  cp "$TEST_INSTALL_BIN" "$TEST_PROC/$pid/exe"
fi
proc_sockets "$pid" "${TEST_LISTEN:-[::]:8484}"
echo "$pid" > "$TEST_CONTROL/mainpid"
if [ ! -f "$TEST_CONTROL/no-serving-record" ]; then
  printf '{"pid": %s, "addr": "%s", "scheme": "%s", "server_name": "%s", "unix_time": 1}\n' \
    "$pid" "${TEST_RECORD_ADDR:-${TEST_LISTEN:-[::]:8484}}" "${TEST_SCHEME:-http}" "${TEST_TLS_NAME:-}" > "$TEST_SERVING"
fi
"""

# Answers as the running process would: only where it listens (TEST_URL_PREFIX),
# a TLS listener only to a client that skips verification with the expected
# --resolve, and with the health and /v2/ that process serves.
CURL_STUB = r"""
url="" insecure=0 resolve="" noproxy="" prev=""
for a in "$@"; do
  case "$a" in http://*|https://*) url="$a" ;; --insecure) insecure=1 ;; esac
  [ "$prev" != --resolve ] || resolve="$a"
  [ "$prev" != --noproxy ] || noproxy="$a"
  prev="$a"
done
# An http_proxy in aurora.env would otherwise take loopback requests elsewhere.
[ "$noproxy" = '*' ] || exit 5
echo "curl:$url" >> "$TEST_EVENTS"
pid=$(cat "$TEST_CONTROL/mainpid")
[ "$pid" != 0 ] || exit 7
exe="$TEST_PROC/$pid/exe"
case "$url" in "${TEST_URL_PREFIX:-http://127.0.0.1:8484}"/*) ;; *) exit 7 ;; esac
case "$url" in https://*) [ "$insecure" = 1 ] || exit 60 ;; esac
[ "$resolve" = "${TEST_RESOLVE:-}" ] || exit 6
pattern=new
[ ! -s "$TEST_CONTROL/health-fail" ] || pattern=$(cat "$TEST_CONTROL/health-fail")
case "$url" in
  */api/health)
    if [ -f "$TEST_CONTROL/health-fail" ] && grep -q "$pattern" "$exe"; then exit 22; fi
    if [ -f "$TEST_CONTROL/db-down" ] && grep -q new "$exe"; then
      if [ "$(cat "$TEST_CONTROL/db-down")" = inconsistent ]; then
        echo '{"status":"ok","db_connected":false}'
      else
        echo '{"status":"degraded","db_connected":false}'
      fi
      exit 0
    fi
    if [ -f "$TEST_CONTROL/unstable" ] && grep -q new "$exe"; then
      # Restart=on-failure: it answers, exits, and systemd starts another.
      next=$(cat "$TEST_CONTROL/nextpid"); echo $((next + 1)) > "$TEST_CONTROL/nextpid"
      mkdir -p "$TEST_PROC/$next"; cp "$exe" "$TEST_PROC/$next/exe"
      echo "$next" > "$TEST_CONTROL/mainpid"
    fi
    echo '{"status":"ok","db_connected":true}' ;;
  */v2/)
    if [ -f "$TEST_CONTROL/term-during-verify" ] && grep -q new "$exe"; then
      # systemd's TimeoutStartSec, after the restart. curl_service runs in the
      # updater's own shell here, so PPID is the updater.
      kill -TERM "$PPID"
    fi
    if [ -f "$TEST_CONTROL/stale-frontend" ] && grep -q new "$exe"; then
      echo 'some other frontend'; exit 0
    fi
    cat "$TEST_LIVE/static/v2/index.html" ;;
  *) exit 22 ;;
esac
"""


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
        self.rollback_dir = self.state_dir / "rollback"
        self.status = self.root / "ui-state/update-status.json"
        self.events, self.lock = self.root / "events", self.root / "deploy.lock"
        self.proc = self.root / "proc"
        self.cache = self.root / "cache"
        self.serving = self.cache / "serving.json"
        self.started = time.time()
        self.env = {
            **os.environ, "HOME": str(self.home), "GIT_CONFIG_GLOBAL": "/dev/null",
            "GIT_CONFIG_NOSYSTEM": "1", "GIT_TERMINAL_PROMPT": "0",
            "GIT_AUTHOR_NAME": "Updater fixture", "GIT_AUTHOR_EMAIL": "fixture@example.invalid",
            "GIT_COMMITTER_NAME": "Updater fixture", "GIT_COMMITTER_EMAIL": "fixture@example.invalid",
            "TEST_CONTROL": str(self.control), "TEST_EVENTS": str(self.events),
            "TEST_INSTALL_BIN": str(self.live_binary), "TEST_NODE_VERSION": "v22.22.2",
            "TEST_PROC": str(self.proc), "TEST_SERVING": str(self.serving),
            "TEST_LIVE": str(self.live),
        }
        for key in list(self.env):
            if key.startswith(("AURORA_", "LLM_", "TLS_")) or key in {
                "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "BASH_ENV", "ENV"
            }:
                self.env.pop(key)
        for name in ("bash", "python3", "git", "dirname", "mkdir", "date", "mv", "chmod",
                     "rm", "tee", "mktemp", "install", "cp", "find", "seq", "sed", "tr",
                     "grep", "flock", "cat", "touch", "cmp", "tar", "ln"):
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
    # cwd is <export>/static/redesign/app: read the EXPORTED revision.
    cat ../../../revision > "$out/index.html"
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
# cwd is the exported tree. A file only the checkout has must never get here.
[ ! -e checkout-only ] || printf 'TAINTED ' >> "$out"
cat ./revision >> "$out"
''')
        self.stub("curl", CURL_STUB)
        self.stub("systemctl", SYSTEMCTL_STUB)
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
        (self.control / "nextpid").write_text("101\n")
        (self.control / "mainpid").write_text("100\n")
        (self.proc / "100").mkdir(parents=True)
        (self.proc / "100/exe").write_text("old binary\n")
        subprocess.run([BASH, "-c", PROC_SOCKETS + 'proc_sockets 100 "[::]:8484"'],
                       env={**self.env, "PATH": os.environ["PATH"]}, check=True)
        self.live_updater.write_text("old updater\n")
        (self.live / "static/v2/index.html").write_text("old frontend\n")
        # Built long ago: a rollback must not hand browsers this mtime back.
        os.utime(self.live / "static/v2/index.html", (1e9, 1e9))
        (self.live / "migrations/001.sql").write_text("-- old migration\n")
        self.status.parent.mkdir()
        self.cache.mkdir()
        self.serving.write_text('{"pid": 100, "addr": "[::]:8484", "scheme": "http"}\n')
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
            "/var/cache/aurora/": str(self.cache) + "/",
            "/var/log/aurora/": str(self.root / "logs") + "/",
            "/var/lock/aurora-deploy.lock": str(self.lock), "/opt/aurora": str(self.live),
            "/proc": str(self.proc),
            # Rounds, not seconds (sleep is a no-op here): keep failing
            # verifications short without changing what they check.
            "VERIFY_TIMEOUT=60": "VERIFY_TIMEOUT=4", "VERIFY_SETTLE=10": "VERIFY_SETTLE=2",
        }
        runner = UPDATER
        for old, new in rewrites.items():
            runner = runner.replace(old, new)
        for forbidden in ("=/opt/aurora", "=/usr/local/bin/aurora", "=/var/lib/aurora",
                          "=/var/lock/aurora", "-f /etc/aurora", "=/proc", "VERIFY_TIMEOUT=60",
                          "=/var/cache/aurora", "VERIFY_SETTLE=10"):
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
        # The install's copy only (`cp -f FILES... <live>/migrations/`), not the
        # snapshot's or the rollback's.
        real_cp = shutil.which("cp")
        self.stub("cp", f'''
case "$1:$*" in -f:*/migrations/) exit 28 ;; esac
exec {shlex.quote(real_cp)} "$@"
''')

    def kill_during_migration_copy(self) -> None:
        # SIGKILL runs no trap: the one way to leave a half-installed tree.
        real_cp = shutil.which("cp")
        self.stub("cp", f'''
case "$1:$*" in -f:*/migrations/) kill -KILL "$PPID"; exit 0 ;; esac
exec {shlex.quote(real_cp)} "$@"
''')

    def running(self) -> str:
        pid = (self.control / "mainpid").read_text().strip()
        return (self.proc / pid / "exe").read_text() if pid != "0" else ""

    def assert_rolled_back(self, status: dict) -> None:
        self.assertEqual(status["state"], "failed")
        self.assertIn("restored the previous installed snapshot", status["message"])
        self.assertEqual(self.live_binary.read_text(), "old binary\n")
        self.assertEqual((self.live / "static/v2/index.html").read_text(), "old frontend\n")
        self.assertEqual((self.live / "migrations/001.sql").read_text(), "-- old migration\n")
        self.assertEqual(self.running(), "old binary\n")
        self.assertGreater((self.live / "static/v2/index.html").stat().st_mtime, self.started - 5)
        self.assertFalse((self.state_dir / "deployed").exists())
        self.assertEqual((self.state_dir / "pending").read_text().strip(), self.head())

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
        (self.seed / "migrations/002.up.sql").write_text("-- new release migration\n")
        self.git("-C", str(self.seed), "add", ".")
        self.git("-C", str(self.seed), "commit", "--quiet", "-m", "with migration")
        self.git("-C", str(self.seed), "push", "--quiet", str(self.remote), "main")
        self.flag("health-fail")
        status = self.run_update(expected=1)
        self.assertIn("/api/health", status["message"])
        self.assert_rolled_back(status)
        # The restored binary must not find, and apply, the failed release's
        # migrations at its next start.
        self.assertFalse((self.live / "migrations/002.up.sql").exists())
        self.assertEqual((self.live / "aurora.failed").read_text(), "binary new\n")
        before = self.events.read_text()
        self.run_update(expected=1)
        self.assertEqual(self.events.read_text(), before)
        (self.control / "health-fail").unlink()
        self.assertEqual(self.run_update("--retry")["state"], "success")
        self.assertFalse((self.state_dir / "pending").exists())

    def test_restart_failure_rolls_back(self) -> None:
        # A failed `systemctl restart` used to trip set -e: new files installed,
        # nothing running them, and no rollback.
        self.flag("restart-fail-once")
        status = self.run_update(expected=1)
        self.assertIn("'systemctl restart aurora' failed", status["message"])
        self.assert_rolled_back(status)
        before = self.events.read_text()
        self.run_update(expected=1)
        self.assertEqual(self.events.read_text(), before)

    def test_restart_failure_with_a_dead_rollback_says_so(self) -> None:
        self.flag("restart-fail")
        status = self.run_update(expected=1)
        self.assertEqual(status["state"], "failed")
        self.assertIn("ALSO failed verification", status["message"])
        self.assertIn("no running main process", status["message"])
        # The files are put back even though nothing could be started on them.
        self.assertEqual(self.live_binary.read_text(), "old binary\n")
        self.assertEqual((self.live / "static/v2/index.html").read_text(), "old frontend\n")
        self.assertFalse((self.state_dir / "deployed").exists())
        self.assertTrue((self.state_dir / "pending").exists())

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
        # B promotes its binary, then dies before the static swap. The next
        # attempt must retain A as the rollback source rather than snapshot B.
        self.kill_during_migration_copy()
        self.run_update(expected=-9)
        self.assertEqual(self.live_binary.read_text(), "binary new\n")
        self.assertEqual((self.live / "static/v2/index.html").read_text(), "old frontend\n")
        self.assertEqual((self.rollback_dir / "rollback-binary").read_text(), "old binary\n")
        self.assertEqual((self.rollback_dir / "rollback-static/v2/index.html").read_text(),
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
        self.assertFalse(self.rollback_dir.exists())
        self.assertEqual(list(self.state_dir.glob(".rollback-stage.*")), [])

        # Another preparation failure still publishes no partial generation;
        # a later retry can capture both original artifacts and deploy normally.
        self.run_update("--retry", expected=1)
        self.assertFalse(self.rollback_dir.exists())
        self.assert_old_assets()
        self.restore_cp()
        self.assertEqual(self.run_update("--retry")["state"], "success")

    def test_killed_snapshot_preparation_leaves_no_active_generation(self) -> None:
        real_cp = shutil.which("cp")
        self.stub("cp", f'''
case "$*" in
  *rollback-static*)
    mkdir -p "$4"; echo partial > "$4/partial"
    kill -KILL "$PPID"; exit 0 ;;
esac
exec {shlex.quote(real_cp)} "$@"
''')
        self.run_update(expected=-9)
        self.assert_old_assets()
        self.assertFalse(self.rollback_dir.exists())
        self.assertTrue(list(self.state_dir.glob(".rollback-stage.*")))
        self.restore_cp()
        self.flag("health-fail")
        self.run_update("--retry", expected=1)
        self.assertEqual(self.live_binary.read_text(), "old binary\n")
        self.assertEqual((self.live / "static/v2/index.html").read_text(), "old frontend\n")
        self.assertEqual(list(self.state_dir.glob(".rollback-stage.*")), [])

    def test_interrupted_success_cleanup_cannot_mix_rollback_generations(self) -> None:
        real_rm = shutil.which("rm")
        self.stub("rm", f'''
if [ ! -f "$TEST_CONTROL/cleanup-killed" ]; then
  for arg in "$@"; do
    case "$arg" in
      */.rollback-retired.*)
        [ -d "$arg/snapshot" ] || continue
        {shlex.quote(real_rm)} -f -- "$arg/snapshot/rollback-binary" || exit $?
        touch "$TEST_CONTROL/cleanup-killed"
        kill -KILL "$PPID"; exit 0 ;;
      */deploy-state/rollback-binary)
        # Also exercise the old separate-delete implementation: this test
        # must expose its mixed restored assets, not just a changed layout.
        {shlex.quote(real_rm)} "$@" || exit $?
        touch "$TEST_CONTROL/cleanup-killed"
        kill -KILL "$PPID"; exit 0 ;;
    esac
  done
fi
exec {shlex.quote(real_rm)} "$@"
''')
        self.run_update(expected=-9)
        self.assertEqual(self.live_binary.read_text(), "binary new\n")
        self.assertEqual((self.live / "static/v2/index.html").read_text(), "new\n")
        healthy_static_mode = stat.S_IMODE((self.live / "static").stat().st_mode)
        self.publish_release("newer broken")
        (self.control / "health-fail").write_text("newer")
        status = self.run_update(expected=1)
        self.assertIn("restored the previous installed snapshot", status["message"])
        self.assertEqual(self.live_binary.read_text(), "binary new\n")
        self.assertEqual((self.live / "static/v2/index.html").read_text(), "new\n")
        self.assertEqual(stat.S_IMODE((self.live / "static").stat().st_mode), healthy_static_mode)
        self.assertEqual(list(self.state_dir.glob(".rollback-retired.*")), [])

    def test_failed_snapshot_retirement_keeps_pending_until_retry(self) -> None:
        real_mv = shutil.which("mv")
        self.stub("mv", f'''
case "$*" in *.rollback-retired.*) exit 28 ;; esac
exec {shlex.quote(real_mv)} "$@"
''')
        status = self.run_update(expected=1)
        self.assertEqual(status["state"], "failed")
        self.assertIn("rollback snapshot cleanup failed", status["message"])
        self.assertTrue((self.state_dir / "pending").exists())
        self.assertTrue(self.rollback_dir.exists())
        self.assertEqual(self.live_binary.read_text(), "binary new\n")
        (self.bin / "mv").unlink()
        (self.bin / "mv").symlink_to(real_mv)
        self.assertEqual(self.run_update("--retry")["state"], "success")
        self.assertFalse((self.state_dir / "pending").exists())
        self.assertFalse(self.rollback_dir.exists())


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

    def test_target_without_spa_source_is_refused(self) -> None:
        # The updater used to install whatever static/v2 sat in the checkout
        # (gitignored, so some EARLIER build's) beside the new binary.
        shutil.rmtree(self.seed / "static/redesign")
        bundle = self.seed / "static/v2"
        bundle.mkdir()
        (bundle / "index.html").write_text("committed bundle\n")
        self.git("-C", str(self.seed), "add", "-A", "-f")
        self.git("-C", str(self.seed), "commit", "--quiet", "-m", "bundle only")
        self.git("-C", str(self.seed), "push", "--quiet", str(self.remote), "main")
        self.git("-C", str(self.source), "pull", "--quiet", "--ff-only")
        (self.bin / "node").unlink()
        (self.bin / "npm").unlink()
        status = self.run_update(expected=1)
        self.assertEqual(status["state"], "failed")
        self.assertIn("frontend build failed", status["message"])
        self.assertEqual(self.count("go:build"), 0)
        self.assert_old_assets()
        self.assertFalse((self.state_dir / "pending").exists())

    def test_checkout_only_files_never_reach_the_install(self) -> None:
        # The tree check sees tracked changes only. An untracked file the
        # compiler or the static copy would pick up, and an ignored leftover
        # bundle, must not make it into what is installed.
        (self.source / "checkout-only").write_text("untracked\n")
        (self.source / "static/stray.js").write_text("untracked asset\n")
        (self.source / "static/v2").mkdir()
        (self.source / "static/v2/index.html").write_text("leftover bundle\n")
        (self.source / ".git/info/exclude").write_text("static/v2/\n")
        self.assertEqual(self.run_update()["state"], "success")
        self.assertEqual(self.live_binary.read_text(), "binary new\n")
        self.assertEqual((self.live / "static/v2/index.html").read_text(), "new\n")
        self.assertFalse((self.live / "static/stray.js").exists())
        self.assertFalse((self.state_dir / "build").exists())

    def test_incomplete_install_is_blocked_not_reported_idle(self) -> None:
        self.fail_migration_copy()
        status = self.run_update(expected=1)
        self.assertIn("copying the migration files failed", status["message"])
        self.assert_rolled_back(status)
        # Nothing had restarted, and the old process already runs what was
        # restored, so the rollback must not interrupt it either.
        self.assertEqual(self.count("service:restart"), 0)
        before = self.events.read_text()
        self.run_update(expected=1)
        self.assertEqual(self.events.read_text(), before)

    def test_running_process_must_be_the_installed_binary(self) -> None:
        # e.g. a drop-in ExecStart running some other file: the old check
        # passed on any answer from :8484.
        self.flag("exec-elsewhere")
        status = self.run_update(expected=1)
        self.assertIn("is not running the binary just installed", status["message"])
        self.assert_rolled_back(status)

    def test_stale_frontend_fails_verification(self) -> None:
        self.flag("stale-frontend")
        status = self.run_update(expected=1)
        self.assertIn("is not serving the index.html just installed", status["message"])
        self.assert_rolled_back(status)

    def test_degraded_database_fails_verification(self) -> None:
        # /api/health answers 200 "degraded" with the database down.
        self.flag("db-down")
        status = self.run_update(expected=1)
        self.assertIn("status ok with the database connected", status["message"])
        self.assert_rolled_back(status)

    def test_health_must_say_the_database_is_connected(self) -> None:
        (self.control / "db-down").write_text("inconsistent")
        status = self.run_update(expected=1)
        self.assertIn("status ok with the database connected", status["message"])
        self.assert_rolled_back(status)

    def test_crash_after_first_answer_fails_verification(self) -> None:
        self.flag("unstable")
        status = self.run_update(expected=1)
        self.assertIn("main process changed", status["message"])
        self.assert_rolled_back(status)

    def test_custom_port_is_read_from_the_serving_record(self) -> None:
        self.env["TEST_LISTEN"] = "0.0.0.0:9999"
        self.env["TEST_URL_PREFIX"] = "http://127.0.0.1:9999"
        self.assertEqual(self.run_update()["state"], "success")
        self.assertIn("curl:http://127.0.0.1:9999/api/health", self.events.read_text())

    def test_configured_port_is_the_fallback_without_a_record(self) -> None:
        # A binary that writes no record (or cannot): the stale record left by
        # pid 100 names port 8484 and must not be believed.
        self.flag("no-serving-record")
        with self.config.open("a") as config:
            config.write("AURORA_PORT=9999\n")
        self.env["TEST_LISTEN"] = "[::]:9999"
        self.env["TEST_URL_PREFIX"] = "http://127.0.0.1:9999"
        self.assertEqual(self.run_update()["state"], "success")

    def test_tls_listener_is_verified_over_tls(self) -> None:
        self.env.update({
            "TEST_LISTEN": "[::]:8443", "TEST_SCHEME": "https", "TEST_TLS_NAME": "media.example",
            "TEST_URL_PREFIX": "https://media.example:8443",
            "TEST_RESOLVE": "media.example:8443:127.0.0.1",
        })
        self.assertEqual(self.run_update()["state"], "success")

    def test_signal_during_install_rolls_back(self) -> None:
        # SIGTERM (systemd's TimeoutStartSec) or Ctrl-C mid-install used to
        # exit through the EXIT trap with half the files swapped.
        real_cp = shutil.which("cp")
        self.stub("cp", f'''
case "$1:$*" in -f:*/migrations/) kill -TERM "$PPID" ;; esac
exec {shlex.quote(real_cp)} "$@"
''')
        status = self.run_update(expected=143)
        self.assertIn("stopped unexpectedly while installing files", status["message"])
        self.assert_rolled_back(status)

    def test_a_record_from_another_process_is_ignored(self) -> None:
        # The previous process's record, on the same port, claiming a scheme
        # the new one does not speak. Believing it would fail verification.
        self.flag("no-serving-record")
        self.serving.write_text('{"pid": 100, "addr": "[::]:8484", "scheme": "https"}\n')
        self.assertEqual(self.run_update()["state"], "success")

    def test_record_naming_a_port_the_process_does_not_listen_on_is_ignored(self) -> None:
        self.env["TEST_RECORD_ADDR"] = "[::]:9999"
        self.assertEqual(self.run_update()["state"], "success")
        self.assertNotIn(":9999/", self.events.read_text())

    def test_config_file_port_without_record_or_env(self) -> None:
        # server.port in aurora.yaml: nothing in aurora.env says so, and no
        # record arrives. The port the process listens on is the answer, and
        # its established database connection is not.
        self.flag("no-serving-record")
        self.env["TEST_LISTEN"] = "0.0.0.0:9999"
        self.env["TEST_URL_PREFIX"] = "http://127.0.0.1:9999"
        self.assertEqual(self.run_update()["state"], "success")

    def test_tls_settings_in_aurora_env_without_record(self) -> None:
        self.flag("no-serving-record")
        with self.config.open("a") as config:
            config.write("TLS_CERT_FILE=/etc/aurora/cert.pem\nTLS_KEY_FILE=/etc/aurora/key.pem\n")
        self.env.update({"TEST_LISTEN": "[::]:8443", "TEST_URL_PREFIX": "https://127.0.0.1:8443"})
        self.assertEqual(self.run_update()["state"], "success")

    def test_autocert_settings_in_aurora_env_without_record(self) -> None:
        self.flag("no-serving-record")
        with self.config.open("a") as config:
            config.write("TLS_AUTO_CERT=true\nTLS_DOMAIN=media.example\n")
        self.env.update({
            "TEST_LISTEN": "[::]:443", "TEST_URL_PREFIX": "https://media.example:443",
            "TEST_RESOLVE": "media.example:443:127.0.0.1",
        })
        self.assertEqual(self.run_update()["state"], "success")

    def test_hostile_files_from_the_aurora_user_do_not_steer_or_hang_root(self) -> None:
        # The aurora user can write /var/cache/aurora. A FIFO must not hang the
        # drain, and a symlinked record must not be followed: this one claims
        # the next process speaks HTTPS, and believing it would fail.
        self.flag("no-serving-record")
        os.mkfifo(self.cache / "stream-state.json")
        decoy = self.root / "decoy.json"
        decoy.write_text('{"pid": 101, "addr": "[::]:8484", "scheme": "https"}\n')
        self.serving.unlink()
        self.serving.symlink_to(decoy)
        self.assertEqual(self.run_update()["state"], "success")

    def test_signal_after_the_restart_rolls_back(self) -> None:
        # systemd's TimeoutStartSec is most likely to land here, while waiting
        # on a slow verification.
        self.flag("term-during-verify")
        status = self.run_update(expected=143)
        self.assertIn("stopped unexpectedly after restarting the service", status["message"])
        self.assert_rolled_back(status)

    def test_frontend_and_backend_change_together(self) -> None:
        # The drain used to wait AFTER the install: the old backend served the
        # new frontend for up to five minutes.
        self.stub("pgrep", '''
echo "drain-saw:$(cat "$TEST_LIVE/static/v2/index.html")" >> "$TEST_EVENTS"
exit 1
''')
        self.assertEqual(self.run_update()["state"], "success")
        self.assertIn("drain-saw:old frontend", self.events.read_text())

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
