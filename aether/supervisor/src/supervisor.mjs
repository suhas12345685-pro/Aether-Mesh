#!/usr/bin/env node
// Worker supervisor: one Aether Core process per active tenant.
//
// Loop:
//   1. ask the platform (admin token) for active customers
//   2. for each new one, pull its decrypted worker-config and spawn the worker
//   3. for any worker whose tenant is gone/inactive, stop it
//   4. restart crashed workers with exponential backoff
//
// Dependencies (platform fetchers + process spawn) are injected so the logic is
// unit-testable without a live platform or a real Python runtime.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { fetchJson } from "../../shared/retry.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLATFORM_BASE = process.env.PLATFORM_API_BASE || "http://localhost:8080";
const ADMIN_TOKEN = process.env.PLATFORM_ADMIN_TOKEN || "";
const CORE_CWD = process.env.AETHER_CORE_CWD || join(__dirname, "..", "..", "core");
const PYTHON = process.env.PYTHON_BIN || "python";
const RECONCILE_MS = Number(process.env.SUPERVISOR_RECONCILE_MS || 30_000);
const MAX_BACKOFF_MS = 30_000;

function authHeaders() {
  return ADMIN_TOKEN ? { Authorization: `Bearer ${ADMIN_TOKEN}` } : {};
}

// ---- default (real) dependencies ----------------------------------------
const realDeps = {
  listActive: () =>
    fetchJson(`${PLATFORM_BASE}/api/customers`, { headers: authHeaders() }).then((cs) =>
      (cs || []).filter((c) => c.status === "active").map((c) => c.id)
    ),
  getConfig: (id) =>
    fetchJson(`${PLATFORM_BASE}/api/customers/${id}/worker-config`, { headers: authHeaders() }),
  spawn: (env) =>
    spawn(PYTHON, ["-m", "aether_core", "run"], {
      cwd: CORE_CWD,
      env: { ...process.env, ...env },
      stdio: "inherit",
    }),
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  log: (...a) => console.log("[supervisor]", ...a),
};

export class Supervisor {
  constructor(deps = {}) {
    this.deps = { ...realDeps, ...deps };
    this.workers = new Map(); // id -> { proc, restarts, stopping, restartTimer }
    this._reconcileTimer = null;
    this._shutting = false;
  }

  async reconcile() {
    let active;
    try {
      active = new Set(await this.deps.listActive());
    } catch (err) {
      if (err.statusCode === 401 || err.statusCode === 403) {
        this.deps.log("reconcile: platform auth rejected (check PLATFORM_ADMIN_TOKEN):", err.message);
      } else {
        this.deps.log("reconcile: cannot reach platform:", err.message);
      }
      return;
    }
    for (const id of active) if (!this.workers.has(id)) await this.startWorker(id);
    for (const id of [...this.workers.keys()]) if (!active.has(id)) this.stopWorker(id);
    return active;
  }

  async startWorker(id, restarts = 0) {
    let config;
    try {
      config = await this.deps.getConfig(id);
    } catch (err) {
      this.deps.log(`worker ${id}: cannot fetch config:`, err.message);
      return;
    }
    const proc = this.deps.spawn(config.env || {});
    const w = { proc, restarts, stopping: false, restartTimer: null };
    this.workers.set(id, w);
    this.deps.log(`worker ${id}: started (pid ${proc.pid ?? "?"})`);
    proc.on("exit", (code) => this._onExit(id, code));
  }

  _onExit(id, code) {
    const w = this.workers.get(id);
    if (!w || w.stopping || this._shutting) {
      this.workers.delete(id);
      return;
    }
    const nextRestarts = w.restarts + 1;
    const backoff = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** w.restarts);
    this.deps.log(`worker ${id}: exited (code ${code}); restart #${nextRestarts} in ${backoff}ms`);
    w.restartTimer = this.deps.setTimer(async () => {
      if (this._shutting) return;
      this.workers.delete(id);
      await this.startWorker(id, nextRestarts); // carry the count for backoff
    }, backoff);
  }

  stopWorker(id) {
    const w = this.workers.get(id);
    if (!w) return;
    w.stopping = true;
    if (w.restartTimer) clearTimeout(w.restartTimer);
    try { w.proc.kill("SIGTERM"); } catch { /* already dead */ }
    this.workers.delete(id);
    this.deps.log(`worker ${id}: stopped`);
  }

  async run() {
    this.deps.log(`starting; platform=${PLATFORM_BASE} core=${CORE_CWD}`);
    await this.reconcile();
    this._reconcileTimer = this.deps.setTimer(() => this._tick(), RECONCILE_MS);
  }

  async _tick() {
    await this.reconcile();
    if (!this._shutting) this._reconcileTimer = this.deps.setTimer(() => this._tick(), RECONCILE_MS);
  }

  shutdown() {
    this._shutting = true;
    if (this._reconcileTimer) clearTimeout(this._reconcileTimer);
    for (const id of [...this.workers.keys()]) this.stopWorker(id);
    this.deps.log("shut down");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!ADMIN_TOKEN) console.warn("[supervisor] PLATFORM_ADMIN_TOKEN unset — platform calls will be unauthorized");
  const sup = new Supervisor();
  sup.run();

  // Minimal HTTP health server so container orchestrators can probe liveness.
  const HEALTH_PORT = Number(process.env.SUPERVISOR_HEALTH_PORT || 8091);
  const healthServer = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, workers: sup.workers.size }));
      return;
    }
    if (req.method === "GET" && req.url === "/ready") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ready: !sup._shutting, workers: sup.workers.size }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  healthServer.listen(HEALTH_PORT, () =>
    console.log(`[supervisor] health on :${HEALTH_PORT}`)
  );

  const bye = () => { sup.shutdown(); healthServer.close(); process.exit(0); };
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);
}
