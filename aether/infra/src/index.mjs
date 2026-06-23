#!/usr/bin/env node
// Infrastructure layer HTTP service — the API Aether Core calls to use the
// leased "body". Hardened: bearer auth (admin token + per-tenant token),
// input validation, security headers, body-size limits, and rate limiting.
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

import { safeEqual } from "../../shared/crypto.mjs";
import { metricsText } from "../../shared/metrics.mjs";
import { instrument } from "../../shared/observe.mjs";
import {
  RateLimiter,
  bearer,
  clientIp,
  readFormBody,
  readJson,
  safeErrorMessage,
  securityHeaders,
  sendJson,
  statusFor,
} from "../../shared/http.mjs";
import { str } from "../../shared/validate.mjs";
import { browserAction, closeAllSessions } from "./browser.mjs";
import { sendEmail } from "./email.mjs";
import { parseInbound, parseTwilio, verifyMailgunSignature, verifyTwilioSignature } from "./inbound.mjs";
import { Provisioner } from "./provisioner.mjs";
import { searchNumbers, sendSms } from "./twilio.mjs";
import { vmExec, vmStatus } from "./vms.mjs";

const ADMIN_TOKEN = process.env.INFRA_ADMIN_TOKEN || "";
const provisioner = new Provisioner();
const limiter = new RateLimiter({ capacity: 120, refillPerSec: 2 });
setInterval(() => limiter.sweep(), 60_000).unref?.();

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.statusCode = status;
  }
}

// Capability gate: maps a capability route to the tier capability flag.
const CAP_FOR = { sms: "phone", email: "email", browser: "browser", "vm/exec": "vm" };
function requireCapability(tenant, sub) {
  const cap = CAP_FOR[sub];
  if (cap && tenant.capabilities && tenant.capabilities[cap] === false) {
    throw new HttpError(403, `capability '${cap}' is not enabled for this tier`);
  }
}

// Returns the caller role or throws 401/403. scope: "admin" | "tenant".
function authorize(req, scope, tenantId) {
  if (!ADMIN_TOKEN) return "dev"; // no admin token configured => dev open mode
  const token = bearer(req);
  if (!token) throw new HttpError(401, "missing bearer token");
  if (safeEqual(token, ADMIN_TOKEN)) return "admin";
  if (scope === "tenant" && tenantId && provisioner.verifyToken(tenantId, token)) {
    return "tenant";
  }
  throw new HttpError(403, "forbidden");
}

async function route(req, res) {
  const url = new URL(req.url, "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);

  if (req.method === "GET" && url.pathname === "/health") {
    return sendJson(res, 200, { ok: true, service: "aether-infra" });
  }
  if (req.method === "GET" && url.pathname === "/ready") {
    try {
      provisioner.store.ping();
      return sendJson(res, 200, { ready: true });
    } catch (err) {
      return sendJson(res, 503, { ready: false, error: err.message });
    }
  }
  if (req.method === "GET" && url.pathname === "/metrics") {
    res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
    return res.end(metricsText());
  }

  // rate limit everything else by client IP
  if (!limiter.check(clientIp(req))) return sendJson(res, 429, { error: "rate limited" });

  if (req.method === "GET" && url.pathname === "/audit") {
    authorize(req, "admin");
    return sendJson(res, 200, provisioner.store.recentAudit());
  }

  // GET /numbers/available  — search available Twilio numbers (admin)
  if (req.method === "GET" && url.pathname === "/numbers/available") {
    authorize(req, "admin");
    const areaCode = url.searchParams.get("areaCode") || process.env.TWILIO_AREA_CODE || "415";
    const country = url.searchParams.get("country") || "US";
    const limit = Math.min(Number(url.searchParams.get("limit") || 10), 20);
    return sendJson(res, 200, await searchNumbers({ areaCode, country, limit }));
  }

  // POST /provision  (admin)
  if (req.method === "POST" && url.pathname === "/provision") {
    authorize(req, "admin");
    const body = await readJson(req);
    const tenantId = str(body, "tenantId", { max: 64 });
    const t = await provisioner.provision(tenantId, {
      tier: body.tier,
      capabilities: body.capabilities || null,
      persona: body.persona || null,
      preferredPhoneNumber: body.preferredPhoneNumber || null,
    });
    return sendJson(res, 201, t); // includes one-time plaintext `token`
  }

  // POST /inbound/email  — Mailgun/SendGrid inbound parse webhook (no auth; sig verified)
  if (req.method === "POST" && url.pathname === "/inbound/email") {
    const ct = req.headers["content-type"] || "";
    let fields;
    if (ct.includes("application/json")) {
      fields = await readJson(req);
    } else {
      fields = await readFormBody(req);
    }
    // Mailgun signature verification (skipped if MAILGUN_WEBHOOK_SIGNING_KEY unset).
    if (fields.timestamp && fields.token && fields.signature) {
      if (!verifyMailgunSignature(fields.timestamp, fields.token, fields.signature)) {
        return sendJson(res, 403, { error: "invalid webhook signature" });
      }
    }
    const msg = parseInbound(fields, req);
    if (!msg.toAddr) return sendJson(res, 400, { error: "missing recipient" });
    const tenant = provisioner.store.getByEmailAddress(msg.toAddr);
    if (!tenant) return sendJson(res, 404, { error: "no tenant for that address" });
    provisioner.store.queueInbound(tenant.id, msg);
    provisioner.store.audit("email_received", tenant.id, { from: msg.fromAddr, subject: msg.subject });
    return sendJson(res, 200, { queued: true, tenantId: tenant.id });
  }

  // POST /inbound/sms  — Twilio inbound SMS webhook (no auth; signature verified)
  if (req.method === "POST" && url.pathname === "/inbound/sms") {
    const fields = await readFormBody(req);
    const sig = req.headers["x-twilio-signature"] || "";
    const webhookUrl = process.env.TWILIO_WEBHOOK_URL ||
      `http://${req.headers.host}/inbound/sms`;
    if (!verifyTwilioSignature(webhookUrl, fields, sig)) {
      return sendJson(res, 403, { error: "invalid twilio signature" });
    }
    const msg = parseTwilio(fields);
    if (!msg.toAddr) return sendJson(res, 400, { error: "missing To number" });
    const tenant = provisioner.store.getByPhoneNumber(msg.toAddr);
    if (!tenant) return sendJson(res, 404, { error: "no tenant for that number" });
    provisioner.store.queueInbound(tenant.id, msg);
    provisioner.store.audit("sms_received", tenant.id, { from: msg.fromAddr });
    return sendJson(res, 200, { queued: true, tenantId: tenant.id });
  }

  // /tenants/:id ...
  if (parts[0] === "tenants" && parts[1]) {
    const tenantId = parts[1];
    const sub = parts.slice(2).join("/");

    if (req.method === "GET" && !sub) {
      authorize(req, "admin");
      const t = provisioner.get(tenantId);
      return t ? sendJson(res, 200, t) : sendJson(res, 404, { error: "not found" });
    }

    // GET /tenants/:id/inbox  — tenant polls for unread emails
    if (req.method === "GET" && sub === "inbox") {
      authorize(req, "tenant", tenantId);
      const limit = Math.min(Number(url.searchParams.get("limit") || 20), 100);
      return sendJson(res, 200, provisioner.store.getInbox(tenantId, limit));
    }

    // DELETE /tenants/:id/inbox/:msgId  — acknowledge a processed message
    if (req.method === "DELETE" && parts[2] === "inbox" && parts[3]) {
      authorize(req, "tenant", tenantId);
      provisioner.store.ackInbound(parts[3]);
      return sendJson(res, 200, { acked: true });
    }

    // GET /tenants/:id/sms-inbox  — tenant polls for unread SMS
    if (req.method === "GET" && sub === "sms-inbox") {
      authorize(req, "tenant", tenantId);
      const limit = Math.min(Number(url.searchParams.get("limit") || 20), 100);
      return sendJson(res, 200, provisioner.store.getInbox(tenantId, limit, "sms"));
    }

    // DELETE /tenants/:id/sms-inbox/:msgId  — acknowledge a processed SMS
    if (req.method === "DELETE" && parts[2] === "sms-inbox" && parts[3]) {
      authorize(req, "tenant", tenantId);
      provisioner.store.ackInbound(parts[3]);
      return sendJson(res, 200, { acked: true });
    }

    // GET /tenants/:id/vm/status
    if (req.method === "GET" && sub === "vm/status") {
      authorize(req, "tenant", tenantId);
      return sendJson(res, 200, await vmStatus(tenantId));
    }

    authorize(req, "tenant", tenantId);
    const tenant = provisioner.require(tenantId);
    requireCapability(tenant, sub);
    const body = await readJson(req);

    if (req.method === "POST" && sub === "sms") {
      str(body, "to", { max: 32 });
      str(body, "text", { max: 1600 });
      provisioner.store.audit("sms", tenantId, { to: body.to });
      return sendJson(res, 200, await sendSms(tenant, body.to, body.text));
    }
    if (req.method === "POST" && sub === "email") {
      str(body, "to", { max: 254 });
      str(body, "subject", { max: 256 });
      str(body, "body", { max: 100_000 });
      provisioner.store.audit("email", tenantId, { to: body.to });
      return sendJson(res, 200, await sendEmail(tenant, body.to, body.subject, body.body));
    }
    if (req.method === "POST" && sub === "browser") {
      str(body, "action", { max: 32 });
      provisioner.store.audit("browser", tenantId, { action: body.action });
      return sendJson(res, 200, await browserAction(tenantId, body.action, body.params));
    }
    if (req.method === "POST" && sub === "vm/exec") {
      str(body, "command", { max: 10_000 });
      provisioner.store.audit("vm_exec", tenantId, {});
      return sendJson(res, 200, await vmExec(tenant, body.command));
    }
  }

  return sendJson(res, 404, { error: "no such route", path: url.pathname });
}

export function createInfraServer() {
  const server = createServer(instrument("aether-infra", (req, res) => {
    securityHeaders(res);
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
  if (!ADMIN_TOKEN) console.warn("[aether-infra] INFRA_ADMIN_TOKEN unset — running OPEN (dev only)");
  const port = Number(process.env.INFRA_PORT || 8090);
  const server = createInfraServer();
  server.listen(port, () => console.log(`[aether-infra] listening on :${port}`));
  const shutdown = async () => {
    console.log("[aether-infra] shutting down...");
    server.close();
    await closeAllSessions();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

export { provisioner };
