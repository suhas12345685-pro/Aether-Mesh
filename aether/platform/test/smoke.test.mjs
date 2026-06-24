// Integration + security tests: boot Infrastructure (admin-token enforced) and
// Platform together, run real onboarding, and verify auth, RBAC, validation,
// encryption-at-rest, and DB persistence. Simulated mode -- no SDKs/paid accounts.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import { decryptSecret } from "../../shared/crypto.mjs";
import { fromJson, connectDb } from "../../shared/db.mjs";
import { verifyStripeSignature } from "../src/billing.mjs";

const ADMIN = "test-admin-token";
const SVC_ADMIN = "svc-admin-token";
// Use OS temp dir so rmSync works cross-platform (avoids NTFS EPERM).
const DB = join(tmpdir(), "test-platform.db");
process.env.AETHER_SECRET_KEY = "a".repeat(64);
process.env.INFRA_ADMIN_TOKEN = ADMIN;
process.env.INFRA_DB_FILE = ":memory:";
process.env.PLATFORM_DB_FILE = DB;
process.env.PLATFORM_SESSION_SECRET = "test-session-secret";
process.env.PLATFORM_ADMIN_TOKEN = SVC_ADMIN;
process.env.LOG_LEVEL = "error";
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

  let cookiesMap = new Map();
  const call = async (m, path, body, useCookie = true, headers = {}) => {
    const cookiesToSend = [];
    if (cookiesMap.has("__csrf")) {
      cookiesToSend.push(`__csrf=${cookiesMap.get("__csrf")}`);
    }
    if (useCookie && cookiesMap.has("aether_session")) {
      cookiesToSend.push(`aether_session=${cookiesMap.get("aether_session")}`);
    }
    const cookieHeader = cookiesToSend.join("; ");
      
    const reqHeaders = { 
      "Content-Type": "application/json", 
      ...(cookieHeader ? { Cookie: cookieHeader } : {}), 
      ...headers 
    };
    
    // Add CSRF token header if it's a state-changing method
    const csrfVal = cookiesMap.get("__csrf");
    if (["POST", "PATCH", "DELETE"].includes(m) && csrfVal && !headers["Authorization"]) {
      reqHeaders["x-csrf-token"] = csrfVal;
    }

    const res = await fetch(`http://localhost:${P}${path}`, {
      method: m,
      headers: reqHeaders,
      body: body ? JSON.stringify(body) : undefined,
    });

    const sc = res.headers.getSetCookie?.();
    if (sc && sc.length) {
      for (const cookieStr of sc) {
        const [kv] = cookieStr.split(";");
        const idx = kv.indexOf("=");
        if (idx > 0) {
          cookiesMap.set(kv.substring(0, idx).trim(), kv.substring(idx + 1).trim());
        }
      }
    }
    return { status: res.status, json: await res.json() };
  };

  const adminHdr = { Authorization: `Bearer ${SVC_ADMIN}` };

  try {
    // 1. Verify CSP response headers + nonces
    const getLanding = await fetch(`http://localhost:${P}/`);
    const csp = getLanding.headers.get("Content-Security-Policy");
    assert.ok(csp, "CSP header present");
    assert.match(csp, /nonce-/, "CSP contains a nonce");
    const landingHtml = await getLanding.text();
    assert.match(landingHtml, /nonce=/, "HTML script tags contain nonce");

    // 2. Verify API versioning (X-API-Version: v1)
    const versionRes = await fetch(`http://localhost:${P}/api/v1/version`);
    assert.equal(versionRes.status, 200);
    assert.equal(versionRes.headers.get("X-API-Version"), "v1");
    const versionJson = await versionRes.json();
    assert.equal(versionJson.version, "0.1.0");

    // 3. Verify CSRF protection (must fail with 403 if CSRF is missing on POST)
    const missingCsrfRes = await fetch(`http://localhost:${P}/api/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ org: "X", email: "a@acme.com", password: "hunter2pw", tier: "growth" }),
    });
    assert.equal(missingCsrfRes.status, 403, "rejects POST without CSRF");

    // Make an initial GET to fetch the CSRF cookie
    await call("GET", "/api/tiers");
    assert.ok(cookiesMap.has("__csrf"), "CSRF cookie set");

    const LIVE_KEY = "sk-LIVE-super-secret-123";
    const su = await call("POST", "/api/signup", {
      org: "Acme", email: "a@acme.com", password: "hunter2pw", tier: "growth",
      byob: { provider: "openai", model: "gpt-4", apiKey: LIVE_KEY },
    });
    assert.equal(su.status, 201, "signup succeeds with CSRF");
    assert.equal(su.json.customer.status, "active");
    assert.equal(su.json.customer.byob.apiKey, "••••••••", "key masked in response");
    const cid = su.json.customer.id;

    assert.equal((await call("GET", "/api/auth/me")).json.customer.email, "a@acme.com");

    assert.equal((await call("GET", "/api/customers", null, false)).status, 401);
    assert.equal((await call("GET", "/api/customers")).status, 403);
    assert.equal((await call("GET", `/api/customers/${cid}`)).status, 200);

    // 4. Verify worker-config hardening: rejects session cookie exfiltration, allows admin bearer exfiltration
    const wcForbidden = await call("GET", `/api/customers/${cid}/worker-config`);
    assert.equal(wcForbidden.status, 403, "rejects session cookie exfiltration on worker-config");

    const wc = await call("GET", `/api/customers/${cid}/worker-config`, null, false, adminHdr);
    assert.equal(wc.status, 200, "allows supervisor admin token exfiltration");
    assert.equal(wc.json.env.HERMES_API_KEY, LIVE_KEY, "BYOB key decrypted for the worker");
    assert.ok(wc.json.env.INFRA_API_TOKEN, "tenant token decrypted for the worker");

    assert.equal((await call("POST", "/api/auth/login", { email: "a@acme.com", password: "x" }, false)).status, 401);
    assert.equal((await call("POST", "/api/signup", { org: "X", email: "a@acme.com", password: "another8", tier: "starter" }, false)).status, 409);
    assert.equal((await call("POST", "/api/signup", { org: "Y", email: "y@y.com", password: "short", tier: "starter" }, false)).status, 400);

    const adminList = await call("GET", "/api/customers", null, false, adminHdr);
    assert.equal(adminList.status, 200, "service admin token lists customers");
    const audit = await call("GET", "/api/audit", null, false, adminHdr);
    assert.equal(audit.status, 200);
    assert.ok(audit.json.some((e) => e.event === "signup"), "signup audited");
    const metricsRes = await fetch(`http://localhost:${P}/metrics`);
    const metricsText = await metricsRes.text();
    assert.match(metricsText, /aether_http_requests_total/, "prometheus metrics exported");

    const wh = await call("POST", "/api/billing/webhook",
      { type: "customer.subscription.deleted", data: { object: { metadata: { customerId: cid } } } }, false);
    assert.equal(wh.status, 200);
    assert.equal(wh.json.applied, true);
    assert.equal((await call("GET", `/api/customers/${cid}`)).json.status, "canceled");

    // 5. Verify Session Revocation (logout & revoke-all)
    const loginRes = await call("POST", "/api/auth/login", { email: "a@acme.com", password: "hunter2pw" }, false);
    assert.equal(loginRes.status, 200);
    assert.ok(cookiesMap.has("aether_session"), "session cookie set on login");
    
    // Revoke all sessions for the customer
    const revokeAllRes = await call("POST", "/api/auth/revoke-all", { customerId: cid });
    assert.equal(revokeAllRes.status, 200, "revoke-all endpoint succeeds");
    
    // Verify that session is now rejected (returns 401)
    const meAfterRevoke = await call("GET", "/api/auth/me");
    assert.equal(meAfterRevoke.json.customer, null, "session is revoked");

    const rawDb = await connectDb(DB);
    const raw = await rawDb.get("SELECT byob FROM customers WHERE id = ?", [cid]);
    await rawDb.close();
    assert.ok(!raw.byob.includes(LIVE_KEY), "plaintext key must NOT be in the DB");
    const byob = fromJson(raw.byob);
    assert.ok(byob.apiKeyEnc.startsWith("v1:"), "stored as ciphertext");
    assert.equal(decryptSecret(byob.apiKeyEnc), LIVE_KEY, "ciphertext round-trips");
  } finally {
    platform.close();
    infra.close();
    await store.close();
    for (const ext of ["", "-wal", "-shm"]) {
      try { rmSync(DB + ext, { force: true }); } catch (_) { /* may be briefly locked */ }
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
  const DB2 = join(tmpdir(), "test-platform2.db");
  for (const ext of ["", "-wal", "-shm"]) rmSync(DB2 + ext, { force: true });
  const { CustomerStore } = await import("../src/store.mjs");
  const store2 = new CustomerStore(DB2);

  assert.equal(await store2.hasWebhookEvent("evt_test"), false);
  await store2.recordWebhookEvent("evt_test");
  assert.equal(await store2.hasWebhookEvent("evt_test"), true, "event marked as processed");
  await store2.recordWebhookEvent("evt_test");
  assert.equal(await store2.hasWebhookEvent("evt_test"), true, "still idempotent after repeat");

  const now = Date.now();
  const db2 = await store2._getDb();
  for (let i = 0; i < 3; i++) {
    await db2.run(
      `INSERT INTO customers
       (id, org, email, password_hash, role, tier, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [`cust_p${i}`, `Org${i}`, `p${i}@x.com`, "hash", "customer", "starter", "active", now + i, now + i]
    );
  }
  assert.equal((await store2.list({ limit: 2, offset: 0 })).length, 2, "limit=2 returns 2");
  assert.equal((await store2.list({ limit: 2, offset: 2 })).length, 1, "offset=2 returns last 1");
  assert.equal((await store2.list({ limit: 100, offset: 0 })).length, 3, "all 3 present");

  await store2.close();
  for (const ext of ["", "-wal", "-shm"]) {
    try { rmSync(DB2 + ext, { force: true }); } catch (_) { /* may be briefly locked */ }
  }
});
