#!/bin/sh
# =============================================================================
# install.sh — Bootstrap the Alpine Linux sandbox
# Runs inside the proot Alpine environment.
# =============================================================================
set -eu

echo "[bootstrap] Updating apk packages..."
apk update

echo "[bootstrap] Installing Node.js, npm, Python3, and pip..."
apk add --no-cache nodejs npm python3 py3-pip bash

# Create directory structure
mkdir -p /aether/workspace /var/run/aether

# Create mock .env file from environment variables passed by SandboxManager
echo "[bootstrap] Generating /aether/.env file..."
cat <<EOF > /aether/.env
NODE_ENV=production
AETHER_TENANT_ID=android-local
AETHER_PROFILE=lite
AETHER_WORKSPACE=/aether/workspace
HERMES_API_BASE=http://localhost:8642/v1
HERMES_API_KEY=\${BYOB_API_KEY:-}
HERMES_MODEL=\${BYOB_MODEL:-hermes}
PLATFORM_PORT=8080
PLATFORM_SESSION_SECRET=android-session-secret-12345
SUPERVISOR_HEALTH_PORT=8091
INFRA_PORT=8090
EOF

echo "[bootstrap] Bootstrap execution successful"
