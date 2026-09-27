#!/usr/bin/env python3
"""Behavior tests for updater-ledger discovery and uninstall cleanup."""
from __future__ import annotations

import os
from pathlib import Path
import pty
import re
import shutil
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("uninstall.sh").read_text()
BASH = shutil.which("bash")


class UninstallUpdaterStateTest(unittest.TestCase):
    def setUp(self) -> None:
        work = tempfile.TemporaryDirectory(prefix="aurora-uninstall-test-")
        self.addCleanup(work.cleanup)
        self.root = Path(work.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.host = self.root / "host"
        self.ledger = self.host / "var/lib/aurora-updater"
        self.sibling = self.ledger.with_name("aurora-updater-keep")
        for directory in (self.ledger, self.sibling):
            directory.mkdir(parents=True)
        (self.ledger / "pending").write_text("b" * 40 + "\n")
        (self.ledger / "deployed").write_text("a" * 40 + " fingerprint\n")
        (self.sibling / "sentinel").write_text("keep\n")

        for name in ("printf", "head", "grep", "dirname"):
            target = shutil.which(name)
            if target:
                (self.bin / name).symlink_to(target)
        self.stub("id", '[ "$1" = -u ] && { echo 0; exit 0; }; exit 1')
        self.stub("uname", "echo Linux")
        self.stub("getent", "exit 1")
        self.stub("systemctl", "exit 1")

        # Rewrite whole filesystem namespaces, including paths used directly
        # in tests/redirections rather than declared as variables: nginx,
        # Let's Encrypt, and root's Git credentials must never reach the host.
        # No real service/database/account/ACL tools are exposed in PATH.
        runner = re.sub(r"/(?:etc|root|opt|var|usr/local|tmp)(?=/)",
                        lambda match: str(self.host) + match.group(), SCRIPT)

        # Keep real deletion behavior, but validate EVERY operand first. This
        # fails closed if a future path rewrite is missed, or if a fixture
        # path escapes via '..', a prefix sibling, or a symlinked directory.
        guarded_rm = self.bin / "rm"
        guarded_rm.write_text(f'''#!{sys.executable}
from pathlib import Path
import os
import sys
root = Path({str(self.host)!r}).resolve()
operands = []
options = True
for arg in sys.argv[1:]:
    if options and arg == "--":
        options = False
    elif options and arg.startswith("-"):
        if arg not in ("-f", "-r", "-rf", "-fr"):
            raise SystemExit("unsafe rm option: " + arg)
    else:
        path = Path(arg).resolve()
        if root not in path.parents:
            raise SystemExit("refusing deletion outside fixture: " + arg)
        operands.append(arg)
if not operands:
    raise SystemExit("rm requires a fixture operand")
os.execv({shutil.which("rm")!r}, ["rm", *sys.argv[1:]])
''')
        guarded_rm.chmod(0o755)
        self.runner = self.root / "uninstall.sh"
        self.runner.write_text(runner)
        self.env = {**os.environ, "PATH": str(self.bin)}
        for key in ("BASH_ENV", "ENV"):
            self.env.pop(key, None)

    def stub(self, name: str, body: str) -> None:
        path = self.bin / name
        path.write_text("#!/bin/sh\n" + body + "\n")
        path.chmod(0o755)

    def test_force_removes_ledger_only_and_not_prefix_sibling(self) -> None:
        result = subprocess.run([BASH, str(self.runner), "--force"], env=self.env,
                                text=True, capture_output=True, check=False)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Updater deployment state", result.stdout)
        self.assertIn(str(self.ledger), result.stdout)
        self.assertFalse(self.ledger.exists())
        self.assertEqual((self.sibling / "sentinel").read_text(), "keep\n")

    def test_declining_ledger_cleanup_leaves_pending_and_deployed_state(self) -> None:
        master, slave = pty.openpty()
        try:
            process = subprocess.Popen([BASH, str(self.runner)], env=self.env,
                                       stdin=slave, stdout=slave, stderr=slave)
            os.close(slave)
            # Proceed with uninstall, then explicitly preserve updater state.
            os.write(master, b"y\nn\n")
            output = bytearray()
            while True:
                try:
                    output.extend(os.read(master, 4096))
                except OSError:
                    break
            self.assertEqual(process.wait(timeout=10), 0, output.decode(errors="replace"))
        finally:
            os.close(master)
        self.assertTrue((self.ledger / "pending").exists())
        self.assertTrue((self.ledger / "deployed").exists())
        self.assertTrue((self.sibling / "sentinel").exists())

    def test_proxy_and_credentials_cleanup_stays_in_fixture(self) -> None:
        paths = [self.host / path for path in (
            "etc/nginx/sites-available/aurora.conf", "etc/nginx/sites-enabled/aurora.conf",
            "etc/nginx/conf.d/aurora.conf", "etc/nginx/conf.d/aurora-map.conf",
            "root/.git-credentials",
        )]
        for path in paths:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("https://fixture@example.invalid@github.com/\n")
        result = subprocess.run([BASH, str(self.runner), "--force"], env=self.env,
                                text=True, capture_output=True, check=False, timeout=10)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        for path in paths:
            self.assertFalse(path.exists(), str(path))
        self.assertTrue((self.sibling / "sentinel").exists())

    def test_missed_proxy_rewrite_cannot_delete_outside_fixture(self) -> None:
        # Model the original isolation defect without touching any /etc path.
        with tempfile.TemporaryDirectory(prefix="aurora-host-proxy-") as outside:
            config = Path(outside) / "conf.d/aurora.conf"
            config.parent.mkdir()
            config.write_text("host configuration must survive\n")
            runner = self.runner.read_text().replace(str(self.host / "etc/nginx"), outside)
            self.runner.write_text(runner)
            result = subprocess.run([BASH, str(self.runner), "--force"], env=self.env,
                                    text=True, capture_output=True, check=False, timeout=10)
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("refusing deletion outside fixture", result.stderr)
            self.assertEqual(config.read_text(), "host configuration must survive\n")

    def test_delete_guard_rejects_escapes_before_any_deletion(self) -> None:
        with tempfile.TemporaryDirectory(prefix="aurora-outside-") as outside:
            sentinel = Path(outside) / "sentinel"
            sentinel.write_text("keep\n")
            link = self.host / "escape"
            link.symlink_to(outside, target_is_directory=True)
            for path in (sentinel, link / "sentinel", self.host / "..", self.root):
                with self.subTest(path=path):
                    result = subprocess.run([str(self.bin / "rm"), "-rf", "--",
                                             str(self.ledger), str(path)], env=self.env,
                                            text=True, capture_output=True, check=False, timeout=10)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("refusing deletion outside fixture", result.stderr)
                    self.assertTrue(self.ledger.exists())
                    self.assertEqual(sentinel.read_text(), "keep\n")


if __name__ == "__main__":
    unittest.main(verbosity=2)
