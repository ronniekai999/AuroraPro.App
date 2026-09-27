#!/usr/bin/env python3
"""Behavior tests for updater-ledger discovery and uninstall cleanup."""
from __future__ import annotations

import os
from pathlib import Path
import pty
import shutil
import subprocess
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
        self.ledger = self.root / "aurora-updater"
        self.sibling = self.root / "aurora-updater-keep"
        for directory in (self.ledger, self.sibling):
            directory.mkdir()
        (self.ledger / "pending").write_text("b" * 40 + "\n")
        (self.ledger / "deployed").write_text("a" * 40 + " fingerprint\n")
        (self.sibling / "sentinel").write_text("keep\n")

        for name in ("rm", "printf", "head", "grep", "dirname"):
            target = shutil.which(name)
            if target:
                (self.bin / name).symlink_to(target)
        self.stub("id", '[ "$1" = -u ] && { echo 0; exit 0; }; exit 1')
        self.stub("uname", "echo Linux")
        self.stub("getent", "exit 1")
        self.stub("systemctl", "exit 1")

        # Redirect every uninstall-owned absolute path. Only the deployment
        # ledger exists, so its presence alone must keep discovery from the
        # early "nothing to remove" exit.
        runner = SCRIPT
        replacements = {
            'DEPLOY_STATE_DIR="/var/lib/aurora-updater"': f'DEPLOY_STATE_DIR="{self.ledger}"',
            'STATE_DIR="/var/lib/aurora"': f'STATE_DIR="{self.root / "state"}"',
            'INSTALL_BIN="/usr/local/bin/aurora"': f'INSTALL_BIN="{self.root / "aurora"}"',
            'INSTALL_DIR="/opt/aurora"': f'INSTALL_DIR="{self.root / "opt"}"',
            'CONFIG_DIR="/etc/aurora"': f'CONFIG_DIR="{self.root / "etc"}"',
            'CACHE_DIR="/var/cache/aurora"': f'CACHE_DIR="{self.root / "cache"}"',
            'TRANSCODE_FALLBACK="/tmp/aurora-transcode"': f'TRANSCODE_FALLBACK="{self.root / "transcode"}"',
            'LOG_DIR="/var/log/aurora"': f'LOG_DIR="{self.root / "logs"}"',
            'SYSTEMD_UNIT="/etc/systemd/system/aurora.service"': f'SYSTEMD_UNIT="{self.root / "aurora.service"}"',
            'UPDATER_BIN="/usr/local/bin/aurora-update"': f'UPDATER_BIN="{self.root / "aurora-update"}"',
            'UPDATER_SERVICE="/etc/systemd/system/aurora-update.service"': f'UPDATER_SERVICE="{self.root / "aurora-update.service"}"',
            'UPDATER_TIMER="/etc/systemd/system/aurora-update.timer"': f'UPDATER_TIMER="{self.root / "aurora-update.timer"}"',
            'UPDATER_PATH_UNIT="/etc/systemd/system/aurora-update.path"': f'UPDATER_PATH_UNIT="{self.root / "aurora-update.path"}"',
            'UPDATER_SUDOERS="/etc/sudoers.d/aurora-update"': f'UPDATER_SUDOERS="{self.root / "sudoers"}"',
        }
        for old, new in replacements.items():
            self.assertIn(old, runner)
            runner = runner.replace(old, new)
        self.runner = self.root / "uninstall.sh"
        self.runner.write_text(runner)
        self.env = {**os.environ, "PATH": str(self.bin)}

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


if __name__ == "__main__":
    unittest.main(verbosity=2)
