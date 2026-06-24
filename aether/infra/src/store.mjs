// SQLite/PostgreSQL-backed tenant registry (replaces the old JSON file store). Holds the
// provisioned body identity per tenant plus a hashed access token. The token's
// plaintext is shown only once at provision time; we persist only its SHA-256 so
// a DB leak does not expose live tenant credentials.
import { createHash, timingSafeEqual } from "node:crypto";

import { fromJson, migrate, connectDb, toJson } from "../../shared/db.mjs";

const MIGRATIONS = [
  {
    id: "001-tenants",
    sql: `CREATE TABLE tenants (
      id TEXT PRIMARY KEY,
      tier TEXT NOT NULL DEFAULT 'starter',
      phone TEXT, email TEXT, vm TEXT, browser TEXT,
      token_hash TEXT,
      provisioned INTEGER NOT NULL DEFAULT 0,
      provisioned_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );`,
  },
  {
    id: "002-audit",
    sql: `CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      event TEXT NOT NULL,
      tenant_id TEXT,
      meta TEXT
    );`,
  },
  {
    id: "003-capabilities",
    sql: `ALTER TABLE tenants ADD COLUMN capabilities TEXT;`,
  },
  {
    id: "004-persona",
    sql: `ALTER TABLE tenants ADD COLUMN persona TEXT;
          ALTER TABLE tenants ADD COLUMN email_address TEXT;
          CREATE INDEX idx_tenants_email_address ON tenants(email_address);`,
  },
  {
    id: "005-inbound-email",
    sql: `CREATE TABLE inbound_messages (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      from_addr TEXT NOT NULL,
      from_name TEXT,
      to_addr TEXT NOT NULL,
      subject TEXT,
      body TEXT NOT NULL DEFAULT '',
      received_at INTEGER NOT NULL,
      processed_at INTEGER
    );
    CREATE INDEX idx_inbound_tenant ON inbound_messages(tenant_id, processed_at);`,
  },
  {
    id: "006-phone-number-index",
    sql: `ALTER TABLE tenants ADD COLUMN phone_number TEXT;
          CREATE INDEX idx_tenants_phone_number ON tenants(phone_number);`,
  },
  {
    id: "007-inbound-channel",
    sql: `ALTER TABLE inbound_messages ADD COLUMN channel TEXT NOT NULL DEFAULT 'email';`,
  },
];

const COLS = ["phone", "email", "vm", "browser", "capabilities", "persona"]; // JSON columns

function hashToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

function rowToTenant(row) {
  if (!row) return null;
  const t = { id: row.id, tier: row.tier, provisioned: !!row.provisioned };
  for (const c of COLS) t[c] = fromJson(row[c]);
  t.emailAddress = row.email_address || null;
  t.phoneNumber  = row.phone_number  || null;
  t.provisionedAt = Number(row.provisioned_at);
  t.hasToken = !!row.token_hash;
  return t;
}

export class TenantStore {
  constructor(file = process.env.INFRA_DB_FILE || "./data/infra.db") {
    this.file = file;
    this.dbPromise = null;
  }

  async _getDb() {
    if (!this.dbPromise) {
      this.dbPromise = (async () => {
        const dbUrl = process.env.INFRA_DATABASE_URL || process.env.DATABASE_URL || this.file;
        const db = await connectDb(dbUrl);
        await migrate(db, MIGRATIONS);
        return db;
      })();
    }
    return this.dbPromise;
  }

  async get(id) {
    const db = await this._getDb();
    return rowToTenant(await db.get("SELECT * FROM tenants WHERE id = ?", [id]));
  }

  // upsert with optional token. Returns the tenant (without token plaintext).
  async upsert(id, patch = {}, { tokenHash } = {}) {
    const now = Date.now();
    const db = await this._getDb();
    const existing = await db.get("SELECT id FROM tenants WHERE id = ?", [id]);
    if (!existing) {
      await db.run(
        `INSERT INTO tenants (id, tier, phone, email, vm, browser, capabilities, persona,
           email_address, token_hash, provisioned, provisioned_at, created_at, updated_at)
         VALUES (@id,@tier,@phone,@email,@vm,@browser,@capabilities,@persona,
           @email_address,@token_hash,@provisioned,@provisioned_at,@created,@updated)`,
        {
          id,
          tier: patch.tier || "starter",
          phone: toJson(patch.phone),
          email: toJson(patch.email),
          vm: toJson(patch.vm),
          browser: toJson(patch.browser),
          capabilities: toJson(patch.capabilities),
          persona: toJson(patch.persona),
          email_address: patch.persona?.email ? String(patch.persona.email).toLowerCase() : null,
          token_hash: tokenHash || null,
          provisioned: patch.provisioned ? 1 : 0,
          provisioned_at: patch.provisionedAt || (patch.provisioned ? now : null),
          created: now,
          updated: now,
        }
      );
      return this.get(id);
    }
    // partial update of provided fields only
    const sets = ["updated_at = @updated"];
    const params = { id, updated: now };
    for (const c of [...COLS, "tier"]) {
      if (patch[c] !== undefined) {
        sets.push(`${c} = @${c}`);
        params[c] = c === "tier" ? patch[c] : toJson(patch[c]);
      }
    }
    if (patch.emailAddress !== undefined) {
      sets.push("email_address = @email_address");
      params.email_address = patch.emailAddress ? String(patch.emailAddress).toLowerCase() : null;
    }
    if (patch.provisioned !== undefined) {
      sets.push("provisioned = @provisioned", "provisioned_at = @provisioned_at");
      params.provisioned = patch.provisioned ? 1 : 0;
      params.provisioned_at = patch.provisionedAt || now;
    }
    if (tokenHash) {
      sets.push("token_hash = @token_hash");
      params.token_hash = tokenHash;
    }
    await db.run(`UPDATE tenants SET ${sets.join(", ")} WHERE id = @id`, params);
    return this.get(id);
  }

  async setToken(id, plaintext) {
    const db = await this._getDb();
    await db.run("UPDATE tenants SET token_hash = ?, updated_at = ? WHERE id = ?", [hashToken(plaintext), Date.now(), id]);
  }

  // Timing-safe-ish: compares SHA-256 hashes (constant length).
  async verifyToken(id, plaintext) {
    if (!plaintext) return false;
    const db = await this._getDb();
    const row = await db.get("SELECT token_hash FROM tenants WHERE id = ?", [id]);
    if (!row?.token_hash) return false;
    const a = Buffer.from(row.token_hash, "hex");
    const b = Buffer.from(hashToken(plaintext), "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  }

  async list() {
    const db = await this._getDb();
    const rows = await db.all("SELECT * FROM tenants ORDER BY created_at");
    return rows.map(rowToTenant);
  }

  async audit(event, tenantId = null, meta = null) {
    const db = await this._getDb();
    await db.run("INSERT INTO audit_log (ts, event, tenant_id, meta) VALUES (?,?,?,?)", [Date.now(), event, tenantId, toJson(meta)]);
  }

  async recentAudit(limit = 100) {
    const db = await this._getDb();
    const rows = await db.all("SELECT ts, event, tenant_id AS tenantId, meta FROM audit_log ORDER BY id DESC LIMIT ?", [Math.min(limit, 1000)]);
    return rows.map((r) => ({ ...r, meta: fromJson(r.meta) }));
  }

  // Fast routing lookup: find a tenant by their agent email address.
  async getByEmailAddress(address) {
    const db = await this._getDb();
    const row = await db.get("SELECT * FROM tenants WHERE email_address = ?", [String(address).toLowerCase()]);
    return rowToTenant(row);
  }

  async setEmailAddress(id, address) {
    const db = await this._getDb();
    await db.run("UPDATE tenants SET email_address = ?, updated_at = ? WHERE id = ?", [String(address).toLowerCase(), Date.now(), id]);
  }

  async getByPhoneNumber(number) {
    const db = await this._getDb();
    const row = await db.get("SELECT * FROM tenants WHERE phone_number = ?", [String(number).replace(/\s/g, "")]);
    return rowToTenant(row);
  }

  async setPhoneNumber(id, number) {
    const db = await this._getDb();
    await db.run("UPDATE tenants SET phone_number = ?, updated_at = ? WHERE id = ?", [String(number).replace(/\s/g, ""), Date.now(), id]);
  }

  // ---- inbound email queue --------------------------------------------------
  async queueInbound(tenantId, { id, fromAddr, fromName, toAddr, subject, body, channel = "email" }) {
    const db = await this._getDb();
    await db.run(
      `INSERT OR IGNORE INTO inbound_messages
       (id, tenant_id, from_addr, from_name, to_addr, subject, body, channel, received_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [id, tenantId, fromAddr, fromName || null, toAddr, subject || null, body || "", channel, Date.now()]
    );
  }

  async getInbox(tenantId, limit = 20, channel = "email") {
    const db = await this._getDb();
    return await db.all(
      `SELECT id, tenant_id AS tenantId, from_addr AS fromAddr, from_name AS fromName,
              to_addr AS toAddr, subject, body, received_at AS receivedAt
       FROM inbound_messages
       WHERE tenant_id = ? AND channel = ? AND processed_at IS NULL
       ORDER BY received_at
       LIMIT ?`,
      [tenantId, channel, Math.min(limit, 100)]
    );
  }

  async ackInbound(msgId) {
    const db = await this._getDb();
    await db.run("UPDATE inbound_messages SET processed_at = ? WHERE id = ?", [Date.now(), msgId]);
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
