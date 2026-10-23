#!/usr/bin/env bash
set -euo pipefail

# Update code in the existing archive-based installation. Keep its Compose
# settings, Caddy site, and pairing volume; build before replacing the container.
archive=${1:?Expected the uploaded archive path}
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
for config in compose.yaml deploy/production.env.example deploy/Caddyfile; do
    if ! cmp -s "$app/$config" "$stage/$config"; then
        echo "Deployment settings changed: $config. Review those settings separately before updating code." >&2
        exit 1
    fi
done
cd "$app"
compose=(docker compose --project-name diagrams --env-file deploy/production.env.example)
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
