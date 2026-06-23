# Aether Mesh — the synthetic employee

This `aether/` directory is the **product layer** that turns two open-source
engines into Aether Mesh. It does **not** fork them — it orchestrates them:

```
Communication surfaces (Slack/Teams/WhatsApp/Signal/Email/CLI)
        │
        ▼
OpenClaw gateway            ← ../openclaw      (cloned, untouched)
        │   multi-channel routing · normalization · task dispatch
        ▼
Hermes Agent  ──► BYOB LLM  ← ../hermes-agent  (cloned, untouched)
        │   memory · auto-skills · subagents · OpenAI-compatible API :8642
        ▼
Aether Core   ············  aether/core      (Python · THIS BUILD)
        │   heartbeat · task detection · self-correction · deliverable push
        ▼
Infrastructure layer ······ aether/infra     (Node · THIS BUILD)  :8090
        │   Twilio phone · email identity · Playwright browser · Docker VMs
        ▼
B2B platform ·············· aether/platform  (Node · THIS BUILD)  :8080
            subscription tiers · dashboard · BYOB config · onboarding
```

## Layers built here

| Path | Lang | Role |
|------|------|------|
| `core/` | Python | The autonomous brain-loop. Watches OpenClaw channels, detects open tasks, drives Hermes to solve them, self-corrects, pushes the deliverable back. Runs on the stdlib alone. |
| `infra/` | Node | The leased "body" each tenant gets: phone (Twilio), mailbox (SMTP), sandboxed browser (Playwright), isolated VM (Docker). HTTP API on `:8090`. |
| `platform/` | Node | The commercial wrapper: tiers, customer dashboard, BYOB config, onboarding. Calls `infra` to provision and renders the Aether Core worker spec. HTTP API + dashboard on `:8080`. |
| `shared/` | Node | Zero-dep security/data libs reused by infra+platform: `db.mjs` (embedded SQLite via `node:sqlite`), `crypto.mjs` (scrypt passwords, AES-256-GCM secrets, signed sessions), `validate.mjs`, `http.mjs` (rate limiter, security headers, body limits), `retry.mjs` (backoff + retrying fetch). |
| `supervisor/` | Node | Worker supervisor: pulls active tenants from the platform (admin service token), spawns one Aether Core process per tenant with its decrypted env, and restarts on crash with exponential backoff. This is what actually *runs* the fleet. |

## Real vs simulated

Every external integration ships as **real code, gated on a flag**. With the
flag off (default), that capability is *simulated* deterministically so the
whole product runs end-to-end with **no paid accounts and no installed SDKs**.
Flip the flag + install the dep + supply credentials to go live:

| Flag | Off (default) | On |
|------|---------------|----|
| `INFRA_TWILIO_REAL` | fake numbers / SMS | real Twilio buy + send |
| `INFRA_EMAIL_REAL` | fake message ids | real SMTP send (nodemailer) |
| `INFRA_BROWSER_REAL` | simulated actions | real headless Chromium (Playwright) |
| `INFRA_VM_REAL` | fake container ids | real per-tenant Docker containers |
| `PLATFORM_BILLING_REAL` | simulated subscription | real Stripe Checkout |

## Security model

- **Data**: embedded SQLite (`node:sqlite`, no native deps) behind a repository
  layer — swap for Postgres by reimplementing the same methods. WAL + enforced
  foreign keys + migrations.
- **Auth**: the platform uses scrypt-hashed passwords + signed session cookies
  (HttpOnly/SameSite) with RBAC (`customer` vs `admin`). The infra service uses
  an **admin token** (platform→infra provisioning) plus a **per-tenant token**
  (worker→infra capability calls), compared in constant time.
- **Secrets at rest**: BYOB API keys and tenant tokens are encrypted with
  AES-256-GCM (`AETHER_SECRET_KEY`). They are **never stored or returned in
  plaintext** — the worker spec is secret-free; a supervisor pulls the decrypted
  launch env from the authenticated `GET /api/customers/:id/worker-config`.
- **Boundary hardening**: input validation, JSON body-size limits, per-IP rate
  limiting (stricter on auth), and security headers on every response.
- **Tenancy**: each tenant VM is a Docker container with memory/CPU/PID limits,
  `CapDrop: ALL`, and `no-new-privileges`. Browser sessions are LRU-bounded.

In `production` (`NODE_ENV=production`) the services **refuse to boot** without
`AETHER_SECRET_KEY` and `PLATFORM_SESSION_SECRET`. In dev they fall back to
clearly-labelled insecure defaults.

## Reliability & integration

- **Retries**: cross-service calls use exponential backoff + jitter and retry
  only transient failures (network errors, 429/5xx). Provisioning is idempotent
  (keyed by tenant id), so retries are safe.
- **Circuit breaker**: the Aether Core → Hermes brain call trips open after 3
  consecutive failures and fast-fails for 30s (then a half-open trial), so a
  dead LLM never stalls the heartbeat — it falls back to the rule-based path.
- **Supervision**: the `supervisor/` service spawns/monitors one Core process
  per active tenant and restarts crashes with backoff. Graceful shutdown
  (SIGINT/SIGTERM) drains workers, browsers, and DB handles.
- **Probes**: every service exposes `GET /health` (liveness) and `GET /ready`
  (DB-backed readiness).

## Observability

- **Structured logs**: every service emits one JSON object per line (service,
  level, ts, msg, correlation `reqId`). Set `LOG_JSON=false` for human output,
  `LOG_LEVEL` to filter.
- **Tracing**: each request gets/propagates an `x-request-id`; all logs for that
  request carry the same `reqId`.
- **Metrics**: `GET /metrics` on infra + platform exposes Prometheus RED metrics
  (`aether_http_requests_total`, `aether_http_request_duration_seconds`).
- **Audit**: provisioning, capability calls, signup, login (success/fail), and
  BYOB changes are written to an `audit_log` table — `GET /audit` (infra, admin)
  and `GET /api/audit` (platform, admin).

### Verifying against the real engines

The OpenClaw/Hermes integration is pinned by a **contract test** that runs the
real bridges against mock servers (`core/tests/test_contracts.py`). Before a live
demo, confirm the assumptions against your installed engines:

1. Start `hermes gateway` with `API_SERVER_ENABLED=true`; confirm
   `GET http://localhost:8642/v1/models` and `POST /v1/chat/completions` respond.
2. Start `openclaw gateway`; confirm the channel-bridge routes in
   `core/aether_core/bridges/openclaw_bridge.py` (`ROUTES`) match
   `openclaw gateway routes`. Override `ROUTES`/`OPENCLAW_*` env if they differ.
3. Run `python -m aether_core status` — it reports brain/channel/body health.
4. Run the supervisor: `cd supervisor && node src/supervisor.mjs`.

## Commercial & compliance

- **Subscription lifecycle**: `POST /api/billing/webhook` verifies the Stripe
  signature (raw-body HMAC, timestamp tolerance) and transitions the customer:
  `checkout.session.completed` → active, `invoice.payment_failed` → past_due,
  `customer.subscription.deleted` → canceled.
- **Entitlements**: tier limits are injected into each worker's env and enforced
  by the core — `AETHER_MAX_CHANNELS` caps watched channels, and
  `AETHER_MAX_DELIVERABLES_PER_DAY` caps daily output (0 = unlimited). A lapsed
  subscription flips status off `active`, so the supervisor stops the worker.
- **Capability gating**: each tier's capabilities (phone/email/browser/vm) are
  stored on the tenant at provision time and enforced by the infra service —
  e.g. the Intern tier gets 403 on `vm/exec` and `browser`.
- **Audit**: every commercially-relevant action (signup, login, BYOB change,
  provisioning, billing events, capability use) is recorded in `audit_log`.

## Quick start (local, all-simulated)

```bash
cp aether/.env.example aether/.env        # edit if you want
# 1. infra (the body)
cd aether/infra && node src/index.mjs
# 2. platform (dashboard + onboarding) — new terminal
cd aether/platform && node src/server.mjs   # open http://localhost:8080
# 3. brain + channels (the cloned engines)
#    cd hermes-agent && hermes gateway       (API_SERVER_ENABLED=true)
#    cd openclaw && openclaw gateway
# 4. a tenant's Aether Core worker — new terminal
cd aether/core && AETHER_TENANT_ID=demo python -m aether_core run
```

Helper scripts do steps 1–2 for you: `aether/run-dev.ps1` (Windows) /
`aether/run-dev.sh` (POSIX). `docker-compose.yml` wires all five services.

## Going live

1. `npm install` inside `infra/` and `platform/` to pull the real SDKs.
2. Fill the credentials + flip the `*_REAL` flags in `aether/.env`.
3. Start `hermes gateway` with `API_SERVER_ENABLED=true`, and `openclaw gateway`.
4. Point a customer's BYOB config at their own Claude/GPT-4/Ollama endpoint in
   the dashboard — their keys never leave the rendered worker env.

## Tests

Run everything (Node + Python) with one command:

```bash
bash aether/scripts/test-all.sh      # or: pwsh aether/scripts/test-all.ps1
```

Suites: `shared` (crypto/db/validate/http/retry/metrics), `infra` (auth +
capability gating), `platform` (onboarding, RBAC, encryption-at-rest, billing),
`supervisor` (lifecycle), and `core` (offline loop, reliability, contract,
entitlements). CI runs them on Node 24 + Python 3.13 (`.github/workflows/ci.yml`).

## Build & deploy

Production Dockerfiles build from the `aether/` root (so `shared/` is included)
and run as non-root with healthchecks:

```bash
cd aether
docker build -f infra/Dockerfile      -t aether/infra .
docker build -f platform/Dockerfile   -t aether/platform .
docker build -f supervisor/Dockerfile -t aether/supervisor .
docker build -f core/Dockerfile       -t aether/core .
```

`docker-compose.yml` wires the services for local dev (bind-mounts + base
images); for multi-tenant operation run the **supervisor** rather than a single
bare `core`.
