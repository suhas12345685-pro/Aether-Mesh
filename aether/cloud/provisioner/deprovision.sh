#!/usr/bin/env bash
# =============================================================================
# deprovision.sh — Stop and remove an Aether tenant container
#
# Usage:
#   deprovision.sh <tenant_id> [--purge-data]
#
# Actions:
#   1. Stop and remove the tenant container
#   2. Remove the upstream entry from the nginx map and reload nginx
#   3. Disconnect from the Aether network
#   4. Optionally remove named volumes (--purge-data)
#   5. Output JSON confirmation
#
# Environment variables:
#   DOMAIN             — base domain (default: aethermesh.app)
#   NGINX_UPSTREAM_MAP — path to nginx upstream.map (default: /nginx/upstream.map)
#   NGINX_CONTAINER    — nginx container name (default: aether-cloud-nginx-1)
#   AETHER_NETWORK     — docker network name (default: aether-cloud_aether-internal)
# =============================================================================
set -euo pipefail

# ---- Args -------------------------------------------------------------------
TENANT_ID="${1:?Usage: deprovision.sh <tenant_id> [--purge-data]}"
PURGE_DATA=false
if [ "${2:-}" = "--purge-data" ]; then
  PURGE_DATA=true
fi

# ---- Config -----------------------------------------------------------------
DOMAIN="${DOMAIN:-aethermesh.app}"
CONTAINER_NAME="aether-${TENANT_ID}"
NETWORK="${AETHER_NETWORK:-aether-cloud_aether-internal}"
NGINX_MAP="${NGINX_UPSTREAM_MAP:-/nginx/upstream.map}"
NGINX_CTR="${NGINX_CONTAINER:-aether-cloud-nginx-1}"

# ---- Helpers ----------------------------------------------------------------
log() { printf '[deprovision] %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

log "Deprovisioning tenant=$TENANT_ID (purge-data=$PURGE_DATA)"

# ---- Check container exists ------------------------------------------------
if ! docker inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
  log "Container '$CONTAINER_NAME' does not exist — nothing to remove"
  printf '{"status":"not_found","tenant_id":"%s"}\n' "$TENANT_ID"
  exit 0
fi

# ---- Read subdomain from container label ------------------------------------
SUBDOMAIN_FQDN="$(docker inspect --format '{{index .Config.Labels "aether.subdomain"}}' "$CONTAINER_NAME" 2>/dev/null || true)"
if [ -z "$SUBDOMAIN_FQDN" ]; then
  # Fallback: construct from tenant_id and domain
  SUBDOMAIN_FQDN="${TENANT_ID}.${DOMAIN}"
fi
log "Subdomain: $SUBDOMAIN_FQDN"

# ---- Gracefully stop the container (10s drain, then kill) ------------------
log "Stopping container $CONTAINER_NAME"
docker stop --time 10 "$CONTAINER_NAME" >/dev/null 2>&1 || \
  log "WARNING: container stop returned non-zero"

# ---- Disconnect from network before removal --------------------------------
log "Disconnecting $CONTAINER_NAME from network $NETWORK"
docker network disconnect "$NETWORK" "$CONTAINER_NAME" >/dev/null 2>&1 || \
  log "WARNING: network disconnect failed (container may already be stopped)"

# ---- Remove the container --------------------------------------------------
log "Removing container $CONTAINER_NAME"
docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1

log "Container removed"

# ---- Update nginx upstream map ---------------------------------------------
if [ -f "$NGINX_MAP" ]; then
  log "Removing nginx upstream entry for $SUBDOMAIN_FQDN"
  grep -v "\"${SUBDOMAIN_FQDN}\"" "$NGINX_MAP" > "${NGINX_MAP}.tmp" 2>/dev/null || true
  mv "${NGINX_MAP}.tmp" "$NGINX_MAP"
  log "Nginx map updated"
else
  log "Nginx map not found at $NGINX_MAP — skipping"
fi

# ---- Reload nginx -----------------------------------------------------------
if docker inspect "$NGINX_CTR" >/dev/null 2>&1; then
  log "Reloading nginx ($NGINX_CTR)"
  docker exec "$NGINX_CTR" nginx -s reload >/dev/null && \
    log "Nginx reloaded" || \
    log "WARNING: nginx reload returned non-zero"
else
  log "Nginx container '$NGINX_CTR' not found — reload skipped"
fi

# ---- Optionally remove named volumes ----------------------------------------
if [ "$PURGE_DATA" = "true" ]; then
  log "Purging data volumes for tenant $TENANT_ID"
  for vol in \
    "aether-data-${TENANT_ID}-platform" \
    "aether-data-${TENANT_ID}-infra" \
    "aether-workspace-${TENANT_ID}"; do
    if docker volume inspect "$vol" >/dev/null 2>&1; then
      docker volume rm "$vol" >/dev/null && \
        log "Removed volume $vol" || \
        log "WARNING: Could not remove volume $vol"
    else
      log "Volume $vol does not exist — skipping"
    fi
  done
fi

# ---- Output JSON confirmation -----------------------------------------------
printf '{"status":"deprovisioned","tenant_id":"%s","container":"%s","data_purged":%s}\n' \
  "$TENANT_ID" "$CONTAINER_NAME" "$([ "$PURGE_DATA" = "true" ] && echo true || echo false)"
