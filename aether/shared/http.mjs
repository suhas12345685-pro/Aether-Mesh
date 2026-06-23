// HTTP plumbing shared by the services: JSON responses, size-limited body
// parsing, security headers, a token-bucket rate limiter, and request helpers.
// Stdlib only.
import { ValidationError } from "./validate.mjs";

export function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export function securityHeaders(res, { hsts = false } = {}) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-XSS-Protection", "0");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  if (hsts) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
}

// Read + parse a JSON body, rejecting payloads over `limit` bytes (default 256KB).
export function readJson(req, { limit = 256 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error("payload too large"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new ValidationError("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

// Read and parse an application/x-www-form-urlencoded body (e.g. Mailgun webhooks).
export function readFormBody(req, { limit = 256 * 1024 } = {}) {
  return readRaw(req, { limit }).then((raw) => Object.fromEntries(new URLSearchParams(raw)));
}

// Read the raw request body as a string (needed for webhook signature checks).
export function readRaw(req, { limit = 256 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error("payload too large"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function clientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff) return xff.split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

export function bearer(req) {
  const h = req.headers["authorization"] || "";
  return h.startsWith("Bearer ") ? h.slice(7) : null;
}

export function cookies(req) {
  const raw = req.headers["cookie"] || "";
  const out = {};
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Fixed-window-ish token bucket per key. Single-instance; use Redis for a fleet.
export class RateLimiter {
  constructor({ capacity = 60, refillPerSec = 1 } = {}) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.buckets = new Map();
  }

  check(key) {
    const now = Date.now() / 1000;
    let b = this.buckets.get(key);
    if (!b) b = { tokens: this.capacity, ts: now };
    b.tokens = Math.min(this.capacity, b.tokens + (now - b.ts) * this.refillPerSec);
    b.ts = now;
    if (b.tokens < 1) {
      this.buckets.set(key, b);
      return false;
    }
    b.tokens -= 1;
    this.buckets.set(key, b);
    return true;
  }

  // Periodic cleanup so the map doesn't grow unbounded.
  sweep(maxIdleSec = 3600) {
    const cutoff = Date.now() / 1000 - maxIdleSec;
    for (const [k, b] of this.buckets) if (b.ts < cutoff) this.buckets.delete(k);
  }
}

// Map known error shapes to a status code.
export function statusFor(err) {
  return err?.statusCode || (err?.name === "ValidationError" ? 400 : 500);
}

// Return err.message for 4xx, a generic string for 5xx in production.
export function safeErrorMessage(err, status) {
  if (status < 500) return err.message;
  return process.env.NODE_ENV === "production" ? "internal server error" : err.message;
}
