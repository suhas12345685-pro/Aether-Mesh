// Retry with exponential backoff + jitter, and a fetch-JSON helper that retries
// transient failures (network errors, HTTP 429/5xx). Stdlib/global fetch only.

export async function retry(fn, { retries = 3, backoff = 200, factor = 2, jitter = 0.5, retryable = () => true } = {}) {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !retryable(err)) throw err;
      const delay = backoff * factor ** attempt + Math.random() * backoff * jitter;
      await new Promise((r) => setTimeout(r, delay));
      attempt += 1;
    }
  }
}

// A transient failure is a network error (no HTTP status) or a 429/5xx.
const defaultRetryable = (err) => !err.statusCode || err.statusCode === 429 || err.statusCode >= 500;

export async function fetchJson(url, opts = {}, retryOpts = {}) {
  return retry(async () => {
    let res;
    try {
      res = await fetch(url, opts);
    } catch (cause) {
      throw Object.assign(new Error(`network error calling ${url}: ${cause.message}`), { cause });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw Object.assign(new Error(`HTTP ${res.status} from ${url}: ${text.slice(0, 200)}`), {
        statusCode: res.status,
      });
    }
    return res.status === 204 ? null : res.json();
  }, { retryable: defaultRetryable, ...retryOpts });
}
