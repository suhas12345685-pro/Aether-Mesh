#!/usr/bin/env node
// B2B platform HTTP service: customer dashboard + onboarding/BYOB API. Hardened:
// account login with scrypt passwords, signed session cookies, RBAC, encrypted
// secrets at rest, input validation, rate limiting, and security headers.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

import {
  encryptSecret, safeEqual, signSession, verifyPassword, verifySession,
} from "../../shared/crypto.mjs";
import {
  RateLimiter, bearer, clientIp, cookies, readJson, readRaw,
  safeErrorMessage, securityHeaders, sendJson, statusFor,
} from "../../shared/http.mjs";
import { metricsText } from "../../shared/metrics.mjs";
import { instrument } from "../../shared/observe.mjs";
import { email as vEmail, oneOf, str } from "../../shared/validate.mjs";
import { verifyStripeSignature, createCheckoutSession, createRazorpayOrder, verifyRazorpaySignature } from "./billing.mjs";
import { buildByobConfig, listProviders, redact } from "./byob.mjs";
import { onboard, renderWorkerConfig, renderWorkerSpec, searchAvailableNumbers, selectPhoneNumber } from "./onboarding.mjs";
import { CustomerStore } from "./store.mjs";
import { getTier, listTiers } from "./tiers.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", "public");
const SESSION_SECRET = process.env.PLATFORM_SESSION_SECRET || "";
// Service-to-service admin token (the worker supervisor uses this).
const PLATFORM_ADMIN_TOKEN = process.env.PLATFORM_ADMIN_TOKEN || "";
const SECURE_COOKIE = (process.env.PLATFORM_PUBLIC_URL || "").startsWith("https");
const TIER_IDS = ["intern", "manager", "enterprise"];
const PROVIDER_IDS = ["anthropic", "openai", "ollama", "custom"];

if (!SESSION_SECRET && process.env.NODE_ENV === "production") {
  throw new Error("PLATFORM_SESSION_SECRET is required in production");
}
const sessionSecret = SESSION_SECRET || "dev-insecure-session-secret";

const store = new CustomerStore();
const limiter = new RateLimiter({ capacity: 100, refillPerSec: 2 });
const authLimiter = new RateLimiter({ capacity: 10, refillPerSec: 0.2 }); // strict on auth
setInterval(() => { limiter.sweep(); authLimiter.sweep(); }, 60_000).unref?.();

class HttpError extends Error {
  constructor(status, message) { super(message); this.statusCode = status; }
}

// ---- session helpers -----------------------------------------------------
function setSession(res, customer) {
  const token = signSession({ sub: customer.id, role: customer.role }, sessionSecret);
  const attrs = ["Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=604800"];
  if (SECURE_COOKIE) attrs.push("Secure");
  res.setHeader("Set-Cookie", `aether_session=${token}; ${attrs.join("; ")}`);
}
function clearSession(res) {
  res.setHeader("Set-Cookie", "aether_session=; Path=/; HttpOnly; Max-Age=0");
}
function currentSession(req) {
  // Service callers (the supervisor) authenticate with the admin bearer token.
  const b = bearer(req);
  if (PLATFORM_ADMIN_TOKEN && b && safeEqual(b, PLATFORM_ADMIN_TOKEN)) {
    return { sub: "service", role: "admin" };
  }
  return verifySession(cookies(req).aether_session, sessionSecret);
}
function requireAuth(req) {
  const s = currentSession(req);
  if (!s) throw new HttpError(401, "authentication required");
  return s;
}
function requireOwnerOrAdmin(session, customerId) {
  if (session.role !== "admin" && session.sub !== customerId) {
    throw new HttpError(403, "forbidden");
  }
}

// ---- response shaping ----------------------------------------------------
function safeCustomer(c) {
  if (!c) return null;
  const { tenantTokenEnc, ...rest } = c;
  return { ...rest, byob: redact(c.byob) };
}

const CSP = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
].join("; ");

async function serveStatic(res, file) {
  try {
    const body = await readFile(join(PUBLIC_DIR, file));
    const isHtml = file.endsWith(".html");
    const isCss = file.endsWith(".css");
    const isJs = file.endsWith(".js");
    let contentType = "application/octet-stream";
    if (isHtml) contentType = "text/html; charset=utf-8";
    else if (isCss) contentType = "text/css; charset=utf-8";
    else if (isJs) contentType = "application/javascript; charset=utf-8";

    const headers = { "Content-Type": contentType };
    if (isHtml) headers["Content-Security-Policy"] = CSP;
    res.writeHead(200, headers);
    res.end(body);
  } catch {
    sendJson(res, 404, { error: "not found" });
  }
}

// ---- router --------------------------------------------------------------
async function route(req, res) {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  const parts = p.split("/").filter(Boolean);

  if (req.method === "GET" && p === "/health") return sendJson(res, 200, { ok: true, service: "aether-platform" });
  if (req.method === "GET" && p === "/ready") {
    try { store.ping(); return sendJson(res, 200, { ready: true }); }
    catch (err) { return sendJson(res, 503, { ready: false, error: err.message }); }
  }
  if (req.method === "GET" && p === "/metrics") {
    res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
    return res.end(metricsText());
  }
  if (req.method === "GET" && p === "/") return serveStatic(res, "landing.html");
  if (req.method === "GET" && (p === "/app" || p === "/dashboard" || p === "/login")) return serveStatic(res, "dashboard.html");
  if (req.method === "GET" && p === "/style.css") return serveStatic(res, "style.css");
  if (req.method === "GET" && p === "/main.js") return serveStatic(res, "main.js");

  // rate limit (stricter bucket for auth/signup)
  const isAuthRoute = p === "/api/signup" || p.startsWith("/api/auth/");
  const lim = isAuthRoute ? authLimiter : limiter;
  if (!lim.check(clientIp(req))) return sendJson(res, 429, { error: "rate limited" });

  // Stripe webhook (raw body for signature verification; no session).
  if (req.method === "POST" && p === "/api/billing/webhook") {
    const raw = await readRaw(req);
    const secret = process.env.STRIPE_WEBHOOK_SECRET || "";
    if (secret) verifyStripeSignature(raw, req.headers["stripe-signature"], secret);
    let event;
    try { event = JSON.parse(raw || "{}"); } catch { throw new HttpError(400, "invalid JSON"); }
    // Idempotency: Stripe re-delivers events; skip duplicates.
    const eventId = event?.id;
    if (eventId && store.hasWebhookEvent(eventId)) {
      return sendJson(res, 200, { received: true, applied: false, duplicate: true });
    }
    const obj = event?.data?.object || {};
    const customerId = obj.metadata?.customerId;
    const transitions = {
      "checkout.session.completed": { status: "active", sub: "active" },
      "customer.subscription.created": { status: "active", sub: "active" },
      "invoice.payment_failed": { status: "past_due", sub: "past_due" },
      "customer.subscription.deleted": { status: "canceled", sub: "canceled" },
    };
    const tr = transitions[event?.type];
    const existing = customerId ? store.get(customerId) : null;
    if (tr && existing) {
      const updateData = {
        status: tr.status,
        subscription: { ...(existing.subscription || {}), status: tr.sub, lastEvent: event.type },
      };
      if (obj.metadata?.cloudDeploy === "true") {
        updateData.cloudDeploy = {
          status: "active",
          url: `https://${existing.org.toLowerCase().replace(/[^a-z0-9]/g, "") || "tenant"}.aethermesh.app`,
          container: `aether-${customerId}`,
          uptime: 0,
        };
      }
      store.update(customerId, updateData);
      store.audit("billing_webhook", { customerId, meta: { type: event.type, status: tr.status } });
    }
    if (eventId) store.recordWebhookEvent(eventId);
    return sendJson(res, 200, { received: true, applied: !!(tr && existing) });
  }

  if (req.method === "GET" && p === "/api/tiers") return sendJson(res, 200, listTiers());
  if (req.method === "GET" && p === "/api/byob/providers") return sendJson(res, 200, listProviders());

  // GET /api/provision/phone-numbers — browse available Twilio numbers for the picker
  if (req.method === "GET" && p === "/api/provision/phone-numbers") {
    requireAuth(req);
    const areaCode = url.searchParams.get("areaCode") || "415";
    const country = url.searchParams.get("country") || "US";
    const limit = Math.min(Number(url.searchParams.get("limit") || 10), 20);
    const numbers = await searchAvailableNumbers(areaCode, country, limit);
    return sendJson(res, 200, numbers);
  }

  // ---- signup (open) -> creates account + onboards + logs in -------------
  if (req.method === "POST" && p === "/api/signup") {
    const body = await readJson(req);
    str(body, "org", { max: 120 });
    vEmail(body);
    str(body, "password", { min: 8, max: 200 });
    oneOf(body, "tier", TIER_IDS);
    let byob;
    if (body.byob) {
      oneOf(body.byob, "provider", PROVIDER_IDS);
      byob = buildByobConfig(body.byob);
    }
    const result = await onboard(store, { ...body, byob });
    store.audit("signup", {
      customerId: result.customer.id, actor: result.customer.email,
      meta: { tier: body.tier, provisioned: result.steps.provisioned },
    });
    setSession(res, result.customer);
    return sendJson(res, 201, { ...result, customer: safeCustomer(result.customer) });
  }

  // ---- auth --------------------------------------------------------------
  if (req.method === "POST" && p === "/api/auth/login") {
    const body = await readJson(req);
    vEmail(body);
    str(body, "password", { max: 200 });
    const row = store.getByEmail(body.email);
    if (!row || !verifyPassword(body.password, row.password_hash)) {
      store.audit("login_failed", { actor: body.email });
      throw new HttpError(401, "invalid credentials");
    }
    const customer = store.get(row.id);
    store.audit("login_success", { customerId: row.id, actor: customer.email });
    setSession(res, customer);
    return sendJson(res, 200, { customer: safeCustomer(customer) });
  }
  if (req.method === "POST" && p === "/api/auth/logout") {
    clearSession(res);
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === "GET" && p === "/api/auth/me") {
    const s = currentSession(req);
    if (!s) return sendJson(res, 200, { customer: null });
    return sendJson(res, 200, { customer: safeCustomer(store.get(s.sub)) });
  }

  if (req.method === "POST" && p === "/api/billing/checkout") {
    const s = requireAuth(req);
    const body = await readJson(req);
    const addCloudDeploy = !!body.addCloudDeploy;
    const customer = store.get(s.sub);
    if (!customer) throw new HttpError(404, "customer not found");

    const checkout = await createCheckoutSession(customer, customer.tier, addCloudDeploy);

    if (checkout.simulated) {
      const updateData = {
        status: "active",
        subscription: { status: "active", simulated: true, lastEvent: "simulated_success" },
      };
      if (addCloudDeploy) {
        updateData.cloudDeploy = {
          status: "active",
          url: `https://${customer.org.toLowerCase().replace(/[^a-z0-9]/g, "") || "tenant"}.aethermesh.app`,
          container: `aether-${customer.id}`,
          uptime: 0,
        };
      }
      store.update(customer.id, updateData);
    }

    store.audit("billing_checkout_session", {
      customerId: customer.id,
      actor: s.sub,
      meta: { tier: customer.tier, addCloudDeploy, simulated: checkout.simulated }
    });

    return sendJson(res, 200, { url: checkout.checkoutUrl });
  }

  if (req.method === "POST" && p === "/api/billing/razorpay/order") {
    const s = requireAuth(req);
    const body = await readJson(req);
    const addCloudDeploy = !!body.addCloudDeploy;
    const customer = store.get(s.sub);
    if (!customer) throw new HttpError(404, "customer not found");

    const order = await createRazorpayOrder(customer, customer.tier, addCloudDeploy);
    store.audit("billing_razorpay_order_created", {
      customerId: customer.id,
      actor: s.sub,
      meta: { tier: customer.tier, addCloudDeploy, orderId: order.orderId, simulated: order.simulated }
    });

    return sendJson(res, 200, order);
  }

  if (req.method === "POST" && p === "/api/billing/razorpay/verify") {
    const s = requireAuth(req);
    const body = await readJson(req);
    const { razorpayPaymentId, razorpayOrderId, razorpaySignature, addCloudDeploy } = body;
    const customer = store.get(s.sub);
    if (!customer) throw new HttpError(404, "customer not found");

    const verified = verifyRazorpaySignature(razorpayPaymentId, razorpayOrderId, razorpaySignature);
    if (!verified) {
      store.audit("billing_razorpay_verification_failed", {
        customerId: customer.id,
        actor: s.sub,
        meta: { razorpayOrderId, razorpayPaymentId }
      });
      throw new HttpError(400, "invalid payment signature");
    }

    const updateData = {
      status: "active",
      subscription: { status: "active", method: "razorpay", paymentId: razorpayPaymentId, orderId: razorpayOrderId },
    };

    if (addCloudDeploy) {
      updateData.cloudDeploy = {
        status: "active",
        url: `https://${customer.org.toLowerCase().replace(/[^a-z0-9]/g, "") || "tenant"}.aethermesh.app`,
        container: `aether-${customer.id}`,
        uptime: 0,
      };
    }

    store.update(customer.id, updateData);

    store.audit("billing_razorpay_verification_success", {
      customerId: customer.id,
      actor: s.sub,
      meta: { tier: customer.tier, addCloudDeploy, razorpayPaymentId }
    });

    return sendJson(res, 200, { ok: true });
  }

  // ---- customers (authenticated) -----------------------------------------
  if (req.method === "GET" && p === "/api/customers") {
    const s = requireAuth(req);
    if (s.role !== "admin") throw new HttpError(403, "admin only");
    const limit = Math.min(Number(url.searchParams.get("limit") || 100), 1000);
    const offset = Math.max(Number(url.searchParams.get("offset") || 0), 0);
    return sendJson(res, 200, store.list({ limit, offset }).map(safeCustomer));
  }

  if (req.method === "GET" && p === "/api/audit") {
    const s = requireAuth(req);
    if (s.role !== "admin") throw new HttpError(403, "admin only");
    return sendJson(res, 200, store.recentAudit());
  }

  if (parts[0] === "api" && parts[1] === "customers" && parts[2]) {
    const id = parts[2];
    const s = requireAuth(req);
    requireOwnerOrAdmin(s, id);
    const customer = store.get(id);
    if (!customer) return sendJson(res, 404, { error: "not found" });

    if (req.method === "GET" && parts.length === 3) return sendJson(res, 200, safeCustomer(customer));

    if (req.method === "POST" && parts[3] === "byob") {
      const body = await readJson(req);
      oneOf(body, "provider", PROVIDER_IDS);
      const cfg = buildByobConfig(body);
      const { apiKey, ...rest } = cfg;
      const updated = store.update(id, { byob: { ...rest, apiKeyEnc: encryptSecret(apiKey) } });
      store.audit("byob_update", { customerId: id, actor: s.sub, meta: { provider: cfg.provider } });
      return sendJson(res, 200, safeCustomer(updated));
    }

    if (req.method === "PATCH" && parts[3] === "byob") {
      const body = await readJson(req);
      const curByob = customer.byob || {};
      const updatedByob = {
        provider: body.provider || curByob.provider,
        model: body.model || curByob.model,
        base: body.base || curByob.base,
        apiKeyEnc: body.apiKeyEnc !== undefined ? body.apiKeyEnc : curByob.apiKeyEnc,
        isE2E: body.isE2E !== undefined ? body.isE2E : curByob.isE2E,
      };
      const updated = store.update(id, { byob: updatedByob });
      store.audit("byob_patch", { customerId: id, actor: s.sub, meta: { provider: updatedByob.provider } });
      return sendJson(res, 200, safeCustomer(updated));
    }

    // POST /api/customers/:id/phone — select a specific Twilio number for the agent
    if (req.method === "POST" && parts[3] === "phone") {
      const body = await readJson(req);
      str(body, "phoneNumber", { max: 20 });
      const result = await selectPhoneNumber(id, body.phoneNumber, customer.tier);
      const { token, ...identity } = result;
      let updated = store.update(id, {
        infra: identity,
        tenantTokenEnc: encryptSecret(token),
      });
      const workerSpec = renderWorkerSpec(updated, getTier(customer.tier));
      updated = store.update(id, { workerSpec });
      store.audit("phone_selected", { customerId: id, actor: s.sub, meta: { phone: body.phoneNumber } });
      return sendJson(res, 200, safeCustomer(updated));
    }

    if (req.method === "DELETE" && parts[3] === "cloud") {
      const updated = store.update(id, { cloudDeploy: null });
      store.audit("cloud_deprovision", { customerId: id, actor: s.sub });
      return sendJson(res, 200, safeCustomer(updated));
    }

    if (req.method === "GET" && parts[3] === "activity") {
      const mockActivity = [
        { id: "act_1", timestamp: new Date(Date.now() - 60000).toISOString(), conversations: 3, tasks_detected: 1, deliverables_sent: 1, status: "ok", summary: "Completed task: summarize Q3 report" },
        { id: "act_2", timestamp: new Date(Date.now() - 3600000).toISOString(), conversations: 2, tasks_detected: 0, deliverables_sent: 0, status: "ok", summary: "Checked channels, no new tasks" },
        { id: "act_3", timestamp: new Date(Date.now() - 7200000).toISOString(), conversations: 4, tasks_detected: 2, deliverables_sent: 2, status: "ok", summary: "Sent email updates to client" },
      ];
      return sendJson(res, 200, mockActivity);
    }

    // Supervisor pulls the full launch env (secrets decrypted) — owner/admin only.
    if (req.method === "GET" && parts[3] === "worker-config") {
      const cfg = renderWorkerConfig(customer, getTier(customer.tier));
      return sendJson(res, 200, cfg);
    }
  }

  return sendJson(res, 404, { error: "no such route", path: p });
}

export function createPlatformServer() {
  const server = createServer(instrument("aether-platform", (req, res) => {
    securityHeaders(res, { hsts: SECURE_COOKIE });
    return route(req, res).catch((err) => {
      const status = statusFor(err);
      sendJson(res, status, { error: safeErrorMessage(err, status) });
    });
  }));
  server.keepAliveTimeout = 5_000;
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!SESSION_SECRET) console.warn("[aether-platform] PLATFORM_SESSION_SECRET unset — using a dev secret");
  const port = Number(process.env.PLATFORM_PORT || 8080);
  const server = createPlatformServer();
  server.listen(port, () => console.log(`[aether-platform] dashboard + API on http://localhost:${port}`));
  const shutdown = () => { server.close(); store.close(); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

export { store };
