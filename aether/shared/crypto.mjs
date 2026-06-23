// Cryptographic primitives shared by the Aether services. Stdlib only
// (node:crypto). Production note: the master key (AETHER_SECRET_KEY) should come
// from a real secret manager / KMS — this module gives you envelope-style
// encryption-at-rest, password hashing, and signed session tokens.
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

// ---- master key ----------------------------------------------------------
let _cachedKey = null;

export function masterKey() {
  if (_cachedKey) return _cachedKey;
  const raw = process.env.AETHER_SECRET_KEY || "";
  if (raw.length >= 64 && /^[0-9a-fA-F]+$/.test(raw)) {
    _cachedKey = Buffer.from(raw.slice(0, 64), "hex"); // 32-byte hex key
  } else if (raw) {
    // Derive a 32-byte key from a passphrase (fixed salt: rotate via key, not salt).
    _cachedKey = scryptSync(raw, "aether-mesh-kek-v1", 32);
  } else {
    if (process.env.NODE_ENV === "production") {
      throw new Error("AETHER_SECRET_KEY is required in production");
    }
    // Dev only: ephemeral key (secrets won't survive a restart — that's fine in dev).
    _cachedKey = scryptSync("dev-insecure-key", "aether-mesh-kek-v1", 32);
  }
  return _cachedKey;
}

// ---- secret encryption (AES-256-GCM) -------------------------------------
export function encryptSecret(plaintext, key = masterKey()) {
  if (plaintext == null || plaintext === "") return "";
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

export function decryptSecret(blob, key = masterKey()) {
  if (!blob) return "";
  const [ver, ivB64, tagB64, ctB64] = String(blob).split(":");
  if (ver !== "v1") throw new Error("unrecognized secret format");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

// ---- password hashing (scrypt) -------------------------------------------
export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, saltB64, hashB64] = String(stored).split("$");
    if (scheme !== "scrypt") return false;
    const expected = Buffer.from(hashB64, "base64");
    const actual = scryptSync(String(password), Buffer.from(saltB64, "base64"), expected.length);
    return timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

// ---- tokens + constant-time compare --------------------------------------
export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// ---- signed session tokens (compact, HMAC-SHA256) ------------------------
// token = base64url(json).base64url(hmac).  Stateless; revoke via short TTL.
export function signSession(payload, secret, ttlSeconds = 60 * 60 * 24 * 7) {
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const b = Buffer.from(JSON.stringify(body)).toString("base64url");
  const sig = createHmac("sha256", secret).update(b).digest("base64url");
  return `${b}.${sig}`;
}

export function verifySession(token, secret) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [b, sig] = token.split(".");
  const expected = createHmac("sha256", secret).update(b).digest("base64url");
  if (!safeEqual(sig, expected)) return null;
  try {
    const body = JSON.parse(Buffer.from(b, "base64url").toString("utf8"));
    if (body.exp && body.exp < Math.floor(Date.now() / 1000)) return null;
    return body;
  } catch {
    return null;
  }
}
