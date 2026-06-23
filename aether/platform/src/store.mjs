// SQLite-backed customer/account registry. Holds the commercial record plus the
// login account. Secrets (BYOB API key, tenant infra token) are stored
// ENCRYPTED via the shared crypto module — never plaintext at rest.
import { randomBytes } from "node:crypto";

import { fromJson, migrate, openDb, toJson } from "../../shared/db.mjs";

const cryptoRandom = () => randomBytes(6).toString("hex");

const MIGRATIONS = [
  {
    id: "001-customers",
    sql: `CREATE TABLE customers (
      id TEXT PRIMARY KEY,
      org TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'customer',
      tier TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      byob TEXT,                 -- {provider, base, model, apiKeyEnc}
      infra TEXT,                -- provisioned identity (no secrets)
      tenant_token_enc TEXT,     -- encrypted infra access token
      subscription TEXT,
      worker_spec TEXT,          -- worker spec WITHOUT secrets
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX idx_customers_email ON customers(email);`,
  },
  {
    id: "002-audit",
    sql: `CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      event TEXT NOT NULL,
      customer_id TEXT,
      actor TEXT,
      meta TEXT
    );`,
  },
  {
    id: "003-webhook-idempotency",
    sql: `CREATE TABLE webhook_events (
      id TEXT PRIMARY KEY,
      processed_at INTEGER NOT NULL
    );`,
  },
  {
    id: "004-cloud-deploy",
    sql: `ALTER TABLE customers ADD COLUMN cloudDeploy TEXT;`,
  },
];

const JSON_COLS = ["byob", "infra", "subscription", "worker_spec", "cloudDeploy"];

function rowToCustomer(row) {
  if (!row) return null;
  return {
    id: row.id,
    org: row.org,
    email: row.email,
    role: row.role,
    tier: row.tier,
    status: row.status,
    byob: fromJson(row.byob),
    infra: fromJson(row.infra),
    tenantTokenEnc: row.tenant_token_enc || null,
    subscription: fromJson(row.subscription),
    workerSpec: fromJson(row.worker_spec),
    cloudDeploy: fromJson(row.cloudDeploy),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // password_hash intentionally omitted from the public shape
  };
}

export class CustomerStore {
  constructor(file = process.env.PLATFORM_DB_FILE || "./data/platform.db") {
    this.db = openDb(file);
    migrate(this.db, MIGRATIONS);
  }

  create({ org, email, passwordHash, role = "customer", tier }) {
    const id = `cust_${cryptoRandom()}`;
    const now = Date.now();
    try {
      this.db
        .prepare(
          `INSERT INTO customers (id, org, email, password_hash, role, tier, status, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?)`
        )
        .run(id, org, email.toLowerCase(), passwordHash, role, tier, "pending", now, now);
    } catch (err) {
      if (String(err.message).includes("UNIQUE")) {
        const e = new Error("an account with that email already exists");
        e.statusCode = 409;
        throw e;
      }
      throw err;
    }
    return this.get(id);
  }

  get(id) {
    return rowToCustomer(this.db.prepare("SELECT * FROM customers WHERE id = ?").get(id));
  }

  getByEmail(email) {
    return this.db.prepare("SELECT * FROM customers WHERE email = ?").get(String(email).toLowerCase());
  }

  passwordHash(id) {
    return this.db.prepare("SELECT password_hash FROM customers WHERE id = ?").get(id)?.password_hash;
  }

  update(id, patch) {
    const cur = this.db.prepare("SELECT id FROM customers WHERE id = ?").get(id);
    if (!cur) return null;
    const sets = ["updated_at = @updated"];
    const params = { id, updated: Date.now() };
    const map = {
      org: "org", role: "role", tier: "tier", status: "status",
      tenantTokenEnc: "tenant_token_enc",
    };
    for (const [k, col] of Object.entries(map)) {
      if (patch[k] !== undefined) { sets.push(`${col} = @${k}`); params[k] = patch[k]; }
    }
    for (const col of JSON_COLS) {
      const key = col === "worker_spec" ? "workerSpec" : col;
      if (patch[key] !== undefined) { sets.push(`${col} = @${key}`); params[key] = toJson(patch[key]); }
    }
    this.db.prepare(`UPDATE customers SET ${sets.join(", ")} WHERE id = @id`).run(params);
    return this.get(id);
  }

  list({ limit = 100, offset = 0 } = {}) {
    return this.db
      .prepare("SELECT * FROM customers ORDER BY created_at LIMIT ? OFFSET ?")
      .all(Math.min(limit, 1000), offset)
      .map(rowToCustomer);
  }

  hasWebhookEvent(eventId) {
    return !!this.db.prepare("SELECT 1 FROM webhook_events WHERE id = ?").get(eventId);
  }

  recordWebhookEvent(eventId) {
    const now = Date.now();
    this.db.prepare("INSERT OR IGNORE INTO webhook_events (id, processed_at) VALUES (?,?)").run(eventId, now);
    // Prune events older than 30 days (runs occasionally to keep the table bounded).
    if (Math.random() < 0.05) {
      this.db.prepare("DELETE FROM webhook_events WHERE processed_at < ?").run(now - 30 * 24 * 3600 * 1000);
    }
  }

  audit(event, { customerId = null, actor = null, meta = null } = {}) {
    this.db
      .prepare("INSERT INTO audit_log (ts, event, customer_id, actor, meta) VALUES (?,?,?,?,?)")
      .run(Date.now(), event, customerId, actor, toJson(meta));
  }

  recentAudit(limit = 100) {
    return this.db
      .prepare("SELECT ts, event, customer_id AS customerId, actor, meta FROM audit_log ORDER BY id DESC LIMIT ?")
      .all(Math.min(limit, 1000))
      .map((r) => ({ ...r, meta: fromJson(r.meta) }));
  }

  ping() {
    this.db.prepare("SELECT 1").get();
    return true;
  }

  close() {
    this.db.close();
  }
}
