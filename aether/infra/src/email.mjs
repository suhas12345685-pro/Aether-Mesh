// Corporate email identity via SMTP (nodemailer). Real send when
// INFRA_EMAIL_REAL=true and SMTP creds are present; otherwise simulated.
// Inbound provisioning supports AgentMail.to (preferred) or Mailgun routing.
const REAL = process.env.INFRA_EMAIL_REAL === "true";

function agentEmailDomain() {
  return process.env.AGENT_EMAIL_DOMAIN || process.env.EMAIL_DOMAIN || "agent.aethermesh.dev";
}

// Derive the agent's email address from their stored persona or fall back to
// the tenant-id slug (kept for backwards compat with un-persona'd tenants).
function addressFor(tenantId, persona) {
  if (persona?.email) return persona.email;
  return `${tenantId}.agent@${agentEmailDomain()}`;
}

async function transport() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!REAL || !SMTP_HOST) return null;
  try {
    const nodemailer = (await import("nodemailer")).default;
    return nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT || 587),
      secure: Number(SMTP_PORT) === 465,
      auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
    });
  } catch (err) {
    console.warn("[email] nodemailer unavailable, simulating:", err.message);
    return null;
  }
}

// Create a dedicated inbox via AgentMail.to — preferred provider for agent inboxes.
async function createAgentMailInbox(displayName, address) {
  const apiKey = process.env.AGENTMAIL_API_KEY || "";
  if (!apiKey) return null;
  try {
    const [user, domain] = address.split("@");
    const resp = await fetch("https://api.agentmail.to/v0/inboxes", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ username: user, domain, display_name: displayName }),
    });
    if (!resp.ok) {
      console.warn("[email] agentmail inbox creation failed:", resp.status);
      return null;
    }
    return resp.json(); // { inbox_id, email_address, ... }
  } catch (err) {
    console.warn("[email] agentmail unavailable:", err.message);
    return null;
  }
}

// Create a Mailgun inbound route so emails to this address are forwarded to
// our /inbound/email webhook (fallback when AGENTMAIL_API_KEY is not set).
async function createMailgunRoute(address, webhookUrl) {
  const apiKey = process.env.MAILGUN_API_KEY || "";
  if (!apiKey || !webhookUrl) return;
  try {
    const body = new URLSearchParams({
      priority: "0",
      description: `Aether agent inbox: ${address}`,
      expression: `match_recipient('${address}')`,
      "action[]": `forward('${webhookUrl}')`,
    });
    const resp = await fetch("https://api.mailgun.net/v3/routes", {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`api:${apiKey}`).toString("base64")}`,
      },
      body,
    });
    if (!resp.ok) console.warn("[email] mailgun route creation failed:", resp.status);
  } catch (err) {
    console.warn("[email] mailgun unavailable:", err.message);
  }
}

// Provision a mailbox identity. Returns the canonical address + display name
// so the provisioner can index it for inbound routing.
export async function provisionMailbox(tenantId, persona = null) {
  const address = addressFor(tenantId, persona);
  const displayName = persona?.name || tenantId;

  if (REAL) {
    const webhookUrl = (process.env.INFRA_PUBLIC_URL || "").replace(/\/$/, "")
      ? `${process.env.INFRA_PUBLIC_URL.replace(/\/$/, "")}/inbound/email`
      : null;

    // Try AgentMail.to first — creates a real dedicated inbox.
    const amResult = await createAgentMailInbox(displayName, address);
    if (amResult) {
      return {
        address: amResult.email_address || address,
        displayName,
        domain: agentEmailDomain(),
        provider: "agentmail",
      };
    }

    // Fallback: Mailgun routing (MX route only, no dedicated inbox server).
    if (webhookUrl) await createMailgunRoute(address, webhookUrl);
  }

  return {
    address,
    displayName,
    domain: agentEmailDomain(),
    provider: REAL ? "mailgun" : "simulated",
  };
}

export async function sendEmail(tenant, to, subject, body) {
  const persona = tenant.persona;
  const address = addressFor(tenant.id, persona);
  const displayName = persona?.name || tenant.email?.displayName || tenant.id;
  // RFC 5322 From: "Display Name <address>"
  const from = `"${displayName}" <${address}>`;
  const t = await transport();
  if (!t) {
    return { messageId: `SIMMAIL-${Date.now()}`, simulated: true, from, to, subject };
  }
  const info = await t.sendMail({ from, to, subject, text: body });
  return { messageId: info.messageId, simulated: false, from, to, subject };
}
