#!/usr/bin/env python3
"""Install production credentials from stdin, without printing their values.

Run as root over SSH. Never pass credentials as command-line arguments.
Existing credentials, signing keys and runtime settings are preserved; rotation
is a separate operation. The deploy group can traverse the secret directory for
Compose bind mounts, but only UID 10001 and root can read the secret files.
"""
import grp
import json
import os
from pathlib import Path
import re
import secrets
import sys


def install_new(path, data, uid, gid, mode):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as file:
        file.write(data)
        file.flush()
        os.fsync(file.fileno())
        os.fchown(file.fileno(), uid, gid)
        os.fchmod(file.fileno(), mode)


def main():
    if os.geteuid() != 0:
        raise ValueError("Run the provisioning script as root")
    values = json.load(sys.stdin)
    endpoint = "https://57e15fb8fe6aa2279e2c73b3c077a4ef.r2.cloudflarestorage.com"
    if values.get("endpoint") != endpoint:
        raise ValueError("Unexpected production endpoint")
    for key, length in (("accessKeyId", 32), ("secretAccessKey", 64)):
        if not isinstance(values.get(key), str) or not re.fullmatch(rf"[0-9a-fA-F]{{{length}}}", values[key]):
            raise ValueError("Missing or invalid S3 credential fields")
    deploy_gid = grp.getgrnam("deploy").gr_gid
    base = Path("/etc/diagrams")
    secret_dir = base / "secrets"
    for directory, mode in ((base, 0o750), (secret_dir, 0o710)):
        if directory.is_symlink():
            raise ValueError("Secret directories must not be symlinks")
        directory.mkdir(exist_ok=True)
        os.chown(directory, 0, deploy_gid)
        os.chmod(directory, mode)
    r2_path = secret_dir / "r2-secret-access-key"
    signing_path = secret_dir / "download-signing-key"
    runtime_path = base / "runtime.env"
    for path in (r2_path, signing_path, runtime_path):
        if path.is_symlink():
            raise ValueError("Configuration files must not be symlinks")
    secret = values["secretAccessKey"].encode()
    if r2_path.exists() and r2_path.read_bytes() != secret:
        raise ValueError("Existing R2 credential differs; use a deliberate rotation")
    if signing_path.exists() and len(signing_path.read_bytes()) != 32:
        raise ValueError("Existing signing key must contain exactly 32 bytes")
    if runtime_path.exists():
        existing = dict(line.split("=", 1) for line in runtime_path.read_text().splitlines() if line and not line.startswith("#") and "=" in line)
        if existing.get("DIAGRAMS_R2_ACCESS_KEY_ID", "") not in ("", values["accessKeyId"]):
            raise ValueError("Existing runtime credential differs; use a deliberate rotation")
        if not existing.get("DIAGRAMS_R2_ACCESS_KEY_ID"):
            raise ValueError("Existing runtime file requires a separate configuration migration")
    if not r2_path.exists():
        install_new(r2_path, secret, 10001, 10001, 0o400)
    if not signing_path.exists():
        install_new(signing_path, secrets.token_bytes(32), 10001, 10001, 0o400)
    for path in (r2_path, signing_path):
        os.chown(path, 10001, 10001)
        os.chmod(path, 0o400)
    if not runtime_path.exists():
        settings = {
            "DIAGRAMS_PUBLIC_URL": "https://diagrams.bonatak.is",
            "DIAGRAMS_PORT": "8788",
            "DIAGRAMS_R2_ENABLED": "false",
            "DIAGRAMS_R2_ENFORCEMENT_VERIFIED": "false",
            "DIAGRAMS_R2_ENDPOINT": endpoint,
            "DIAGRAMS_R2_BUCKET": "diagrams-exports-prod",
            "DIAGRAMS_R2_ACCESS_KEY_ID": values["accessKeyId"],
            "DIAGRAMS_R2_SECRET_ACCESS_KEY_FILE": str(r2_path),
            "DIAGRAMS_DOWNLOAD_SIGNING_KEY_FILE": str(signing_path),
        }
        install_new(runtime_path, "".join(f"{k}={v}\n" for k, v in settings.items()).encode(), 0, deploy_gid, 0o640)
    print("Production secret files installed; existing keys and runtime settings preserved.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError):
        print("Provisioning stopped; check file ownership, existing configuration, and credential fields. Secret details suppressed.", file=sys.stderr)
        sys.exit(1)
