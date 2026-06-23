// Request instrumentation wrapper: assigns a correlation id, logs each request
// with method/status/duration, and records RED metrics. Wrap your (req,res)
// handler with `instrument(service, handler)` and pass the result to
// http.createServer.
import { createLogger, newRequestId } from "./log.mjs";
import { httpDuration, httpRequests } from "./metrics.mjs";

export function instrument(service, handler) {
  const log = createLogger(service);
  return (req, res) => {
    const reqId = req.headers["x-request-id"] || newRequestId();
    req.reqId = reqId;
    req.log = log.child({ reqId });
    res.setHeader("x-request-id", reqId);

    const start = process.hrtime.bigint();
    res.on("finish", () => {
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      const labels = { service, method: req.method, status: res.statusCode };
      httpRequests.inc(labels);
      httpDuration.observe(seconds, { service });
      const path = (req.url || "").split("?")[0];
      const level = res.statusCode >= 500 ? "error" : "info";
      req.log[level]("request", { method: req.method, path, status: res.statusCode, ms: Math.round(seconds * 1000) });
    });

    return handler(req, res);
  };
}
