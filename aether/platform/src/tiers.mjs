// Subscription tiers. Each tier maps to an Aether Core execution profile and a
// set of body capabilities the Infrastructure layer will provision.
export const TIERS = {
  starter: {
    id: "starter",
    name: "Starter Tier",
    audience: "Freelancers, independent developers, students",
    priceUsdMonthly: 49,
    coreProfile: "lite", // slow heartbeat, single self-correct pass
    capabilities: { phone: true, email: true, browser: false, vm: false, skillCompile: false },
    limits: { watchedChannels: 1, deliverablesPerDay: 25 },
  },
  growth: {
    id: "growth",
    name: "Growth Tier",
    audience: "Fast-growing startups, technology teams, agencies",
    priceUsdMonthly: 299,
    coreProfile: "power", // fast heartbeat, multi-pass verification
    capabilities: { phone: true, email: true, browser: true, vm: true, skillCompile: true },
    limits: { watchedChannels: 10, deliverablesPerDay: 500 },
  },
  enterprise: {
    id: "enterprise",
    name: "Enterprise Suite",
    audience: "Large enterprises, MSMEs, high-security data orgs",
    priceUsdMonthly: null, // custom / contact sales
    coreProfile: "power",
    capabilities: { phone: true, email: true, browser: true, vm: true, skillCompile: true },
    limits: { watchedChannels: Infinity, deliverablesPerDay: Infinity },
    extras: { privateNodes: true, auditLogs: true, configGates: true },
  },
};

export function getTier(id) {
  const tier = TIERS[id];
  if (!tier) {
    const err = new Error(`unknown tier '${id}'`);
    err.statusCode = 400;
    throw err;
  }
  return tier;
}

export function listTiers() {
  return Object.values(TIERS).map((t) => ({
    ...t,
    limits: {
      ...t.limits,
      watchedChannels:
        t.limits.watchedChannels === Infinity ? "unlimited" : t.limits.watchedChannels,
      deliverablesPerDay:
        t.limits.deliverablesPerDay === Infinity ? "unlimited" : t.limits.deliverablesPerDay,
    },
  }));
}
