// Smoke + security tests for the Infrastructure service (simulated mode, no SDKs
// or paid accounts). Runs with admin-token auth ENFORCED.
import assert from "node:assert/strict";
import { test } from "node:test";

const ADMIN = "test-admin-token";
process.env.INFRA_ADMIN_TOKEN = ADMIN;
process.env.INFRA_DB_FILE = ":memory:";
process.env.LOG_LEVEL = "error"; // quiet request logs during tests

const { createInfraServer } = await import("../src/index.mjs");

function listen(server) {
  return new Promise((r) => server.listen(0, () => r(server.address().port)));
}
const call = async (port, method, path, body, token) => {
  const res = await fetch(`http://localhost:${port}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() };
};

test("infra: auth, provisioning, per-tenant tokens, validation", async () => {
  const server = createInfraServer();
  const port = await listen(server);
  try {
    // health is open
    assert.equal((await call(port, "GET", "/health")).status, 200);

    // provision requires the admin token
    assert.equal((await call(port, "POST", "/provision", { tenantId: "t1" })).status, 401);

    const prov = await call(port, "POST", "/provision", { tenantId: "t1", tier: "growth" }, ADMIN);
    assert.equal(prov.status, 201);
    assert.ok(prov.json.token, "provision returns a one-time tenant token");
    assert.ok(prov.json.phone.number.startsWith("+1"));
    const tenantToken = prov.json.token;

    // capability call works with the tenant token
    const sms = await call(port, "POST", "/tenants/t1/sms", { to: "+15551230000", text: "hi" }, tenantToken);
    assert.equal(sms.status, 200);
    assert.equal(sms.json.simulated, true);

    // ...and with the admin token (ops override)
    assert.equal((await call(port, "POST", "/tenants/t1/vm/exec", { command: "echo hi" }, ADMIN)).status, 200);

    // wrong token => 403
    assert.equal((await call(port, "POST", "/tenants/t1/sms", { to: "x", text: "y" }, "bogus")).status, 403);

    // another tenant's token must not work on t1
    const prov2 = await call(port, "POST", "/provision", { tenantId: "t2" }, ADMIN);
    assert.equal((await call(port, "POST", "/tenants/t1/sms", { to: "x", text: "y" }, prov2.json.token)).status, 403);

    // validation: missing 'text' => 400
    assert.equal((await call(port, "POST", "/tenants/t1/sms", { to: "x" }, tenantToken)).status, 400);

    // unknown tenant => 404 (admin)
    assert.equal((await call(port, "GET", "/tenants/ghost", null, ADMIN)).status, 404);
  } finally {
    server.close();
  }
});

test("infra: persona + email inbound inbox", async () => {
  const server = createInfraServer();
  const port = await listen(server);
  try {
    // Provision a tenant with an explicit persona.
    const persona = { name: "Alex Chen", email: "alex.chen@agent.aethermesh.dev" };
    const prov = await call(port, "POST", "/provision",
      { tenantId: "p1", tier: "growth", persona }, ADMIN);
    assert.equal(prov.status, 201);
    assert.equal(prov.json.persona?.name, "Alex Chen", "persona stored");
    assert.equal(prov.json.email?.displayName, "Alex Chen", "persona reflected in mailbox");
    assert.equal(prov.json.emailAddress, "alex.chen@agent.aethermesh.dev", "email address indexed");

    const tenantToken = prov.json.token;

    // Simulate an inbound webhook posting to the agent's address.
    const payload = new URLSearchParams({
      timestamp: "1234567890",
      token:     "tok",
      signature: "bad-sig",  // no signing key set → accepted in dev mode
      from:      `"Bob <bob@acme.com>"`,
      recipient: "alex.chen@agent.aethermesh.dev",
      subject:   "Need a report",
      "body-plain": "Please prepare a Q2 summary.",
    }).toString();

    const inboundRes = await fetch(`http://localhost:${port}/inbound/email`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: payload,
    });
    assert.equal(inboundRes.status, 200);
    const inboundJson = await inboundRes.json();
    assert.equal(inboundJson.queued, true);
    assert.equal(inboundJson.tenantId, "p1");

    // Tenant polls the inbox.
    const inbox = await call(port, "GET", "/tenants/p1/inbox", null, tenantToken);
    assert.equal(inbox.status, 200);
    assert.equal(inbox.json.length, 1, "one message queued");
    assert.equal(inbox.json[0].subject, "Need a report");
    const msgId = inbox.json[0].id;

    // Ack the message.
    const ack = await call(port, "DELETE", `/tenants/p1/inbox/${msgId}`, null, tenantToken);
    assert.equal(ack.status, 200);
    assert.equal(ack.json.acked, true);

    // Inbox now empty.
    const empty = await call(port, "GET", "/tenants/p1/inbox", null, tenantToken);
    assert.equal(empty.json.length, 0, "message acked");
  } finally {
    server.close();
  }
});

test("infra: SMS inbound inbox", async () => {
  const server = createInfraServer();
  const port = await listen(server);
  try {
    // Provision a tenant — phone number comes back in prov.json.phone.number
    const prov = await call(port, "POST", "/provision",
      { tenantId: "sms1", tier: "starter" }, ADMIN);
    assert.equal(prov.status, 201);
    const phoneNumber = prov.json.phone?.number;
    assert.ok(phoneNumber, "tenant has a phone number");
    const tenantToken = prov.json.token;

    // Simulate a Twilio inbound SMS (no TWILIO_AUTH_TOKEN set → dev mode, accepted)
    const smsPayload = new URLSearchParams({
      MessageSid: "SM1234567890abcdef",
      From: "+19995550001",
      To: phoneNumber,
      Body: "Hey, can you pull together a weekly status update?",
    }).toString();

    const inboundRes = await fetch(`http://localhost:${port}/inbound/sms`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: smsPayload,
    });
    assert.equal(inboundRes.status, 200);
    const inboundJson = await inboundRes.json();
    assert.equal(inboundJson.queued, true);
    assert.equal(inboundJson.tenantId, "sms1");

    // Tenant polls the SMS inbox
    const inbox = await call(port, "GET", "/tenants/sms1/sms-inbox", null, tenantToken);
    assert.equal(inbox.status, 200);
    assert.equal(inbox.json.length, 1, "one SMS queued");
    assert.equal(inbox.json[0].body, "Hey, can you pull together a weekly status update?");
    assert.equal(inbox.json[0].fromAddr, "+19995550001");
    const msgId = inbox.json[0].id;

    // Email inbox must be untouched (separate channel)
    const emailInbox = await call(port, "GET", "/tenants/sms1/inbox", null, tenantToken);
    assert.equal(emailInbox.json.length, 0, "email inbox unaffected by SMS");

    // Ack the SMS
    const ack = await call(port, "DELETE", `/tenants/sms1/sms-inbox/${msgId}`, null, tenantToken);
    assert.equal(ack.status, 200);
    assert.equal(ack.json.acked, true);

    // SMS inbox now empty
    const empty = await call(port, "GET", "/tenants/sms1/sms-inbox", null, tenantToken);
    assert.equal(empty.json.length, 0, "sms message acked");
  } finally {
    server.close();
  }
});

test("infra: tier capability gating", async () => {
  const server = createInfraServer();
  const port = await listen(server);
  try {
    // intern-like tier: phone+email only, no browser/vm
    const prov = await call(port, "POST", "/provision",
      { tenantId: "cap1", tier: "starter", capabilities: { phone: true, email: true, browser: false, vm: false } },
      ADMIN);
    const tok = prov.json.token;
    assert.equal((await call(port, "POST", "/tenants/cap1/sms", { to: "+1555", text: "hi" }, tok)).status, 200);
    assert.equal((await call(port, "POST", "/tenants/cap1/vm/exec", { command: "ls" }, tok)).status, 403);
    assert.equal((await call(port, "POST", "/tenants/cap1/browser", { action: "goto" }, tok)).status, 403);
  } finally {
    server.close();
  }
});
