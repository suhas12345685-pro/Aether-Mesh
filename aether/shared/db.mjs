// Embedded SQL data layer on node:sqlite (built into Node >=22.5, no flag on
// Node 24). Production-shaped: WAL mode, enforced foreign keys, a busy timeout
// for concurrency, and a tiny idempotent migration runner. Swap for Postgres by
// implementing the same repository methods against `pg`.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Translate SQLite queries to PostgreSQL queries
export function sqlToPostgres(sql) {
  let cleanSql = sql;
  
  // 1. AUTOINCREMENT
  cleanSql = cleanSql.replace(/INTEGER PRIMARY KEY AUTOINCREMENT/gi, "SERIAL PRIMARY KEY");

  // 2. INSERT OR IGNORE
  cleanSql = cleanSql.replace(/INSERT\s+OR\s+IGNORE\s+INTO\s+(\w+)/gi, (match, tableName) => {
    return `INSERT INTO ${tableName}`;
  });
  
  if (sql.match(/INSERT\s+OR\s+IGNORE\s+INTO\s+webhook_events/i)) {
    cleanSql += " ON CONFLICT (id) DO NOTHING";
  } else if (sql.match(/INSERT\s+OR\s+IGNORE\s+INTO\s+revoked_sessions/i)) {
    cleanSql += " ON CONFLICT (jti) DO NOTHING";
  } else if (sql.match(/INSERT\s+OR\s+IGNORE\s+INTO\s+inbound_messages/i)) {
    cleanSql += " ON CONFLICT (id) DO NOTHING";
  } else if (sql.match(/INSERT\s+OR\s+REPLACE\s+INTO\s+customer_revocations/i)) {
    cleanSql = cleanSql.replace(/INSERT\s+OR\s+REPLACE\s+INTO\s+customer_revocations/i, "INSERT INTO customer_revocations");
    cleanSql += " ON CONFLICT (customer_id) DO UPDATE SET revoked_at = EXCLUDED.revoked_at";
  }
  
  return cleanSql;
}

export function translateQuery(sql, params, isPg) {
  if (!isPg) {
    // For SQLite, if params is not an array, convert it to an array
    const values = Array.isArray(params) ? params : (params !== undefined ? [params] : []);
    return { sql, values };
  }

  // Postgres translation
  const pgSql = sqlToPostgres(sql);

  if (params === undefined || params === null) {
    return { sql: pgSql, values: [] };
  }

  if (Array.isArray(params)) {
    let index = 1;
    const newSql = pgSql.replace(/\?/g, () => `$${index++}`);
    return { sql: newSql, values: params };
  }

  // Named parameters object (e.g. @org, @id)
  const values = [];
  const map = {};
  let index = 1;
  const newSql = pgSql.replace(/@(\w+)\b/g, (match, name) => {
    if (map[name] === undefined) {
      map[name] = index++;
      values.push(params[name]);
    }
    return `$${map[name]}`;
  });

  return { sql: newSql, values };
}

class SqliteDbWrapper {
  constructor(file) {
    this.isPg = false;
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
  }

  async exec(sql) {
    this.db.exec(sql);
  }

  async run(sql, params) {
    const { sql: finalSql, values } = translateQuery(sql, params, false);
    const stmt = this.db.prepare(finalSql);
    const result = stmt.run(...values);
    return { changes: result.changes };
  }

  async get(sql, params) {
    const { sql: finalSql, values } = translateQuery(sql, params, false);
    const stmt = this.db.prepare(finalSql);
    return stmt.get(...values);
  }

  async all(sql, params) {
    const { sql: finalSql, values } = translateQuery(sql, params, false);
    const stmt = this.db.prepare(finalSql);
    return stmt.all(...values);
  }

  async close() {
    this.db.close();
  }
}

class PgDbWrapper {
  constructor(pool) {
    this.isPg = true;
    this.pool = pool;
  }

  async exec(sql) {
    const pgSql = sqlToPostgres(sql);
    await this.pool.query(pgSql);
  }

  async run(sql, params) {
    const { sql: finalSql, values } = translateQuery(sql, params, true);
    const res = await this.pool.query(finalSql, values);
    return { changes: res.rowCount };
  }

  async get(sql, params) {
    const { sql: finalSql, values } = translateQuery(sql, params, true);
    const res = await this.pool.query(finalSql, values);
    return res.rows[0] || null;
  }

  async all(sql, params) {
    const { sql: finalSql, values } = translateQuery(sql, params, true);
    const res = await this.pool.query(finalSql, values);
    return res.rows;
  }

  async close() {
    await this.pool.end();
  }
}

export async function connectDb(connectionStringOrFile) {
  if (
    typeof connectionStringOrFile === "string" &&
    (connectionStringOrFile.startsWith("postgres://") ||
     connectionStringOrFile.startsWith("postgresql://"))
  ) {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({ connectionString: connectionStringOrFile });
    return new PgDbWrapper(pool);
  }

  return new SqliteDbWrapper(connectionStringOrFile);
}

// Keep backward compatibility for openDb, but make it use the Sqlite wrapper
export function openDb(file) {
  return new SqliteDbWrapper(file);
}

// Run an ordered list of {id, sql} migrations exactly once, tracked in a table.
export async function migrate(db, migrations) {
  await db.exec(
    "CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at INTEGER);"
  );
  const rows = await db.all("SELECT id FROM _migrations");
  const seen = new Set(rows.map((r) => r.id));
  
  for (const m of migrations) {
    if (seen.has(m.id)) continue;
    await db.exec("BEGIN;");
    try {
      await db.exec(m.sql);
      await db.run("INSERT INTO _migrations (id, applied_at) VALUES (?, ?)", [
        m.id,
        Date.now(),
      ]);
      await db.exec("COMMIT;");
    } catch (err) {
      await db.exec("ROLLBACK;");
      throw new Error(`migration '${m.id}' failed: ${err.message}`);
    }
  }
}

// Roll back applied migrations that come after targetId in reverse order.
export async function rollback(db, migrations, targetId = null) {
  await db.exec(
    "CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at INTEGER);"
  );
  const rows = await db.all("SELECT id FROM _migrations");
  const applied = rows.map((r) => r.id);
  const appliedSet = new Set(applied);

  let targetIndex = -1;
  if (targetId !== null) {
    targetIndex = migrations.findIndex((m) => m.id === targetId);
    if (targetIndex === -1) {
      throw new Error(`target migration '${targetId}' not found in migrations list`);
    }
  }

  const toRollback = [];
  for (let i = migrations.length - 1; i >= 0; i--) {
    const m = migrations[i];
    if (i > targetIndex && appliedSet.has(m.id)) {
      toRollback.push(m);
    }
  }

  for (const m of toRollback) {
    if (!m.down) {
      throw new Error(`migration '${m.id}' has no rollback SQL`);
    }
    await db.exec("BEGIN;");
    try {
      await db.exec(m.down);
      await db.run("DELETE FROM _migrations WHERE id = ?", [m.id]);
      await db.exec("COMMIT;");
    } catch (err) {
      await db.exec("ROLLBACK;");
      throw new Error(`rollback of migration '${m.id}' failed: ${err.message}`);
    }
  }
}

// JSON column helpers (node:sqlite stores TEXT; we (de)serialize at the edge).
export const toJson = (v) => (v == null ? null : JSON.stringify(v));
export const fromJson = (v) => (v == null ? null : (typeof v === "string" ? JSON.parse(v) : v));
