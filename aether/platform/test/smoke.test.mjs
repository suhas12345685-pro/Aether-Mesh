// Integration + security tests: boot Infrastructure (admin-token enforced) and
// Platform together, run real onboarding, and verify auth, RBAC, validation,
// encryption-at-rest, and DB persistence. Simulated mode — no SDKs/paid accounts.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { rmSync } from "node:fs";
import { test } from "node:test";

import { decryptSecret } from "../../shared/crypto.mjs";
import { fromJson, openDb } from "../../shared/db.mjs";
import { verifyStripeSignature } from "../src/billing.mjs";

const ADMIN = "test-admin-token";
const SVC_ADMIN = "svc-admin-token";
const DB = "./data/test-platform.db";
process.env.AETHER_SECRET_KEY = "a".repeat(64); // fixed 32-byte hex key
process.env.INFRA_ADMIN_TOKEN = ADMIN;
process.env.INFRA_DB_FILE = ":memory:";
process.env.PLATFORM_DB_FILE = DB;
process.env.PLATFORM_SESSION_SECRET = "test-session-secret";
process.env.PLATFORM_ADMIN_TOKEN = SVC_ADMIN; // service-to-service admin
process.env.LOG_LEVEL = "error"; // quiet request logs during tests
for (const ext of ["", "-wal", "-shm"]) rmSync(DB + ext, { force: true });

function listen(s) {
  return new Promise((r) => s.listen(0, () => r(s.address().port)));
}

test("platform: accounts, RBAC, encryption-at-rest, persistence", async () => {
  const { createInfraServer } = await import("../../infra/src/index.mjs");
  const infra = createInfraServer();
  const infraPort = await listen(infra);
  process.env.INFRA_API_BASE = `http://localhost:${infraPort}`;

  const { createPlatformServer, store } = await import("../src/server.mjs");
  const platform = createPlatformServer();
  const P = await listen(platform);

  let cookie = "";
  const call = async (m, path, body, useCookie = true, headers = {}) => {
    const res = await fetch(`http://localhost:${P}${path}`, {
      method: m,
      headers: { "Content-Type": "application/json", ...(useCookie && cookie ? { Cookie: cookie } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.getSetCookie?.();
    if (sc && sc.length) cookie = sc[0].split(";")[0];
    return { status: res.status, json: await res.json() };
  };
  const adminHdr = { Authorization: `Bearer ${SVC_ADMIN}` };

  try {
    const LIVE_KEY = "sk-LIVE-super-secret-123";
    const su = await call("POST", "/api/signup", {
      org: "Acme", email: "a@acme.com", password: "hunter2pw", tier: "manager",
      byob: { provider: "openai", model: "gpt-4", apiKey: LIVE_KEY },
    });
    assert.equal(su.status, 201);
    assert.equal(su.json.customer.status, "active");
    assert.equal(su.json.customer.byob.apiKey, "••••••••", "key masked in response");
    const cid = su.json.customer.id;

    // session works
    assert.equal((await call("GET", "/api/auth/me")).json.customer.email, "a@acme.com");

    // RBAC: non-admin cannot list; unauthenticated gets 401
    assert.equal((await call("GET", "/api/customers", null, false)).status, 401);
    assert.equal((await call("GET", "/api/customers")).status, 403);
    assert.equal((await call("GET", `/api/customers/${cid}`)).status, 200);

    // worker-config decrypts secrets for the authorized owner
    const wc = await call("GET", `/api/customers/${cid}/worker-config`);
    assert.equal(wc.json.env.HERMES_API_KEY, LIVE_KEY, "BYOB key decrypted for the worker");
    assert.ok(wc.json.env.INFRA_API_TOKEN, "tenant token decrypted for the worker");

    // auth failures + validation
    assert.equal((await call("POST", "/api/auth/login", { email: "a@acme.com", password: "x" }, false)).status, 401);
    assert.equal((await call("POST", "/api/signup", { org: "X", email: "a@acme.com", password: "another8", tier: "intern" }, false)).status, 409);
    assert.equal((await call("POST", "/api/signup", { org: "Y", email: "y@y.com", password: "short", tier: "intern" }, false)).status, 400);

    // OBSERVABILITY: service-admin token grants admin; audit captured; metrics export.
    const adminList = await call("GET", "/api/customers", null, false, adminHdr);
    assert.equal(adminList.status, 200, "service admin token lists customers");
    const audit = await call("GET", "/api/audit", null, false, adminHdr);
    assert.equal(audit.status, 200);
    assert.ok(audit.json.some((e) => e.event === "signup"), "signup audited");
    const metricsRes = await fetch(`http://localhost:${P}/metrics`);
    const metricsText = await metricsRes.text();
    assert.match(metricsText, /aether_http_requests_total/, "prometheus metrics exported");

    // BILLING: webhook transitions subscription status (no secret => accepted).
    const wh = await call("POST", "/api/billing/webhook",
      { type: "customer.subscription.deleted", data: { object: { metadata: { customerId: cid } } } }, false);
    assert.equal(wh.status, 200);
    assert.equal(wh.json.applied, true);
    assert.equal((await call("GET", `/api/customers/${cid}`)).json.status, "canceled");

    // ENCRYPTION AT REST: read the raw DB row; plaintext key must not appear.
    const rawDb = openDb(DB);
    const raw = rawDb.prepare("SELECT byob FROM customers WHERE id = ?").get(cid);
    rawDb.close();
    assert.ok(!raw.byob.includes(LIVE_KEY), "plaintext key must NOT be in the DB");
    const byob = fromJson(raw.byob);
    assert.ok(byob.apiKeyEnc.startsWith("v1:"), "stored as ciphertext");
    assert.equal(decryptSecret(byob.apiKeyEnc), LIVE_KEY, "ciphertext round-trips");
  } finally {
    platform.close();
    infra.close();
    store.close();
    for (const ext of ["", "-wal", "-shm"]) {
      try { rmSync(DB + ext, { force: true }); } catch { /* file may be briefly locked on Windows */ }
    }
  }
});

test("billing: Stripe webhook signature verification", () => {
  const secret = "whsec_test";
  const payload = JSON.stringify({ type: "checkout.session.completed" });
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");

  assert.equal(verifyStripeSignature(payload, `t=${t},v1=${sig}`, secret), true);
  assert.throws(() => verifyStripeSignature(payload, `t=${t},v1=deadbeef`, secret), /invalid/);
  assert.throws(() => verifyStripeSignature(payload, `t=${t - 9999},v1=${sig}`, secret), /stale/);
});

test("webhook idempotency + customer list pagination", async () => {
  const DB2 = "./data/test-platform2.db";
  for (const ext of ["", "-wal", "-shm"]) rmSync(DB2 + ext, { force: true });
  // Do NOT mutate process.env.PLATFORM_DB_FILE here — top-level tests run
  // concurrently in Node 24 and the mutation would race with test 1's import.
  const { CustomerStore } = await import("../src/store.mjs");
  const store2 = new CustomerStore(DB2);

  // Webhook idempotency: same event ID seen twice => second is a no-op.
  assert.equal(store2.hasWebhookEvent("evt_test"), false);
  store2.recordWebhookEvent("evt_test");
  assert.equal(store2.hasWebhookEvent("evt_test"), true, "event marked as processed");
  store2.recordWebhookEvent("evt_test"); // must not throw (INSERT OR IGNORE)
  assert.equal(store2.hasWebhookEvent("evt_test"), true, "still idempotent after repeat");

  // Pagination: create 3 customers and verify limit/offset work.
  const now = Date.now();
  for (let i = 0; i < 3; i++) {
    store2.db
      .prepare(`INSERT INTO customers
        (id, org, email, password_hash, role, tier, status, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(`cust_p${i}`, `Org${i}`, `p${i}@x.com`, "hash", "customer", "intern", "active", now + i, now + i);
  }
  assert.equal(store2.list({ limit: 2, offset: 0 }).length, 2, "limit=2 returns 2");
  assert.equal(store2.list({ limit: 2, offset: 2 }).length, 1, "offset=2 returns last 1");
  assert.equal(store2.list({ limit: 100, offset: 0 }).length, 3, "all 3 present");

  store2.close();
  for (const ext of ["", "-wal", "-shm"]) {
    try { rmSync(DB2 + ext, { force: true }); } catch { /* brief lock on Windows */ }
  }
});
