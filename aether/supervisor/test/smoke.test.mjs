// Supervisor logic test with injected platform fetchers + a fake child process.
// No live platform, no real Python runtime.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import { Supervisor } from "../src/supervisor.mjs";

function harness({ activeSequence }) {
  let call = 0;
  const spawned = [];
  const killed = [];
  const timers = [];
  let pid = 1000;

  const deps = {
    listActive: async () => activeSequence[Math.min(call++, activeSequence.length - 1)],
    getConfig: async (id) => ({ command: "python", cwd: ".", env: { AETHER_TENANT_ID: id } }),
    spawn: (env) => {
      const proc = new EventEmitter();
      proc.pid = pid++;
      proc.kill = () => killed.push(env.AETHER_TENANT_ID);
      proc.env = env;
      spawned.push({ id: env.AETHER_TENANT_ID, proc });
      return proc;
    },
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length - 1; },
    now: () => Date.now(),
    log: () => {},
  };
  const flush = async () => { for (const t of timers.splice(0)) await t.fn(); };
  return { deps, spawned, killed, timers, flush };
}

test("supervisor: starts active workers, stops removed ones", async () => {
  const h = harness({ activeSequence: [["c1", "c2"], ["c1"]] });
  const sup = new Supervisor(h.deps);

  await sup.reconcile(); // first: c1, c2 active
  assert.deepEqual(h.spawned.map((s) => s.id).sort(), ["c1", "c2"]);
  assert.equal(sup.workers.size, 2);

  await sup.reconcile(); // second: only c1 -> c2 should be stopped
  assert.deepEqual(h.killed, ["c2"]);
  assert.equal(sup.workers.size, 1);
  assert.ok(sup.workers.has("c1"));
});

test("supervisor: restarts a crashed worker with backoff", async () => {
  const h = harness({ activeSequence: [["c1"]] });
  const sup = new Supervisor(h.deps);

  await sup.reconcile();
  assert.equal(h.spawned.length, 1);
  const first = h.spawned[0].proc;

  first.emit("exit", 1); // crash
  assert.equal(h.timers.length, 1, "a restart timer is scheduled");
  assert.equal(h.timers[0].ms, 1000, "first restart backoff = 1s");

  await h.flush(); // fire the restart
  assert.equal(h.spawned.length, 2, "worker respawned");
  assert.equal(sup.workers.get("c1").restarts, 1, "restart count carried");
});

test("supervisor: shutdown stops all and prevents restart", async () => {
  const h = harness({ activeSequence: [["c1", "c2"]] });
  const sup = new Supervisor(h.deps);
  await sup.reconcile();
  sup.shutdown();
  assert.equal(sup.workers.size, 0);
  assert.deepEqual(h.killed.sort(), ["c1", "c2"]);
});
