import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("provision", Path(__file__).resolve().parents[1] / "deploy/provision-secrets.py")
provision = importlib.util.module_from_spec(spec)
spec.loader.exec_module(provision)


class ProvisionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name) / "diagrams"
        self.values = {"accessKeyId": "a" * 32, "secretAccessKey": "b" * 64,
                       "endpoint": "https://57e15fb8fe6aa2279e2c73b3c077a4ef.r2.cloudflarestorage.com"}
        for patcher in (patch.object(provision, "Path", side_effect=lambda _: self.base),
                        patch.object(provision.os, "geteuid", return_value=0),
                        patch.object(provision.os, "chown"), patch.object(provision.os, "fchown"),
                        patch.object(provision.grp, "getgrnam", return_value=types.SimpleNamespace(gr_gid=os.getgid()))):
            patcher.start()
            self.addCleanup(patcher.stop)

    def run_provision(self):
        output = io.StringIO()
        with patch.object(provision.sys, "stdin", io.StringIO(json.dumps(self.values))), contextlib.redirect_stdout(output):
            provision.main()
        self.assertNotIn(self.values["secretAccessKey"], output.getvalue())
        self.assertNotIn(self.values["accessKeyId"], output.getvalue())

    def test_install_and_retry_preserve_keys_and_enabled_settings(self):
        self.run_provision()
        secret = self.base / "secrets/r2-secret-access-key"
        signing = self.base / "secrets/download-signing-key"
        runtime = self.base / "runtime.env"
        self.assertEqual(secret.read_text(), self.values["secretAccessKey"])
        key = signing.read_bytes()
        self.assertEqual(len(key), 32)
        self.assertEqual(stat.S_IMODE(secret.stat().st_mode), 0o400)
        self.assertEqual(stat.S_IMODE(signing.stat().st_mode), 0o400)
        self.assertEqual(stat.S_IMODE(runtime.stat().st_mode), 0o640)
        self.assertIn("DIAGRAMS_R2_ENABLED=false", runtime.read_text())
        runtime.write_text(runtime.read_text().replace("=false", "=true"))
        settings = runtime.read_bytes()
        self.run_provision()
        self.assertEqual(signing.read_bytes(), key)
        self.assertEqual(runtime.read_bytes(), settings)

    def test_different_credentials_do_not_replace_existing_files(self):
        self.run_provision()
        before = {p: p.read_bytes() for p in self.base.rglob("*") if p.is_file()}
        for field in ("accessKeyId", "secretAccessKey"):
            original = self.values[field]
            self.values[field] = "c" * len(original)
            with self.assertRaises(ValueError):
                self.run_provision()
            self.values[field] = original
            self.assertEqual(before, {p: p.read_bytes() for p in before})

    def test_symlink_cannot_redirect_secret_writes(self):
        self.base.mkdir()
        (self.base / "secrets").mkdir()
        target = Path(self.temp.name) / "unrelated"
        target.write_text("preserve")
        (self.base / "secrets/r2-secret-access-key").symlink_to(target)
        with self.assertRaises(ValueError):
            self.run_provision()
        self.assertEqual(target.read_text(), "preserve")

    def test_malformed_access_key_is_rejected_before_creating_files(self):
        self.values["accessKeyId"] += "="
        with self.assertRaises(ValueError):
            self.run_provision()
        self.assertFalse(self.base.exists())


if __name__ == "__main__":
    unittest.main()
