// SQLite/PostgreSQL-backed customer/account registry. Holds the commercial record plus the
// login account. Secrets (BYOB API key, tenant infra token) are stored
// ENCRYPTED via the shared crypto module — never plaintext at rest.
import { randomBytes } from "node:crypto";

import { fromJson, migrate, connectDb, toJson } from "../../shared/db.mjs";
import { getRedisClient } from "../../shared/redis.mjs";

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
    down: `DROP TABLE IF EXISTS customers;`,
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
    down: `DROP TABLE IF EXISTS audit_log;`,
  },
  {
    id: "003-webhook-idempotency",
    sql: `CREATE TABLE webhook_events (
      id TEXT PRIMARY KEY,
      processed_at INTEGER NOT NULL
    );`,
    down: `DROP TABLE IF EXISTS webhook_events;`,
  },
  {
    id: "004-cloud-deploy",
    sql: `ALTER TABLE customers ADD COLUMN cloudDeploy TEXT;`,
    down: `-- ALTER TABLE DROP COLUMN not supported in older SQLite; recreate if needed`,
  },
  {
    id: "005-session-blocklist",
    sql: `CREATE TABLE revoked_sessions (
      jti TEXT PRIMARY KEY,
      revoked_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE customer_revocations (
      customer_id TEXT PRIMARY KEY,
      revoked_at INTEGER NOT NULL
    );`,
    down: `DROP TABLE IF EXISTS revoked_sessions;
    DROP TABLE IF EXISTS customer_revocations;`,
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
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    // password_hash intentionally omitted from the public shape
  };
}

export class CustomerStore {
  constructor(file = process.env.PLATFORM_DB_FILE || "./data/platform.db") {
    this.file = file;
    this.dbPromise = null;
  }

  async _getDb() {
    if (!this.dbPromise) {
      this.dbPromise = (async () => {
        const dbUrl = process.env.PLATFORM_DATABASE_URL || process.env.DATABASE_URL || this.file;
        const db = await connectDb(dbUrl);
        await migrate(db, MIGRATIONS);
        return db;
      })();
    }
    return this.dbPromise;
  }

  async create({ org, email, passwordHash, role = "customer", tier }) {
    const id = `cust_${cryptoRandom()}`;
    const now = Date.now();
    const db = await this._getDb();
    try {
      await db.run(
        `INSERT INTO customers (id, org, email, password_hash, role, tier, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [id, org, email.toLowerCase(), passwordHash, role, tier, "pending", now, now]
      );
    } catch (err) {
      if (String(err.message).toLowerCase().includes("unique")) {
        const e = new Error("an account with that email already exists");
        e.statusCode = 409;
        throw e;
      }
      throw err;
    }
    return this.get(id);
  }

  async get(id) {
    const db = await this._getDb();
    return rowToCustomer(await db.get("SELECT * FROM customers WHERE id = ?", [id]));
  }

  async getByEmail(email) {
    const db = await this._getDb();
    return await db.get("SELECT * FROM customers WHERE email = ?", [String(email).toLowerCase()]);
  }

  async passwordHash(id) {
    const db = await this._getDb();
    const row = await db.get("SELECT password_hash FROM customers WHERE id = ?", [id]);
    return row?.password_hash;
  }

  async update(id, patch) {
    const db = await this._getDb();
    const cur = await db.get("SELECT id FROM customers WHERE id = ?", [id]);
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
    await db.run(`UPDATE customers SET ${sets.join(", ")} WHERE id = @id`, params);
    return this.get(id);
  }

  async list({ limit = 100, offset = 0 } = {}) {
    const db = await this._getDb();
    const rows = await db.all("SELECT * FROM customers ORDER BY created_at LIMIT ? OFFSET ?", [Math.min(limit, 1000), offset]);
    return rows.map(rowToCustomer);
  }

  async hasWebhookEvent(eventId) {
    const db = await this._getDb();
    const row = await db.get("SELECT 1 FROM webhook_events WHERE id = ?", [eventId]);
    return !!row;
  }

  async recordWebhookEvent(eventId) {
    const now = Date.now();
    const db = await this._getDb();
    await db.run("INSERT OR IGNORE INTO webhook_events (id, processed_at) VALUES (?,?)", [eventId, now]);
    // Prune events older than 30 days (runs occasionally to keep the table bounded).
    if (Math.random() < 0.05) {
      await db.run("DELETE FROM webhook_events WHERE processed_at < ?", [now - 30 * 24 * 3600 * 1000]);
    }
  }

  async audit(event, { customerId = null, actor = null, meta = null } = {}) {
    const db = await this._getDb();
    await db.run("INSERT INTO audit_log (ts, event, customer_id, actor, meta) VALUES (?,?,?,?,?)", [Date.now(), event, customerId, actor, toJson(meta)]);
  }

  async recentAudit(limit = 100) {
    const db = await this._getDb();
    const rows = await db.all("SELECT ts, event, customer_id AS customerId, actor, meta FROM audit_log ORDER BY id DESC LIMIT ?", [Math.min(limit, 1000)]);
    return rows.map((r) => ({ ...r, meta: fromJson(r.meta) }));
  }

  async revokeSession(jti, expiresAt) {
    const redis = await getRedisClient();
    if (redis) {
      const ttl = expiresAt - Math.floor(Date.now() / 1000);
      if (ttl > 0) {
        await redis.set(`revoked_session:${jti}`, "1", { EX: ttl });
      }
      return;
    }
    const db = await this._getDb();
    await db.run('INSERT OR IGNORE INTO revoked_sessions (jti, revoked_at, expires_at) VALUES (?,?,?)', [jti, Date.now(), expiresAt * 1000]);
    // Prune expired entries occasionally
    if (Math.random() < 0.1) {
      await db.run('DELETE FROM revoked_sessions WHERE expires_at < ?', [Date.now()]);
    }
  }

  async isSessionRevoked(jti) {
    if (!jti) return false;
    const redis = await getRedisClient();
    if (redis) {
      const exists = await redis.exists(`revoked_session:${jti}`);
      return exists === 1;
    }
    const db = await this._getDb();
    const row = await db.get('SELECT 1 FROM revoked_sessions WHERE jti = ?', [jti]);
    return !!row;
  }

  async revokeAllSessions(customerId) {
    const redis = await getRedisClient();
    const nowSecs = Math.floor(Date.now() / 1000);
    if (redis) {
      await redis.set(`customer_revocation:${customerId}`, String(nowSecs), { EX: 604800 });
      return;
    }
    const db = await this._getDb();
    await db.run('INSERT OR REPLACE INTO customer_revocations (customer_id, revoked_at) VALUES (?, ?)', [customerId, nowSecs]);
  }

  async isCustomerRevoked(customerId, iat) {
    if (!customerId || !iat) return false;
    const redis = await getRedisClient();
    if (redis) {
      const val = await redis.get(`customer_revocation:${customerId}`);
      return val ? iat <= Number(val) : false;
    }
    const db = await this._getDb();
    const row = await db.get('SELECT revoked_at FROM customer_revocations WHERE customer_id = ?', [customerId]);
    return row ? iat <= Number(row.revoked_at) : false;
  }

  async ping() {
    const db = await this._getDb();
    await db.get("SELECT 1");
    return true;
  }

  async close() {
    if (this.dbPromise) {
      const db = await this.dbPromise;
      await db.close();
    }
  }
}
