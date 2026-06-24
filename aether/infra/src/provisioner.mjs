// Per-tenant provisioning orchestration. Given a tenant id + tier, lease the
// full "body": phone number, mailbox, isolated VM, and a unique access token
// (returned in plaintext ONCE; only its hash is stored). The browser session is
// created lazily on first use. Idempotent: re-provisioning returns the existing
// identity (and re-issues a token). Pass preferredPhoneNumber to acquire a
// specific Twilio number during initial or re-provisioning.
import { createHash, randomBytes } from "node:crypto";

import { provisionMailbox } from "./email.mjs";
import { TenantStore } from "./store.mjs";
import { provisionNumber } from "./twilio.mjs";
import { provisionVm } from "./vms.mjs";

export class Provisioner {
  constructor(store = new TenantStore()) {
    this.store = store;
  }

  async provision(tenantId, {
    tier = "starter",
    capabilities = null,
    persona = null,
    preferredPhoneNumber = null,
  } = {}) {
    const existing = await this.store.get(tenantId);
    const token = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(token).digest("hex");

    if (existing?.provisioned) {
      // Idempotent re-provision: rotate token + refresh entitlements.
      const patch = { ...(capabilities ? { capabilities } : {}), ...(persona ? { persona } : {}) };
      let t = await this.store.upsert(tenantId, patch, { tokenHash });
      if (persona?.email) await this.store.setEmailAddress(tenantId, persona.email);

      // If caller requested a specific phone number, re-provision it now.
      if (preferredPhoneNumber) {
        const newPhone = await provisionNumber(tenantId, { preferredNumber: preferredPhoneNumber });
        t = await this.store.upsert(tenantId, { phone: newPhone });
        if (newPhone?.number) await this.store.setPhoneNumber(tenantId, newPhone.number);
        await this.store.audit("phone_changed", tenantId, { number: newPhone.number });
      }

      return { ...t, token };
    }

    const [phone, email, vm] = await Promise.all([
      provisionNumber(tenantId, { preferredNumber: preferredPhoneNumber || undefined }),
      provisionMailbox(tenantId, persona),
      provisionVm(tenantId),
    ]);

    const t = await this.store.upsert(
      tenantId,
      {
        tier,
        phone,
        email,
        vm,
        browser: { status: "lazy" },
        capabilities,
        persona,
        provisioned: true,
        provisionedAt: Date.now(),
      },
      { tokenHash }
    );

    // Index the email address for inbound routing.
    if (email?.address) await this.store.setEmailAddress(tenantId, email.address);
    // Index the phone number for inbound SMS routing.
    if (phone?.number) await this.store.setPhoneNumber(tenantId, phone.number);

    await this.store.audit("provisioned", tenantId, { tier, simulated: !!phone.simulated });
    return { ...t, token };
  }

  async get(tenantId) {
    return await this.store.get(tenantId);
  }

  async verifyToken(tenantId, token) {
    return await this.store.verifyToken(tenantId, token);
  }

  async require(tenantId) {
    const t = await this.store.get(tenantId);
    if (!t || !t.provisioned) {
      const err = new Error(`tenant '${tenantId}' is not provisioned`);
      err.statusCode = 404;
      throw err;
    }
    return t;
  }
}
