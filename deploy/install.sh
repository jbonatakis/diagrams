#!/usr/bin/env bash
set -euo pipefail

# First install only. Run through `npm run deploy` from the local checkout.
# Existing apps, volumes, and the main Caddyfile are never replaced.
archive=${1:?Expected the uploaded archive path}
case "$archive" in /tmp/diagrams-*.tar.gz) ;; *) echo 'Unexpected archive path' >&2; exit 1 ;; esac
app=/srv/apps/diagrams
site=/etc/caddy/sites/diagrams.bonatak.is.caddy
site_created=false
reloaded=false
cleanup() {
    rm -f -- "$archive"
    if "$site_created" && ! "$reloaded"; then sudo -n rm -f -- "$site"; fi
}
trap cleanup EXIT

if [ -e "$app" ] || [ -e "$site" ]; then
    echo 'Diagrams already has an app directory or Caddy site. Stopping without replacing it.' >&2
    exit 1
fi
if [ -n "$(docker ps -aq --filter label=com.docker.compose.project=diagrams)" ] ||
   [ -n "$(docker volume ls -q --filter name='^diagrams_pairings$')" ]; then
    echo 'A Diagrams container or pairing volume already exists. Stopping without replacing it.' >&2
    exit 1
fi
docker compose version
test -r /etc/caddy/Caddyfile
sudo -n install -d -o "$(id -un)" -g "$(id -gn)" -m 0755 "$app"
tar -xzf "$archive" -C "$app"
cd "$app"
docker compose --env-file deploy/production.env.example config --quiet
docker compose --env-file deploy/production.env.example up -d --build --wait --wait-timeout 120
curl --fail --silent --show-error --max-time 5 http://127.0.0.1:8788/healthz

sudo -n install -d -m 0755 /etc/caddy/sites
sudo -n install -m 0644 deploy/Caddyfile "$site"
site_created=true
sudo -n caddy validate --config /etc/caddy/Caddyfile
# The existing main config must import sites/*.caddy. Do not rewrite it or
# replace another site's settings just to make this install work.
adapted=$(sudo -n caddy adapt --config /etc/caddy/Caddyfile 2>/dev/null)
if ! grep -Fq '"diagrams.bonatak.is"' <<< "$adapted"; then
    echo 'Caddy does not import the new site. Add: import /etc/caddy/sites/*.caddy' >&2
    echo 'The healthy Diagrams container is still running on 127.0.0.1:8788.' >&2
    exit 1
fi
unset adapted
sudo -n systemctl reload caddy
reloaded=true
curl --fail --silent --show-error --retry 12 --retry-delay 5 --retry-all-errors --max-time 10 https://diagrams.bonatak.is/healthz
docker compose --env-file deploy/production.env.example ps
docker stats --no-stream "$(docker compose --env-file deploy/production.env.example ps -q diagrams)"
echo 'Diagrams is live at https://diagrams.bonatak.is'
