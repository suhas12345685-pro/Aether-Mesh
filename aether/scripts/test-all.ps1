# Run every Aether test suite (Node + Python). Exits non-zero on any failure.
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$fail = 0

Write-Host "== Node suites =="
foreach ($svc in "shared", "infra", "platform", "supervisor") {
  Write-Host "--- $svc ---"
  Push-Location (Join-Path $root $svc)
  node --test; if (-not $?) { $fail = 1 }
  Pop-Location
}

Write-Host "== Python core =="
Push-Location (Join-Path $root "core")
foreach ($t in "test_smoke", "test_reliability", "test_contracts", "test_entitlements", "test_skills") {
  Write-Host "--- $t ---"
  python "tests/$t.py"; if (-not $?) { $fail = 1 }
}
Remove-Item -Recurse -Force "tests/_contract_ws", "tests/_ent_ws_quota", "tests/_ent_ws_chan" -ErrorAction SilentlyContinue
Pop-Location

if ($fail -eq 0) { Write-Host "ALL GREEN" } else { Write-Host "FAILURES"; exit 1 }
