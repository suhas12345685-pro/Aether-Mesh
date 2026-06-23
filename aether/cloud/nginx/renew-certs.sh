#!/usr/bin/env bash
# =============================================================================
# renew-certs.sh — Renew Let's Encrypt certificates and reload nginx
# Intended to run as a cron job inside the nginx container:
#   0 3 * * * /usr/local/bin/renew-certs.sh >> /var/log/nginx/certbot-renew.log 2>&1
# =============================================================================
set -euo pipefail

log() { printf '[certbot] %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

log "Starting certificate renewal check"
certbot renew --webroot -w /var/www/certbot --quiet --no-random-sleep-on-renew

log "Reloading nginx"
nginx -s reload

log "Renewal check complete"
