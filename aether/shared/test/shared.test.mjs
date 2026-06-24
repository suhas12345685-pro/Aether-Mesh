// Unit tests for the shared libraries.
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import { readJson } from "../http.mjs";

import {
  decryptSecret, encryptSecret, hashPassword, randomToken, safeEqual,
  signSession, verifyPassword, verifySession, reEncryptSecret, previousMasterKey,
} from "../crypto.mjs";
import { fromJson, migrate, connectDb, toJson, rollback } from "../db.mjs";
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

test("crypto: passwords + sessions", async () => {
  const h = await hashPassword("pw12345");
  assert.ok(await verifyPassword("pw12345", h));
  assert.ok(!(await verifyPassword("nope", h)));
  const tok = signSession({ sub: "c1", role: "admin" }, "s");
  assert.equal(verifySession(tok, "s").sub, "c1");
  assert.equal(verifySession(tok, "other"), null);
  assert.equal(verifySession(tok + "x", "s"), null);
  assert.ok(safeEqual("a", "a") && !safeEqual("a", "b"));
  assert.equal(randomToken(8).length > 0, true);
});

test("crypto: secrets rotation support", () => {
  process.env.AETHER_SECRET_KEY = "a".repeat(64);
  const v1Blob = encryptSecret("rotated-secret");
  assert.ok(v1Blob.startsWith("v1:"));

  // Rotate key: current becomes previous, new key is set
  process.env.AETHER_SECRET_KEY_PREV = process.env.AETHER_SECRET_KEY;
  process.env.AETHER_SECRET_KEY = "b".repeat(64);

  // Clear cached keys to force re-derivation
  // Since cached keys are global, we can decrypt v1Blob using the previous key
  const decrypted = decryptSecret(v1Blob);
  assert.equal(decrypted, "rotated-secret", "decrypted using previous key");

  // Re-encrypt under the new key
  const v2Blob = reEncryptSecret(v1Blob);
  assert.ok(v2Blob.startsWith("v1:"));
  assert.equal(decryptSecret(v2Blob), "rotated-secret", "decrypted using new key");

  // Clean up env vars
  delete process.env.AETHER_SECRET_KEY_PREV;
  process.env.AETHER_SECRET_KEY = "a".repeat(64);
});

test("db: migrations are idempotent", async () => {
  const db = await connectDb(":memory:");
  await migrate(db, [{ id: "1", sql: "CREATE TABLE t(x TEXT)" }]);
  await migrate(db, [{ id: "1", sql: "THIS WOULD FAIL IF RE-RUN" }]); // skipped
  await db.run("INSERT INTO t VALUES(?)", [toJson({ a: 1 })]);
  const row = await db.get("SELECT x FROM t");
  assert.deepEqual(fromJson(row.x), { a: 1 });
  await db.close();
});

test("db: down-migrations rollback", async () => {
  const db = await connectDb(":memory:");
  const migrations = [
    { id: "1", sql: "CREATE TABLE t1(x TEXT);", down: "DROP TABLE t1;" },
    { id: "2", sql: "CREATE TABLE t2(x TEXT);", down: "DROP TABLE t2;" },
    { id: "3", sql: "CREATE TABLE t3(x TEXT);", down: "DROP TABLE t3;" },
  ];
  await migrate(db, migrations);

  // Verify they exist
  await db.run("INSERT INTO t1 VALUES('a')");
  await db.run("INSERT INTO t2 VALUES('b')");
  await db.run("INSERT INTO t3 VALUES('c')");

  // Rollback to migration "1" (should rollback 3 and 2)
  await rollback(db, migrations, "1");

  // Verify t1 still exists, t2 and t3 are dropped
  await db.run("INSERT INTO t1 VALUES('ok')");
  await assert.rejects(db.run("INSERT INTO t2 VALUES('fail')"));
  await assert.rejects(db.run("INSERT INTO t3 VALUES('fail')"));

  await db.close();
});

test("validate: required/email/enum", () => {
  assert.throws(() => str({}, "x"), ValidationError);
  assert.throws(() => email({ email: "bad" }), ValidationError);
  assert.throws(() => oneOf({ t: "z" }, "t", ["a"]), ValidationError);
  assert.equal(str({ x: "ok" }, "x"), "ok");
});

test("http: rate limiter + LRU eviction", async () => {
  const rl = new RateLimiter({ capacity: 2, refillPerSec: 0, maxSize: 5 });
  assert.deepEqual([await rl.check("ip1"), await rl.check("ip1"), await rl.check("ip1")], [true, true, false]);
  
  await rl.check("ip2");
  await rl.check("ip3");
  await rl.check("ip4");
  await rl.check("ip5");
  assert.equal(rl.buckets.size, 5);
  
  // Trigger eviction of 1 entry (oldest "ip1")
  await rl.check("ip6");
  
  assert.equal(rl.buckets.size, 5);
  assert.equal(rl.buckets.has("ip1"), false, "ip1 evicted");
  assert.equal(rl.buckets.has("ip6"), true);
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
