// Inbound email webhook handler. Supports Mailgun and SendGrid inbound parse.
//
// Mailgun: routes forward to POST /inbound/email as application/x-www-form-urlencoded.
//   Set MAILGUN_WEBHOOK_SIGNING_KEY to verify the HMAC-SHA256 signature.
//   Mailgun inbound route action: forward("https://your-host/inbound/email")
//
// SendGrid: Inbound Parse webhook → POST /inbound/email as multipart/form-data.
//   No default signing; set SENDGRID_INBOUND_KEY to enable a shared-secret check.
//
// INFRA_INBOUND_REAL=false (default) → webhook accepted and stored, no live MX.
// INFRA_INBOUND_REAL=true           → real production inbound routing active.
import { createHmac, timingSafeEqual } from "node:crypto";
import { randomBytes } from "node:crypto";

const MAILGUN_KEY   = process.env.MAILGUN_WEBHOOK_SIGNING_KEY || "";
const SENDGRID_KEY  = process.env.SENDGRID_INBOUND_KEY || "";
const TWILIO_TOKEN  = process.env.TWILIO_AUTH_TOKEN || "";

// ---- Mailgun signature verification ----------------------------------------
// https://documentation.mailgun.com/en/latest/user_manual.html#webhooks
export function verifyMailgunSignature(timestamp, token, signature) {
  if (!MAILGUN_KEY) return true; // dev: no key → accept all (log a warning in caller)
  const expected = createHmac("sha256", MAILGUN_KEY)
    .update(`${timestamp}${token}`)
    .digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(signature || "", "hex");
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Simple shared-secret check for SendGrid (not cryptographic, but better than nothing).
export function verifySendGridKey(providedKey) {
  if (!SENDGRID_KEY) return true;
  const a = Buffer.from(SENDGRID_KEY);
  const b = Buffer.from(providedKey || "");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ---- Twilio signature verification -----------------------------------------
// https://www.twilio.com/docs/usage/webhooks/webhooks-security#validating-signatures-from-twilio
// url   = the full public URL Twilio called (set TWILIO_WEBHOOK_URL in prod).
// params = all POST fields as a plain object.
// signature = X-Twilio-Signature header value.
export function verifyTwilioSignature(url, params, signature) {
  if (!TWILIO_TOKEN) return true; // dev: no token → accept all
  const str = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const expected = createHmac("sha1", TWILIO_TOKEN).update(str).digest("base64");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature || "", "utf8");
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ---- Payload parsers -------------------------------------------------------
// Mailgun inbound: fields come as form data or JSON depending on route config.
export function parseMailgun(fields) {
  const rawFrom = fields["from"] || fields["From"] || "";
  // RFC 5322 "Name <addr>" → extract name and addr separately.
  const nameMatch = rawFrom.match(/^"?([^"<]+)"?\s*</);
  const addrMatch = rawFrom.match(/<([^>]+)>/) || rawFrom.match(/([^\s]+@[^\s]+)/);
  return {
    id: fields["Message-Id"] || fields["message-id"] || `mg-${randomBytes(8).toString("hex")}`,
    fromAddr: (addrMatch?.[1] || rawFrom).trim().toLowerCase(),
    fromName:  nameMatch?.[1]?.trim() || "",
    toAddr:   (fields.recipient || fields.To || fields.to || "").trim().toLowerCase(),
    subject:   fields.subject || fields.Subject || "(no subject)",
    body:      fields["stripped-text"] || fields["body-plain"] || fields.text || "",
  };
}

// SendGrid Inbound Parse webhook fields.
export function parseSendGrid(fields) {
  let envelope = {};
  try { envelope = JSON.parse(fields.envelope || "{}"); } catch { /* ignore */ }
  const toList = Array.isArray(envelope.to) ? envelope.to : [envelope.to || ""];
  const rawFrom = fields.from || envelope.from || "";
  const addrMatch = rawFrom.match(/<([^>]+)>/) || rawFrom.match(/([^\s]+@[^\s]+)/);
  const nameMatch = rawFrom.match(/^"?([^"<]+)"?\s*</);
  return {
    id: fields["message-id"] || `sg-${randomBytes(8).toString("hex")}`,
    fromAddr: (addrMatch?.[1] || rawFrom).trim().toLowerCase(),
    fromName:  nameMatch?.[1]?.trim() || "",
    toAddr:    toList[0]?.trim().toLowerCase() || "",
    subject:   fields.subject || "(no subject)",
    body:      fields.text || fields.html?.replace(/<[^>]+>/g, "") || "",
  };
}

// Twilio SMS inbound: fields come as application/x-www-form-urlencoded.
// Key fields: MessageSid, From (+E.164), To (+E.164), Body.
export function parseTwilio(fields) {
  return {
    id:       fields.MessageSid || fields.SmsSid || `tw-${randomBytes(8).toString("hex")}`,
    fromAddr: (fields.From || "").trim(),
    fromName: "",
    toAddr:   (fields.To  || "").trim(),
    subject:  null,
    body:     fields.Body || "",
    channel:  "sms",
  };
}

// ---- Dispatcher ------------------------------------------------------------
// Detect provider from request headers and parse accordingly.
export function parseInbound(fields, req) {
  const ct = req.headers["content-type"] || "";
  // If it carries Mailgun timestamp + token → treat as Mailgun.
  if (fields.timestamp && fields.token && fields.signature) return { provider: "mailgun", ...parseMailgun(fields) };
  // Otherwise assume SendGrid.
  return { provider: "sendgrid", ...parseSendGrid(fields) };
}
