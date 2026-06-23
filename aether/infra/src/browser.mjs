// Sandboxed browser session per tenant via Playwright. Real Chromium when
// INFRA_BROWSER_REAL=true and playwright is installed; otherwise the actions
// are simulated so flows can be wired and demoed without a browser.
const REAL = process.env.INFRA_BROWSER_REAL === "true";
const MAX_SESSIONS = Number(process.env.BROWSER_MAX_SESSIONS || 25);

const sessions = new Map(); // tenantId -> { browser, context, page, lastUsed }

// Evict the least-recently-used real session when over the cap.
async function evictIfNeeded() {
  if (sessions.size < MAX_SESSIONS) return;
  let oldestKey = null;
  let oldest = Infinity;
  for (const [k, s] of sessions) {
    if (!s.simulated && s.lastUsed < oldest) {
      oldest = s.lastUsed;
      oldestKey = k;
    }
  }
  if (oldestKey) await closeSession(oldestKey);
}

async function ensureSession(tenantId) {
  if (sessions.has(tenantId)) {
    const s = sessions.get(tenantId);
    s.lastUsed = Date.now();
    return s;
  }
  if (!REAL) {
    const sim = { simulated: true, page: null, url: "about:blank", lastUsed: Date.now() };
    sessions.set(tenantId, sim);
    return sim;
  }
  await evictIfNeeded();
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext(); // isolated, pre-auth cookies go here
  const page = await context.newPage();
  const sess = { simulated: false, browser, context, page, lastUsed: Date.now() };
  sessions.set(tenantId, sess);
  return sess;
}

// action: goto | click | fill | text | screenshot
export async function browserAction(tenantId, action, params = {}) {
  const sess = await ensureSession(tenantId);
  if (sess.simulated) {
    return { simulated: true, action, params, result: `simulated:${action}` };
  }
  const { page } = sess;
  switch (action) {
    case "goto":
      await page.goto(params.url, { waitUntil: "domcontentloaded" });
      return { url: page.url(), title: await page.title() };
    case "click":
      await page.click(params.selector);
      return { clicked: params.selector };
    case "fill":
      await page.fill(params.selector, params.value);
      return { filled: params.selector };
    case "text":
      return { text: await page.innerText(params.selector || "body") };
    case "screenshot": {
      const buf = await page.screenshot({ fullPage: !!params.fullPage });
      return { screenshot: buf.toString("base64"), encoding: "base64" };
    }
    default:
      throw new Error(`unknown browser action: ${action}`);
  }
}

export async function closeSession(tenantId) {
  const sess = sessions.get(tenantId);
  if (sess && !sess.simulated) await sess.browser.close().catch(() => {});
  sessions.delete(tenantId);
}

// Graceful shutdown: close every live browser.
export async function closeAllSessions() {
  await Promise.all([...sessions.keys()].map((k) => closeSession(k)));
}
