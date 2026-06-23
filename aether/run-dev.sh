#!/usr/bin/env bash
# Start the Aether infra + platform services locally (all-simulated by default).
# Requires Node >= 20.6 (for --env-file). Ctrl-C stops both.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
[ -f "$ROOT/.env" ] || { cp "$ROOT/.env.example" "$ROOT/.env"; echo "Created aether/.env"; }

echo "Starting Infrastructure layer  -> http://localhost:8090"
( cd "$ROOT/infra" && node --env-file="$ROOT/.env" src/index.mjs ) &
INFRA_PID=$!

echo "Starting B2B platform          -> http://localhost:8080"
( cd "$ROOT/platform" && node --env-file="$ROOT/.env" src/server.mjs ) &
PLAT_PID=$!

trap 'kill $INFRA_PID $PLAT_PID 2>/dev/null || true' INT TERM
echo ""
echo "Open the customer console: http://localhost:8080"
echo "Then start a tenant worker: cd core && python -m aether_core run"
wait
