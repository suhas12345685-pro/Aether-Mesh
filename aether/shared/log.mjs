// Structured logging. Emits one JSON object per line (default) for ingestion by
// Loki/ELK/Datadog, or human-readable lines when LOG_JSON=false. Loggers can
// carry context (service, reqId, tenant) via `child()`.
import { randomUUID } from "node:crypto";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const THRESHOLD = LEVELS[process.env.LOG_LEVEL || "info"] ?? 20;
const JSON_LOGS = process.env.LOG_JSON !== "false";

export function createLogger(service, base = {}) {
  const emit = (level, msg, fields = {}) => {
    if (LEVELS[level] < THRESHOLD) return;
    const rec = { ts: new Date().toISOString(), level, service, msg, ...base, ...fields };
    const line = JSON_LOGS
      ? JSON.stringify(rec)
      : `${rec.ts} ${level.toUpperCase()} ${service} ${msg} ${Object.keys(fields).length ? JSON.stringify(fields) : ""}`;
    (level === "error" ? process.stderr : process.stdout).write(line + "\n");
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    child: (extra) => createLogger(service, { ...base, ...extra }),
  };
}

export const newRequestId = () => randomUUID();
