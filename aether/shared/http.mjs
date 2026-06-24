// HTTP plumbing shared by the services: JSON responses, size-limited body
// parsing, security headers, a token-bucket rate limiter, and request helpers.
// Stdlib only.
import { ValidationError } from "./validate.mjs";
import { getRedisClient } from "./redis.mjs";

const LUA_SCRIPT = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refillPerSec = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local requested = 1

local rate_limit = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(rate_limit[1])
local ts = tonumber(rate_limit[2])

if not tokens then
  tokens = capacity
  ts = now
else
  local elapsed = now - ts
  tokens = math.min(capacity, tokens + elapsed * refillPerSec)
  ts = now
end

if tokens < requested then
  redis.call('HMSET', key, 'tokens', tokens, 'ts', ts)
  return 0
else
  tokens = tokens - requested
  redis.call('HMSET', key, 'tokens', tokens, 'ts', ts)
  local expiry = math.ceil(capacity / refillPerSec)
  if expiry < 3600 then expiry = 3600 end
  redis.call('EXPIRE', key, expiry)
  return 1
end
`;

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

// Number of trusted reverse-proxy hops in front of this service.
// Set TRUSTED_PROXY_COUNT=1 if you have exactly one proxy (e.g. Railway/nginx).
// Leave at 0 (default) to use the socket address directly and ignore XFF.
const _TRUSTED_PROXIES = Math.max(0, Number(process.env.TRUSTED_PROXY_COUNT || 0));

export function clientIp(req) {
  const socketIp = req.socket?.remoteAddress || "unknown";
  if (_TRUSTED_PROXIES === 0) return socketIp;
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff !== "string" || !xff) return socketIp;
  // Take the entry that is TRUSTED_PROXY_COUNT hops from the right.
  // The rightmost entries are appended by trusted proxies; earlier ones can be
  // spoofed by clients. e.g. XFF="client, hop1, hop2", proxies=1 → "hop1".
  const ips = xff.split(",").map((s) => s.trim()).filter(Boolean);
  const idx = ips.length - _TRUSTED_PROXIES;
  return idx >= 0 ? ips[idx] : socketIp;
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
  constructor({ capacity = 60, refillPerSec = 1, maxSize = 10000, name = "default" } = {}) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.maxSize = maxSize;
    this.name = name;
    this.buckets = new Map();
  }

  async check(key) {
    const redisClient = await getRedisClient();
    if (redisClient) {
      const redisKey = `ratelimit:${this.name}:${key}`;
      try {
        const res = await redisClient.eval(LUA_SCRIPT, {
          keys: [redisKey],
          arguments: [
            String(this.capacity),
            String(this.refillPerSec),
            String(Date.now() / 1000),
          ],
        });
        return res === 1;
      } catch (err) {
        console.error("[ratelimit] Redis execution failed, falling back to in-memory:", err);
      }
    }

    const now = Date.now() / 1000;
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxSize) {
        // Evict the oldest 20% of entries (Map maintains insertion order)
        const keysIter = this.buckets.keys();
        const toEvict = Math.floor(this.maxSize * 0.2);
        for (let i = 0; i < toEvict; i++) {
          const nextKey = keysIter.next().value;
          if (nextKey === undefined) break;
          this.buckets.delete(nextKey);
        }
      }
      b = { tokens: this.capacity, ts: now };
    } else {
      b.tokens = Math.min(this.capacity, b.tokens + (now - b.ts) * this.refillPerSec);
      b.ts = now;
      this.buckets.delete(key); // Move to the end of insertion order (LRU)
    }
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
