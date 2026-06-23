// Minimal Prometheus metrics (text exposition format). Zero deps. Supports
// Counter and Histogram with labels — enough for HTTP RED metrics. Render the
// whole registry with `metricsText()` from a /metrics route.

function labelKey(labels) {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  return entries.map(([k, v]) => `${k}="${escape(String(v))}"`).join(",");
}
function escape(v) {
  return v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

class Counter {
  constructor(name, help) { this.name = name; this.help = help; this.values = new Map(); this.type = "counter"; }
  inc(labels = {}, n = 1) {
    const k = labelKey(labels);
    this.values.set(k, (this.values.get(k) || 0) + n);
  }
  render() {
    const out = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [k, v] of this.values) out.push(`${this.name}${k ? `{${k}}` : ""} ${v}`);
    return out.join("\n");
  }
}

class Histogram {
  constructor(name, help, buckets = [0.005, 0.025, 0.1, 0.5, 1, 2.5, 10]) {
    this.name = name; this.help = help; this.buckets = buckets;
    this.series = new Map(); // labelKey -> { counts:number[], sum, count }
    this.type = "histogram";
  }
  observe(value, labels = {}) {
    const k = labelKey(labels);
    let s = this.series.get(k);
    if (!s) { s = { counts: new Array(this.buckets.length).fill(0), sum: 0, count: 0 }; this.series.set(k, s); }
    s.sum += value; s.count += 1;
    for (let i = 0; i < this.buckets.length; i++) if (value <= this.buckets[i]) s.counts[i] += 1;
  }
  render() {
    const out = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [k, s] of this.series) {
      const base = k ? `${k},` : "";
      let cumulative = 0;
      for (let i = 0; i < this.buckets.length; i++) {
        cumulative = s.counts[i];
        out.push(`${this.name}_bucket{${base}le="${this.buckets[i]}"} ${cumulative}`);
      }
      out.push(`${this.name}_bucket{${base}le="+Inf"} ${s.count}`);
      out.push(`${this.name}_sum${k ? `{${k}}` : ""} ${s.sum}`);
      out.push(`${this.name}_count${k ? `{${k}}` : ""} ${s.count}`);
    }
    return out.join("\n");
  }
}

class Registry {
  constructor() { this.metrics = []; }
  register(m) { this.metrics.push(m); return m; }
  text() { return this.metrics.map((m) => m.render()).join("\n\n") + "\n"; }
}

export const registry = new Registry();
export const httpRequests = registry.register(
  new Counter("aether_http_requests_total", "HTTP requests")
);
export const httpDuration = registry.register(
  new Histogram("aether_http_request_duration_seconds", "HTTP request duration")
);
export const metricsText = () => registry.text();
export { Counter, Histogram, Registry };
