# Hosted export setup

Hosted exports are **configured, verified and enabled for local development and production**. Production uses `/etc/diagrams/runtime.env` and persistent secret files outside the deployment tree. Routine Go/browser tests use fake storage or mocked transport; the opt-in tests below exercise real R2 and must pass before enabling another environment.

Review verification: the production build, Go race suite, hosted-export regression suite and Compose configuration validation passed. The full Chrome suite passed 57 tests, with the isolated Docker-recreation and opt-in live-R2 tests skipped in that ordinary run. Four provisioning tests passed, covering persistence, file modes, credential replacement refusal, malformed credentials and symlinks. Public pairing/reload and visitor-isolation checks passed after deployment. Cloudflare readback reconfirmed production CORS, private access and full-bucket one-day lifecycle, plus the enabled exact `$0.01` billing policy.

Live verification on 2026-10-24 passed with both buckets: authenticated bucket access, signed length/checksum enforcement, conditional overwrite rejection, provider HEAD checksum, private access, attachment filename, downloaded byte hash and signed GET expiry. Chrome Blob PUTs passed CORS from each environment's origin. The production application smoke test exported SVG, PNG, Excalidraw and library JSON, verified hashes and idempotent retries, downloaded after closing the diagram tab, and withdrew each link through cancellation. Firefox and WebKit passed the same application export flow against development; the Safari application and other MCP clients were not separately tested. Only generated fixtures were uploaded. Direct proof fixtures were deleted; application smoke objects remain private for lifecycle cleanup.

Production verification caught Caddy compressing bodyless HEAD responses and changing their reported file size. Export responses now include `Cache-Control: private, no-store, no-transform`; exact public HEAD sizes and downloaded hashes passed after the fix. The live container remained healthy, with a sampled export-test memory peak of **12.71 MiB / 256 MiB** and no OOM kill. The original app/database backup is `/var/backups/diagrams/20261023T232731Z`; the retained pre-export image is `diagrams:before-exports-20261023t232731z`.

## Provisioned infrastructure

| Environment | Bucket | Browser origins |
| --- | --- | --- |
| Development | `diagrams-exports-dev` | `http://localhost:5173`, `https://diagrams.bonatak.is` |
| Production | `diagrams-exports-prod` | `https://diagrams.bonatak.is` |

Both are private Standard buckets in WEUR, with r2.dev disabled and no custom domains. Object keys are random IDs at the bucket root. The lifecycle rule covers **every object**, with deletion after an age of one day. Link expiry is separate: a friendly link lasts 15 minutes, while the stored object awaits lifecycle cleanup.

The endpoint is `https://57e15fb8fe6aa2279e2c73b3c077a4ef.r2.cloudflarestorage.com`; the SDK uses region `auto`.

The account-wide billing policy `8e52e48cd67140be91dd7d4e57c08600` was created and read back with `total_spend_dollars: ["0.01"]` and the owner's email recipient. It is a billing notification, not a spending cap or an R2-only meter. No test email was sent. Recheck the policy, lifecycle and CORS before rollout.

## Credentials

Create separate **R2 Object Read & Write** credentials scoped to each bucket. The app needs the **Access Key ID and Secret Access Key** produced for the S3 API. A Cloudflare bearer API token is not the S3 secret. Runtime credentials do not need bucket-administration or billing permissions. Leave Client IP Address Filtering empty for direct browser uploads and recipient downloads unless the full client network requirements have been established.

Keep secret files outside the repository and `deploy/`, which is included in deployment archives. The app reads:

- `DIAGRAMS_R2_ACCESS_KEY_ID`: S3 Access Key ID.
- `DIAGRAMS_R2_SECRET_ACCESS_KEY_FILE`: absolute path to the S3 Secret Access Key file.
- `DIAGRAMS_DOWNLOAD_SIGNING_KEY_FILE`: absolute path to a separate persistent random signing key, at least 32 bytes. Replacing it invalidates existing friendly links.

For local development, owner-readable mode `0600` secret files work because `npm run dev` runs the server as your user. Generate the separate signing key directly into a file, for example `openssl rand -out /absolute/private/path/download-signing-key 32`, and set its mode to `0600`.

For Linux Docker Compose, file secrets are bind mounts: the application runs as **UID/GID 10001**. A host-user-owned mode `0600` file may therefore be unreadable. Install the files outside the deployment tree with owner `10001:10001` and mode `0400`, and keep their parent directory restricted. Compose mounts them at `/run/secrets/`; host paths belong in the external runtime environment file. The empty tracked `deploy/empty-secret` is only a fallback while exports are unconfigured.

Use the existing ignored `.env` for local development, containing paths rather than secret contents:

```dotenv
DIAGRAMS_PUBLIC_URL=http://localhost:5173
DIAGRAMS_R2_ENDPOINT=https://57e15fb8fe6aa2279e2c73b3c077a4ef.r2.cloudflarestorage.com
DIAGRAMS_R2_BUCKET=diagrams-exports-dev
DIAGRAMS_R2_ACCESS_KEY_ID=<development S3 access key ID>
DIAGRAMS_R2_SECRET_ACCESS_KEY_FILE=/absolute/private/path/r2-secret-access-key
DIAGRAMS_DOWNLOAD_SIGNING_KEY_FILE=/absolute/private/path/download-signing-key
DIAGRAMS_R2_ENABLED=false
DIAGRAMS_R2_ENFORCEMENT_VERIFIED=false
```

## Development proof

The current signer requests `ChecksumSHA256` on PUT and checksum mode on HEAD. Both passed the live development proof; a missing provider checksum deliberately prevents a ready link. A browser-supplied object metadata field is not an acceptable replacement for a provider-validated checksum. Consult the [R2 S3 compatibility table](https://developers.cloudflare.com/r2/api/s3/api/) when interpreting failures.

With the development settings exported in the shell, run:

```sh
DIAGRAMS_R2_LIVE_TEST=true go test ./internal/server -run '^TestR2LiveEnforcement$' -count=1 -v
```

This opt-in test defaults to `diagrams-exports-dev`. Testing `diagrams-exports-prod` additionally requires `DIAGRAMS_R2_PRODUCTION_TEST=true` and production credentials. It authenticates bucket access first, uploads a tiny generated SVG, tests rejection of an oversized body and an incorrect checksum, proves a normal PUT succeeds, verifies conditional overwrite rejection, checks provider HEAD metadata, downloads and hashes the bytes, and checks attachment headers, private access and signed URL expiry. It deletes its fixture afterward; lifecycle cleanup remains the fallback. It never prints credentials, signed URLs or provider response bodies. Ordinary `go test` skips it. `go test` does not load `.env` automatically.

Add `DIAGRAMS_R2_BROWSER_TEST=true` to perform the normal PUT in real Chrome, including browser CORS and automatic Content-Length handling. The helper serves a generated page at the permitted environment origin without touching the running app or user diagrams. R2 may reject an unsigned S3 URL with HTTP 400, 403 or 404; all deny object access.

If the proof fails, leave the flags false and resolve the provider behavior before proceeding. In particular, do not replace exact-length enforcement with a size check after upload or accept a missing checksum.

After the wire-level proof succeeds, enable both flags **only for the local development instance** and run `npm run dev`. From the actual allowed origin, use a newly paired agent to export generated fixtures in SVG, PNG, Excalidraw and library JSON formats. Confirm browser CORS, required headers, no file bodies through Go, output hashes, a working friendly `/export/<id>?token=...` link after closing the tab, cancellation/revocation, and fixed link expiry. Exercise Chrome, Firefox and Safari before production; automated browser coverage currently uses Chrome. Record client retrieval behavior separately from whether a client renders a clickable link.

With the verified development app running at `http://localhost:5173`, run the full application test with:

```sh
DIAGRAMS_R2_LIVE_TEST=true DIAGRAMS_TEST_URL=http://localhost:5173 npx playwright test tests/r2-live.spec.ts --reporter=line
```

It uses a fresh browser context, generated diagrams and the real MCP/callback/R2 flow. Trace recording and screenshots are disabled to avoid persisting signed URLs. Ordinary browser test runs skip it. The local `.env` points to mode `0600` secret and signing-key files under `~/.config/diagrams`; it contains no secret access key bytes.

Recheck the lifecycle and exact first-cent policy by readback before each rollout, and measure VM memory during the deployment smoke test. Production readbacks and the sampled memory check passed for this rollout.

## Deployment and disabling

Production uses `/etc/diagrams/runtime.env`, owned by root and readable by the deployment group (`0640`). Secret files live in `/etc/diagrams/secrets/`, are owned by `10001:10001` and have mode `0400`. The configuration directory is `0750 root:deploy`; the secret directory is `0710 root:deploy`, allowing Compose to resolve mount paths without giving the deployment group direct read permission on the secrets. Docker administrators can still access them.

Run `deploy/provision-secrets.py` as root over SSH, sending the credentials JSON on stdin. It installs the R2 secret, generates a persistent 32-byte signing key on first use, and creates runtime settings with exports disabled. Re-running it preserves existing signing keys and settings; different credentials require a deliberate rotation. It rejects malformed R2 credentials before writing files and never prints secret values. Local development continues to use the ignored `.env`.

`deploy/update.sh` normally refuses changes to Compose, the environment example or Caddy settings. The one-time `npm run deploy -- --update --migrate-hosted-exports` migration accepts only the exact original Compose/environment files (verified by SHA-256), requires both export flags to be false in the external runtime file, and still refuses Caddy changes. It validates the incoming configuration and builds before replacing the container. Take a consistent SQLite backup, retain the current image and archive the old app before this migration. Subsequent code deployments use `npm run deploy -- --update`; they reuse the external runtime settings and secret files.

After production bucket enforcement and CORS pass, enable both export flags in `/etc/diagrams/runtime.env` and recreate the app with that same env file. Validate the real production app using generated browser fixtures:

```sh
DIAGRAMS_R2_LIVE_TEST=true DIAGRAMS_R2_PRODUCTION_TEST=true DIAGRAMS_TEST_URL=https://diagrams.bonatak.is npx playwright test tests/r2-live.spec.ts --reporter=line
```

The production smoke test has two explicit opt-ins, uses a fresh browser context, and withdraws every generated export link. It does not touch existing browser diagrams. Keep encrypted recovery copies in controlled storage. To rotate R2 credentials, install the replacement files and update the Access Key ID, recreate the container, verify a new export, then revoke the previous credential. Replacing the signing key invalidates friendly links immediately; it cannot revoke already issued R2 URLs. Do not restore an old database automatically during rollback: deployment can introduce schema changes and new grants/jobs.

An encrypted recovery archive was created on the operator's Mac under `~/.config/diagrams/backups/production-secrets-20261023T233742Z.tar.gz.cms`. It contains the runtime settings and both secret files, with exports disabled for safe recovery. Encryption uses OpenSSL CMS with AES-256-GCM and RSA-OAEP/SHA-256; decrypting it and comparing the restored bytes passed. No plaintext archive was written locally.

The separate recovery key and certificate are `~/.config/diagrams/recovery/production-recovery-key.pem` and `production-recovery-cert.pem`, restricted to the local user. Store the private key in a password manager separately from the encrypted archive; the public certificate can accompany the archive. The recovery private key is not installed on the server. To decrypt into a private staging location:

```sh
umask 077
openssl cms -decrypt -binary -inform DER \
  -in "$HOME/.config/diagrams/backups/production-secrets-20261023T233742Z.tar.gz.cms" \
  -recip "$HOME/.config/diagrams/recovery/production-recovery-cert.pem" \
  -inkey "$HOME/.config/diagrams/recovery/production-recovery-key.pem" \
  -out /absolute/private/staging/production-secrets.tar.gz
```

Inspect the recovered settings before installation, restore the documented ownership and modes, and verify the credentials before enabling exports. Generate a new encrypted recovery archive after any credential or signing-key rotation.

Once configured and verified, `DIAGRAMS_R2_ENABLED=false` prevents new jobs while retaining status, cancellation, reconciliation and existing downloads through their fixed expiry. Keep `DIAGRAMS_R2_ENFORCEMENT_VERIFIED=true` and the credentials/signing key installed for that graceful disable. Clearing verification or removing the credentials disables the entire hosted service, including friendly redirects. Already issued R2 URLs remain usable until their own expiry.

The current limits and lifetimes are defined in [hosted_exports.go](../internal/server/hosted_exports.go). Runtime tuning and structured quota `retryAt` responses remain follow-up work; neither should be claimed as implemented.
