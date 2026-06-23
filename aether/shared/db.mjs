// Embedded SQL data layer on node:sqlite (built into Node >=22.5, no flag on
// Node 24). Production-shaped: WAL mode, enforced foreign keys, a busy timeout
// for concurrency, and a tiny idempotent migration runner. Swap for Postgres by
// implementing the same repository methods against `pg`.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function openDb(file) {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA synchronous = NORMAL;");
  return db;
}

// Run an ordered list of {id, sql} migrations exactly once, tracked in a table.
export function migrate(db, migrations) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at INTEGER);"
  );
  const seen = new Set(
    db.prepare("SELECT id FROM _migrations").all().map((r) => r.id)
  );
  for (const m of migrations) {
    if (seen.has(m.id)) continue;
    db.exec("BEGIN;");
    try {
      db.exec(m.sql);
      db.prepare("INSERT INTO _migrations (id, applied_at) VALUES (?, ?)").run(
        m.id,
        Date.now()
      );
      db.exec("COMMIT;");
    } catch (err) {
      db.exec("ROLLBACK;");
      throw new Error(`migration '${m.id}' failed: ${err.message}`);
    }
  }
}

// JSON column helpers (node:sqlite stores TEXT; we (de)serialize at the edge).
export const toJson = (v) => (v == null ? null : JSON.stringify(v));
export const fromJson = (v) => (v == null ? null : JSON.parse(v));
