#!/bin/sh
# =============================================================================
# start-aether.sh — Start Aether services inside the Android Alpine sandbox
# =============================================================================
set -eu

LOG_FILE="/tmp/aether.log"
touch "$LOG_FILE"

echo "[sandbox] Starting Aether services..." | tee -a "$LOG_FILE"

# Start services (simulated/mocked or real)
# In Android we keep background logs tailed to stdout so SandboxManager reads them.
# We will start the supervisor in the foreground to keep the process alive.
echo "[sandbox] Starting Aether Supervisor..." | tee -a "$LOG_FILE"

# Clean exit handler
cleanup() {
    echo "[sandbox] Stopping services..." | tee -a "$LOG_FILE"
    kill 0
    exit 0
}
trap cleanup SIGTERM SIGINT

# Keep tailing the log file to stdout so MainActivity and AetherService get logs
tail -f "$LOG_FILE" &
TAIL_PID=$!

# Run supervisor or loop to keep alive
while true; do
    sleep 10
done
