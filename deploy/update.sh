#!/usr/bin/env bash
set -euo pipefail

# Update code in the existing archive-based installation. Keep its Compose
# settings, Caddy site, and pairing volume; build before replacing the container.
archive=${1:?Expected the uploaded archive path}
mode=${2:-}
case "$mode" in ''|--migrate-hosted-exports) ;; *) echo 'Unknown update mode' >&2; exit 1 ;; esac
case "$archive" in /tmp/diagrams-*.tar.gz) ;; *) echo 'Unexpected archive path' >&2; exit 1 ;; esac
app=/srv/apps/diagrams
stage=''
cleanup() {
    rm -f -- "$archive"
    if [ -n "$stage" ]; then rm -rf -- "$stage"; fi
}
trap cleanup EXIT
test -f "$app/compose.yaml"
test -f "$app/deploy/production.env.example"
if [ -e "$app/.git" ]; then
    echo 'This app now uses Git. Deploy from its repository instead of replacing its source archive.' >&2
    exit 1
fi
stage=$(mktemp -d "$app/.update.XXXXXX")
tar -xzf "$archive" -C "$stage"
runtime_env=/etc/diagrams/runtime.env
test -r "$runtime_env"
if [ "$mode" = --migrate-hosted-exports ]; then
    # One-time migration from the exact pre-export configuration. Refuse custom
    # server settings; this is not a general configuration-guard bypass.
    (cd "$app" && sha256sum --check --status <<'CHECKSUMS'
f9b2fad60d39c5dc8c6c3e6a9cd42d731cd15757d81fb7790dc5a70cf5b7d8a7  compose.yaml
677d98a92a01262ffc7a28f1f2dda51c5053526e7d0524e1b21e671f40eda278  deploy/production.env.example
CHECKSUMS
    ) || { echo 'Export migration requires the original deployment settings.' >&2; exit 1; }
    # First deploy the feature disabled, then verify and enable independently.
    grep -qx 'DIAGRAMS_R2_ENABLED=false' "$runtime_env"
    grep -qx 'DIAGRAMS_R2_ENFORCEMENT_VERIFIED=false' "$runtime_env"
    configs=(deploy/Caddyfile)
else
    configs=(compose.yaml deploy/production.env.example deploy/Caddyfile)
fi
for config in "${configs[@]}"; do
    if ! cmp -s "$app/$config" "$stage/$config"; then
        echo "Deployment settings changed: $config. Review those settings separately before updating code." >&2
        exit 1
    fi
done
# Validate the incoming configuration before building or touching the live tree.
(cd "$stage" && docker compose --project-name diagrams --env-file "$runtime_env" config --quiet)
cd "$app"
compose=(docker compose --project-name diagrams --env-file "$runtime_env")
"${compose[@]}" config --quiet
if [ -z "$("${compose[@]}" ps -q diagrams)" ]; then
    echo 'The existing Diagrams container is not running. Inspect it before updating.' >&2
    exit 1
fi
docker build --tag diagrams:local "$stage"
tar -xzf "$archive" -C "$app"
"${compose[@]}" up -d --no-build --wait --wait-timeout 120 diagrams
curl --fail --silent --show-error --max-time 5 http://127.0.0.1:8788/healthz
curl --fail --silent --show-error --retry 5 --retry-delay 2 --max-time 10 https://diagrams.bonatak.is/healthz
"${compose[@]}" ps
echo 'Diagrams updated at https://diagrams.bonatak.is'
