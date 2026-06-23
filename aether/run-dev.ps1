# Start the Aether infra + platform services locally (all-simulated by default).
# Requires Node >= 20.6 (for --env-file). The cloned engines (hermes/openclaw)
# and the per-tenant Aether Core worker are started separately.
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$envFile = Join-Path $root ".env"
if (-not (Test-Path $envFile)) {
  Copy-Item (Join-Path $root ".env.example") $envFile
  Write-Host "Created aether/.env from .env.example"
}

Write-Host "Starting Infrastructure layer  -> http://localhost:8090"
Start-Process node -ArgumentList "--env-file=$envFile", "src/index.mjs" `
  -WorkingDirectory (Join-Path $root "infra")

Write-Host "Starting B2B platform          -> http://localhost:8080"
Start-Process node -ArgumentList "--env-file=$envFile", "src/server.mjs" `
  -WorkingDirectory (Join-Path $root "platform")

Write-Host ""
Write-Host "Open the customer console: http://localhost:8080"
Write-Host "Then start a tenant worker: cd core; python -m aether_core run"
