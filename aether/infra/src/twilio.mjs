// Phone identity via Twilio. Real provisioning + SMS when INFRA_TWILIO_REAL=true
// and credentials are present; otherwise a deterministic simulation so the rest
// of the stack works end to end without a paid account.
const REAL = process.env.INFRA_TWILIO_REAL === "true";

async function client() {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = process.env;
  if (!REAL || !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) return null;
  try {
    const twilio = (await import("twilio")).default;
    return twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  } catch (err) {
    console.warn("[twilio] SDK unavailable, simulating:", err.message);
    return null;
  }
}

// Search available local numbers by area code. Returns simulated results in dev mode.
export async function searchNumbers({ areaCode = 415, country = "US", limit = 10 } = {}) {
  const c = await client();
  if (!c) {
    const area = String(areaCode);
    return Array.from({ length: Math.min(Number(limit), 5) }, (_, i) => ({
      phoneNumber: `+1${area}5550${String(100 + i * 7).padStart(3, "0")}`,
      friendlyName: `(${area}) 555-0${String(100 + i * 7).padStart(3, "0")}`,
      locality: "Demo City",
      region: "CA",
      simulated: true,
    }));
  }
  const available = await c.availablePhoneNumbers(country).local.list({
    areaCode: Number(areaCode),
    smsEnabled: true,
    limit: Math.min(Number(limit), 20),
  });
  return available.map((n) => ({
    phoneNumber: n.phoneNumber,
    friendlyName: n.friendlyName,
    locality: n.locality,
    region: n.region,
    simulated: false,
  }));
}

// After buying a number, point its SMS inbound webhook at our /inbound/sms endpoint.
async function configureSmsWebhook(sid) {
  const publicUrl = (process.env.INFRA_PUBLIC_URL || "").replace(/\/$/, "");
  if (!publicUrl || !sid || String(sid).startsWith("SIMNUM")) return;
  const c = await client();
  if (!c) return;
  try {
    await c.incomingPhoneNumbers(sid).update({
      smsUrl: `${publicUrl}/inbound/sms`,
      smsMethod: "POST",
    });
  } catch (err) {
    console.warn("[twilio] could not configure SMS webhook:", err.message);
  }
}

// Buy (or simulate) a phone number for a tenant. Pass { preferredNumber } (E.164)
// to acquire a specific number from the available pool instead of auto-selecting.
export async function provisionNumber(tenantId, { preferredNumber } = {}) {
  const c = await client();
  if (!c) {
    const area = process.env.TWILIO_AREA_CODE || "415";
    const fake = `+1${area}${String(Math.floor(1000000 + Math.random() * 8999999))}`;
    return { number: fake, sid: `SIMNUM-${tenantId}`, simulated: true };
  }
  const areaCode = Number(process.env.TWILIO_AREA_CODE || 415);
  let numberToUse = preferredNumber;
  if (!numberToUse) {
    const [available] = await c.availablePhoneNumbers("US").local.list({
      areaCode, limit: 1, smsEnabled: true,
    });
    if (!available) throw new Error("no Twilio numbers available in area code");
    numberToUse = available.phoneNumber;
  }
  const bought = await c.incomingPhoneNumbers.create({ phoneNumber: numberToUse });
  await configureSmsWebhook(bought.sid);
  return { number: bought.phoneNumber, sid: bought.sid, simulated: false };
}

export async function sendSms(tenant, to, text) {
  const c = await client();
  if (!c) {
    return { sid: `SIMSMS-${Date.now()}`, status: "queued", simulated: true, to, text };
  }
  const msg = await c.messages.create({ from: tenant.phone?.number, to, body: text });
  return { sid: msg.sid, status: msg.status, simulated: false, to };
}
