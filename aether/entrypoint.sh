#!/usr/bin/env bash
# =============================================================================
# Aether Mesh — Stack Entrypoint
# Starts infra, platform, and supervisor Node services in background, then
# waits for the supervisor to exit (which keeps the container alive).
# SIGTERM is propagated to all child processes for graceful shutdown.
# =============================================================================
set -euo pipefail

# ---- Railway Port Mapping ---------------------------------------------------
export PLATFORM_PORT="${PORT:-${PLATFORM_PORT:-8080}}"

# ---- Log helper -------------------------------------------------------------
log() {
  printf '[entrypoint] %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

# ---- Directories ------------------------------------------------------------
mkdir -p /app/logs /app/data/infra /app/data/platform /app/workspace

# ---- PID tracking -----------------------------------------------------------
INFRA_PID=""
PLATFORM_PID=""
SUPERVISOR_PID=""

# ---- Graceful shutdown handler ----------------------------------------------
shutdown() {
  log "SIGTERM received — shutting down all services"

  [ -n "$SUPERVISOR_PID" ] && kill -TERM "$SUPERVISOR_PID" 2>/dev/null && \
    log "Sent SIGTERM to supervisor (pid=$SUPERVISOR_PID)"

  [ -n "$PLATFORM_PID" ] && kill -TERM "$PLATFORM_PID" 2>/dev/null && \
    log "Sent SIGTERM to platform (pid=$PLATFORM_PID)"

  [ -n "$INFRA_PID" ] && kill -TERM "$INFRA_PID" 2>/dev/null && \
    log "Sent SIGTERM to infra (pid=$INFRA_PID)"

  # Give services up to 10 s to exit cleanly, then SIGKILL
  local deadline=$(( $(date +%s) + 10 ))
  for pid in "$SUPERVISOR_PID" "$PLATFORM_PID" "$INFRA_PID"; do
    [ -z "$pid" ] && continue
    while kill -0 "$pid" 2>/dev/null; do
      if [ "$(date +%s)" -ge "$deadline" ]; then
        log "Timeout — killing pid=$pid"
        kill -KILL "$pid" 2>/dev/null || true
        break
      fi
      sleep 0.5
    done
  done

  log "All services stopped"
  exit 0
}
trap shutdown SIGTERM SIGINT SIGQUIT

# ---- Wait for port helper ---------------------------------------------------
wait_for_port() {
  local name="$1" port="$2" retries=30
  log "Waiting for $name on port $port..."
  while [ "$retries" -gt 0 ]; do
    if wget -qO- "http://localhost:${port}/ready" >/dev/null 2>&1; then
      log "$name is ready"
      return 0
    fi
    retries=$(( retries - 1 ))
    sleep 1
  done
  log "WARNING: $name did not become ready on port $port (continuing anyway)"
}

# ---- Start infra service ----------------------------------------------------
log "Starting infra service (port=${INFRA_PORT:-8090})"
node /app/infra/src/index.mjs \
  >> /app/logs/infra.log 2>&1 &
INFRA_PID=$!
log "Infra started (pid=$INFRA_PID)"

# ---- Wait for infra, then start platform ------------------------------------
wait_for_port "infra" "${INFRA_PORT:-8090}"

log "Starting platform service (port=${PLATFORM_PORT:-8080})"
node /app/platform/src/server.mjs \
  >> /app/logs/platform.log 2>&1 &
PLATFORM_PID=$!
log "Platform started (pid=$PLATFORM_PID)"

# ---- Wait for platform, then start supervisor --------------------------------
wait_for_port "platform" "${PLATFORM_PORT:-8080}"

log "Starting supervisor service (port=${SUPERVISOR_HEALTH_PORT:-8091})"
node /app/supervisor/src/supervisor.mjs \
  >> /app/logs/supervisor.log 2>&1 &
SUPERVISOR_PID=$!
log "Supervisor started (pid=$SUPERVISOR_PID)"

# ---- Tail all three logs to stdout ------------------------------------------
log "Tailing service logs (infra | platform | supervisor)..."
tail -F \
  /app/logs/infra.log \
  /app/logs/platform.log \
  /app/logs/supervisor.log \
  2>/dev/null &

# ---- Monitor: exit container if any critical service dies -------------------
monitor() {
  local name="$1" pid="$2"
  wait "$pid" 2>/dev/null
  local code=$?
  if [ $code -ne 0 ]; then
    log "FATAL: $name (pid=$pid) exited with code=$code — shutting down container"
    shutdown
  fi
}

monitor "infra"      "$INFRA_PID"      &
monitor "platform"   "$PLATFORM_PID"   &
monitor "supervisor" "$SUPERVISOR_PID" &

log "All services running. Container is healthy."

# ---- Wait for all background jobs (blocks until shutdown) ------------------
wait
