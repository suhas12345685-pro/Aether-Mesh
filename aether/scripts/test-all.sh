#!/usr/bin/env bash
# Run every Aether test suite (Node + Python). Exits non-zero on first failure.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fail=0

echo "== Node suites =="
for svc in shared infra platform supervisor; do
  echo "--- $svc ---"
  (cd "$ROOT/$svc" && node --test) || fail=1
done

echo "== Python core =="
for t in test_smoke test_reliability test_contracts test_entitlements test_skills; do
  printf "  %-18s " "$t"
  (cd "$ROOT/core" && python "tests/$t.py") || fail=1
done
# clean transient workspaces
rm -rf "$ROOT"/core/tests/_contract_ws "$ROOT"/core/tests/_ent_ws_* 2>/dev/null || true

[ "$fail" -eq 0 ] && echo "ALL GREEN" || { echo "FAILURES"; exit 1; }
