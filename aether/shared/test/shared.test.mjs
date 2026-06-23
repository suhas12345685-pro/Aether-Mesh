// Unit tests for the shared libraries.
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import { readJson } from "../http.mjs";

import {
  decryptSecret, encryptSecret, hashPassword, randomToken, safeEqual,
  signSession, verifyPassword, verifySession,
} from "../crypto.mjs";
import { fromJson, migrate, openDb, toJson } from "../db.mjs";
import { RateLimiter } from "../http.mjs";
import { Counter, Histogram, metricsText } from "../metrics.mjs";
import { fetchJson, retry } from "../retry.mjs";
import { ValidationError, email, oneOf, str } from "../validate.mjs";

test("crypto: AES-GCM round-trip + tamper detection", () => {
  const blob = encryptSecret("sk-secret");
  assert.ok(blob.startsWith("v1:"));
  assert.equal(decryptSecret(blob), "sk-secret");
  assert.throws(() => decryptSecret(blob.slice(0, -4) + "0000"));
});

test("crypto: passwords + sessions", () => {
  const h = hashPassword("pw12345");
  assert.ok(verifyPassword("pw12345", h));
  assert.ok(!verifyPassword("nope", h));
  const tok = signSession({ sub: "c1", role: "admin" }, "s");
  assert.equal(verifySession(tok, "s").sub, "c1");
  assert.equal(verifySession(tok, "other"), null);
  assert.equal(verifySession(tok + "x", "s"), null);
  assert.ok(safeEqual("a", "a") && !safeEqual("a", "b"));
  assert.equal(randomToken(8).length > 0, true);
});

test("db: migrations are idempotent", () => {
  const db = openDb(":memory:");
  migrate(db, [{ id: "1", sql: "CREATE TABLE t(x TEXT)" }]);
  migrate(db, [{ id: "1", sql: "THIS WOULD FAIL IF RE-RUN" }]); // skipped
  db.prepare("INSERT INTO t VALUES(?)").run(toJson({ a: 1 }));
  assert.deepEqual(fromJson(db.prepare("SELECT x FROM t").get().x), { a: 1 });
  db.close();
});

test("validate: required/email/enum", () => {
  assert.throws(() => str({}, "x"), ValidationError);
  assert.throws(() => email({ email: "bad" }), ValidationError);
  assert.throws(() => oneOf({ t: "z" }, "t", ["a"]), ValidationError);
  assert.equal(str({ x: "ok" }, "x"), "ok");
});

test("http: rate limiter", () => {
  const rl = new RateLimiter({ capacity: 2, refillPerSec: 0 });
  assert.deepEqual([rl.check("k"), rl.check("k"), rl.check("k")], [true, true, false]);
});

test("retry: succeeds after transient failures", async () => {
  let n = 0;
  const out = await retry(async () => { if (++n < 3) throw new Error("x"); return "ok"; }, { retries: 5, backoff: 1 });
  assert.equal(out, "ok");
  assert.equal(n, 3);
});

test("http: readJson parses small bodies and rejects oversized ones", async () => {
  const ok = new PassThrough();
  const okP = readJson(ok, { limit: 1024 });
  ok.end(JSON.stringify({ a: 1 }));
  assert.deepEqual(await okP, { a: 1 });

  const big = new PassThrough();
  const bigP = readJson(big, { limit: 8 });
  big.write("x".repeat(64));
  await assert.rejects(bigP, (e) => e.statusCode === 413);
});

test("metrics: counter + histogram render Prometheus text", () => {
  const c = new Counter("c_total", "c");
  c.inc({ a: "1" }); c.inc({ a: "1" }); c.inc({ a: "2" });
  assert.match(c.render(), /c_total\{a="1"\} 2/);
  const h = new Histogram("h", "h", [1, 5]);
  h.observe(0.5); h.observe(3);
  const r = h.render();
  assert.match(r, /h_bucket\{le="1"\} 1/);
  assert.match(r, /h_count 2/);
  assert.match(metricsText(), /aether_http_requests_total/);
});
