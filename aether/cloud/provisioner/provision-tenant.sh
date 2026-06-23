#!/usr/bin/env bash
# =============================================================================
# provision-tenant.sh — Spin up a new Aether tenant container
#
# Usage:
#   provision-tenant.sh <tenant_id> <tier> <cloud_subdomain>
#
# Called by the platform on successful cloud checkout (e.g. after Stripe
# payment confirmation). Performs:
#   1. Validate inputs
#   2. docker run -d ... ghcr.io/aethermesh/aether-stack (with tenant env)
#   3. docker network connect aether-cloud <container>
#   4. Write upstream entry to nginx map and reload nginx
#   5. Output JSON: {"url":"https://subdomain.aethermesh.app","container":"aether-tenant_id"}
#
# Environment variables expected (from caller / .env.cloud):
#   DOMAIN                  — base domain (default: aethermesh.app)
#   AETHER_IMAGE_TAG        — image tag to pull (default: latest)
#   NGINX_UPSTREAM_MAP      — path to nginx upstream.map (default: /nginx/upstream.map)
#   NGINX_CONTAINER         — docker container name for nginx reload (default: aether-cloud-nginx-1)
#   AETHER_NETWORK          — docker network name (default: aether-cloud_aether-internal)
#   AETHER_SECRET_KEY       — master encryption key to pass to tenant
#   PLATFORM_SESSION_SECRET — session secret to pass to tenant
# =============================================================================
set -euo pipefail

# ---- Args -------------------------------------------------------------------
TENANT_ID="${1:?Usage: provision-tenant.sh <tenant_id> <tier> <cloud_subdomain>}"
TIER="${2:?Tier required (lite|power|enterprise)}"
SUBDOMAIN="${3:?Subdomain required}"

# ---- Config -----------------------------------------------------------------
DOMAIN="${DOMAIN:-aethermesh.app}"
IMAGE_TAG="${AETHER_IMAGE_TAG:-latest}"
IMAGE="ghcr.io/aethermesh/aether-stack:${IMAGE_TAG}"
CONTAINER_NAME="aether-${TENANT_ID}"
NETWORK="${AETHER_NETWORK:-aether-cloud_aether-internal}"
NGINX_MAP="${NGINX_UPSTREAM_MAP:-/nginx/upstream.map}"
NGINX_CTR="${NGINX_CONTAINER:-aether-cloud-nginx-1}"
FQDN="${SUBDOMAIN}.${DOMAIN}"
PUBLIC_URL="https://${FQDN}"

# ---- Tier resource limits ---------------------------------------------------
case "$TIER" in
  lite)
    MEM="256m"; CPUS="0.5"; PIDS="128";;
  power)
    MEM="512m"; CPUS="1.0"; PIDS="256";;
  enterprise)
    MEM="2g";   CPUS="2.0"; PIDS="512";;
  *)
    echo "Unknown tier: $TIER (valid: lite|power|enterprise)" >&2; exit 1;;
esac

# ---- Helpers ----------------------------------------------------------------
log() { printf '[provision] %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

# ---- Validate tenant ID (alphanumeric + hyphens only) ----------------------
if ! echo "$TENANT_ID" | grep -qE '^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}[a-zA-Z0-9]$'; then
  die "Invalid tenant_id '$TENANT_ID' — use lowercase alphanumeric + hyphens, 3-64 chars"
fi

# ---- Check container doesn't already exist ---------------------------------
if docker inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
  die "Container '$CONTAINER_NAME' already exists. Deprovision first."
fi

log "Provisioning tenant=$TENANT_ID tier=$TIER subdomain=$FQDN"

# ---- Pull the latest image --------------------------------------------------
log "Pulling image $IMAGE"
docker pull "$IMAGE" >/dev/null

# ---- Generate per-tenant secrets if not provided ----------------------------
TENANT_SESSION_SECRET="${PLATFORM_SESSION_SECRET:-$(openssl rand -hex 32)}"
TENANT_INFRA_ADMIN_TOKEN="$(openssl rand -hex 24)"
TENANT_INFRA_API_TOKEN="$(openssl rand -hex 24)"
TENANT_PLATFORM_ADMIN_TOKEN="$(openssl rand -hex 24)"

# ---- Run the container ------------------------------------------------------
log "Starting container $CONTAINER_NAME"
docker run -d \
  --name "$CONTAINER_NAME" \
  --restart unless-stopped \
  --memory "$MEM" \
  --cpus "$CPUS" \
  --pids-limit "$PIDS" \
  --security-opt no-new-privileges:true \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --tmpfs /app/logs:rw,noexec,nosuid,size=32m \
  -v "aether-data-${TENANT_ID}-platform:/app/data/platform" \
  -v "aether-data-${TENANT_ID}-infra:/app/data/infra" \
  -v "aether-workspace-${TENANT_ID}:/app/workspace" \
  -e NODE_ENV=production \
  -e LOG_JSON=true \
  -e AETHER_TENANT_ID="$TENANT_ID" \
  -e AETHER_PROFILE="$TIER" \
  -e AETHER_SECRET_KEY="${AETHER_SECRET_KEY:?AETHER_SECRET_KEY required}" \
  -e PLATFORM_SESSION_SECRET="$TENANT_SESSION_SECRET" \
  -e PLATFORM_PUBLIC_URL="$PUBLIC_URL" \
  -e PLATFORM_ADMIN_TOKEN="$TENANT_PLATFORM_ADMIN_TOKEN" \
  -e INFRA_ADMIN_TOKEN="$TENANT_INFRA_ADMIN_TOKEN" \
  -e INFRA_API_TOKEN="$TENANT_INFRA_API_TOKEN" \
  -e INFRA_PORT=8090 \
  -e PLATFORM_PORT=8080 \
  -e SUPERVISOR_HEALTH_PORT=8091 \
  -e PYTHON_BIN=python3 \
  -e AETHER_CORE_CWD=/app/core \
  -l "aether.tenant=$TENANT_ID" \
  -l "aether.tier=$TIER" \
  -l "aether.subdomain=$FQDN" \
  --no-healthcheck \
  "$IMAGE" \
>/dev/null

log "Container $CONTAINER_NAME started"

# ---- Connect to internal network --------------------------------------------
log "Connecting $CONTAINER_NAME to network $NETWORK"
docker network connect "$NETWORK" "$CONTAINER_NAME" \
  --alias "$CONTAINER_NAME" 2>/dev/null || \
  log "WARNING: Could not connect to network $NETWORK (may need manual setup)"

# ---- Update nginx upstream map ----------------------------------------------
log "Updating nginx upstream map at $NGINX_MAP"

# Ensure map file exists
touch "$NGINX_MAP" 2>/dev/null || \
  die "Cannot write to nginx map file $NGINX_MAP — check volume mount"

# Remove any existing entry for this tenant (idempotent)
grep -v "\"${FQDN}\"" "$NGINX_MAP" > "${NGINX_MAP}.tmp" 2>/dev/null || true
mv "${NGINX_MAP}.tmp" "$NGINX_MAP"

# Append new entry: "subdomain.aethermesh.app" "container-name:8080";
printf '"%s" "%s:8080";\n' "$FQDN" "$CONTAINER_NAME" >> "$NGINX_MAP"

log "Nginx map updated"

# ---- Reload nginx -----------------------------------------------------------
log "Reloading nginx ($NGINX_CTR)"
if docker inspect "$NGINX_CTR" >/dev/null 2>&1; then
  docker exec "$NGINX_CTR" nginx -s reload >/dev/null && \
    log "Nginx reloaded" || \
    log "WARNING: nginx reload returned non-zero (config may need review)"
else
  log "WARNING: Nginx container '$NGINX_CTR' not found — reload skipped"
fi

# ---- Wait for health --------------------------------------------------------
log "Waiting for tenant health check..."
retries=30
while [ "$retries" -gt 0 ]; do
  if docker exec "$CONTAINER_NAME" wget -qO- "http://localhost:8080/health" >/dev/null 2>&1; then
    log "Tenant $TENANT_ID is healthy"
    break
  fi
  retries=$(( retries - 1 ))
  sleep 2
done
if [ "$retries" -eq 0 ]; then
  log "WARNING: Tenant health check timed out — container may still be starting"
fi

# ---- Output JSON result -----------------------------------------------------
printf '{"url":"%s","container":"%s","tenant_id":"%s","tier":"%s"}\n' \
  "$PUBLIC_URL" "$CONTAINER_NAME" "$TENANT_ID" "$TIER"
