// Onboarding orchestration — the "take away all deployment friction" flow:
// create account -> subscribe -> provision body (Infrastructure layer) -> store
// secrets ENCRYPTED at rest -> render a secret-free worker spec -> mark active.
import { decryptSecret, encryptSecret, hashPassword } from "../../shared/crypto.mjs";
import { fetchJson } from "../../shared/retry.mjs";
import { byobToHermesEnv } from "./byob.mjs";
import { createSubscription } from "./billing.mjs";
import { getTier } from "./tiers.mjs";

const INFRA_BASE = process.env.INFRA_API_BASE || "http://localhost:8090";
const INFRA_ADMIN_TOKEN = process.env.INFRA_ADMIN_TOKEN || "";
const OPENCLAW_URL = process.env.OPENCLAW_GATEWAY_URL || "http://localhost:18789";
const AGENT_EMAIL_DOMAIN = process.env.AGENT_EMAIL_DOMAIN || "agent.aethermesh.dev";

// Small deterministic name pool — enough variety without a deps.
const FIRST = ["Alex","Jordan","Morgan","Casey","Taylor","Riley","Avery","Blake",
               "Drew","Quinn","Reese","Skyler","Dana","Jamie","Peyton","Rowan"];
const LAST  = ["Chen","Kim","Park","Singh","Patel","Walker","Reed","Brooks",
               "Hayes","Ellis","Morgan","Grant","Shaw","Cole","Lane","West"];

function generatePersona(org, tenantId) {
  // Use a simple hash of the tenantId for repeatable-yet-varied name selection.
  let h = 0;
  for (const c of tenantId) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const first = FIRST[h % FIRST.length];
  const last  = LAST[(h >>> 4) % LAST.length];
  const slug  = `${first.toLowerCase()}.${last.toLowerCase()}`;
  return {
    name: `${first} ${last}`,
    email: `${slug}@${AGENT_EMAIL_DOMAIN}`,
    org,
  };
}

// Search available Twilio phone numbers for the premium number picker portal.
export async function searchAvailableNumbers(areaCode = "415", country = "US", limit = 10) {
  return fetchJson(
    `${INFRA_BASE}/numbers/available?areaCode=${encodeURIComponent(areaCode)}&country=${encodeURIComponent(country)}&limit=${Math.min(Number(limit), 20)}`,
    { headers: INFRA_ADMIN_TOKEN ? { Authorization: `Bearer ${INFRA_ADMIN_TOKEN}` } : {} },
    { retries: 2, backoff: 100 }
  );
}

// Re-provision an existing tenant with a specific chosen phone number.
export async function selectPhoneNumber(tenantId, phoneNumber, tier) {
  return fetchJson(
    `${INFRA_BASE}/provision`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(INFRA_ADMIN_TOKEN ? { Authorization: `Bearer ${INFRA_ADMIN_TOKEN}` } : {}),
      },
      body: JSON.stringify({ tenantId, tier, preferredPhoneNumber: phoneNumber }),
    },
    { retries: 2, backoff: 200 }
  );
}

async function provisionBody(tenantId, tier, persona) {
  // Provisioning is idempotent on the infra side (keyed by tenantId), so it is
  // safe to retry transient failures. Capabilities are the tier's entitlements,
  // enforced by the infra service per call.
  return fetchJson(
    `${INFRA_BASE}/provision`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(INFRA_ADMIN_TOKEN ? { Authorization: `Bearer ${INFRA_ADMIN_TOKEN}` } : {}),
      },
      body: JSON.stringify({ tenantId, tier: tier.id, capabilities: tier.capabilities, persona }),
    },
    { retries: 3, backoff: 150 }
  ); // -> { ...identity, token }
}

// Worker spec stored at rest WITHOUT secrets. The supervisor fetches the full
// env (with secrets decrypted) from the authenticated worker-config endpoint.
export function renderWorkerSpec(customer, tier) {
  const secretKeys = ["HERMES_API_KEY", "INFRA_API_TOKEN"];
  const unlimited = (v) => (v === Infinity || v === "unlimited" ? 0 : v); // 0 = unlimited
  const env = {
    AETHER_TENANT_ID: customer.id,
    AETHER_PROFILE: tier.coreProfile,
    INFRA_API_BASE: INFRA_BASE,
    OPENCLAW_GATEWAY_URL: OPENCLAW_URL,
    // Tier entitlements enforced by the core:
    AETHER_MAX_CHANNELS: String(unlimited(tier.limits.watchedChannels)),
    AETHER_MAX_DELIVERABLES_PER_DAY: String(unlimited(tier.limits.deliverablesPerDay)),
    ...(customer.byob ? { HERMES_API_BASE: customer.byob.base, HERMES_MODEL: customer.byob.model } : {}),
    ...(customer.infra?.persona ? {
      AETHER_AGENT_NAME: customer.infra.persona.name,
      AETHER_AGENT_EMAIL: customer.infra.persona.email,
    } : {}),
    ...(customer.infra?.phone?.number ? {
      AETHER_AGENT_PHONE: customer.infra.phone.number,
    } : {}),
  };
  return { command: "python -m aether_core run", cwd: "aether/core", env, secretKeys };
}

// Decrypt secrets and return the FULL launch env for a supervisor. Authorized
// callers only (enforced at the route).
export function renderWorkerConfig(customer, tier) {
  const spec = renderWorkerSpec(customer, tier);
  const env = { ...spec.env };
  if (customer.tenantTokenEnc) env.INFRA_API_TOKEN = decryptSecret(customer.tenantTokenEnc);
  if (customer.byob?.apiKeyEnc) {
    const byob = { ...customer.byob, apiKey: decryptSecret(customer.byob.apiKeyEnc) };
    Object.assign(env, byobToHermesEnv(byob));
  }
  return { command: spec.command, cwd: spec.cwd, env };
}

export async function onboard(store, { org, email, password, tier: tierId, byob }) {
  const tier = getTier(tierId);
  let customer = await store.create({ org, email, passwordHash: await hashPassword(password), tier: tier.id });

  // Encrypt the BYOB API key before persisting.
  if (byob) {
    const { apiKey, ...rest } = byob;
    customer = await store.update(customer.id, { byob: { ...rest, apiKeyEnc: encryptSecret(apiKey) } });
  }

  const subscription = await createSubscription(customer, tier);
  customer = await store.update(customer.id, { subscription });

  const persona = generatePersona(org, customer.id);

  const steps = { subscription: subscription.status };
  try {
    const result = await provisionBody(customer.id, tier, persona);
    const { token, ...identity } = result;
    customer = await store.update(customer.id, {
      infra: identity,
      tenantTokenEnc: encryptSecret(token),
    });
    steps.provisioned = true;
  } catch (err) {
    steps.provisioned = false;
    steps.provisionError = err.message;
  }

  const workerSpec = renderWorkerSpec(customer, tier);
  customer = await store.update(customer.id, {
    workerSpec,
    status: steps.provisioned ? "active" : "provision_failed",
  });

  return { customer, steps, workerSpec };
}
