// "Bring Your Own Brain" config. The customer chooses where the LLM runs; the
// platform stores their choice and renders it into the Hermes env that Aether
// Core will use. Private credentials never leave the tenant's own deployment —
// we persist only what is needed to point Hermes at the right endpoint.
const PROVIDERS = {
  anthropic: { base: "https://api.anthropic.com/v1", needsKey: true, label: "Claude (Anthropic)" },
  openai: { base: "https://api.openai.com/v1", needsKey: true, label: "GPT-4 (OpenAI)" },
  ollama: { base: "http://localhost:11434/v1", needsKey: false, label: "Local (Ollama)" },
  custom: { base: null, needsKey: false, label: "Custom OpenAI-compatible endpoint" },
};

export function listProviders() {
  return Object.entries(PROVIDERS).map(([id, p]) => ({ id, label: p.label, needsKey: p.needsKey }));
}

// Validate + normalize a BYOB submission. Returns the config to persist (with
// the key redacted in any echoed response by the caller).
export function buildByobConfig({ provider, apiKey, model, baseUrl }) {
  const meta = PROVIDERS[provider];
  if (!meta) {
    const err = new Error(`unknown BYOB provider '${provider}'`);
    err.statusCode = 400;
    throw err;
  }
  const base = baseUrl || meta.base;
  if (!base) {
    const err = new Error("baseUrl is required for a custom provider");
    err.statusCode = 400;
    throw err;
  }
  if (meta.needsKey && !apiKey) {
    const err = new Error(`provider '${provider}' requires an API key`);
    err.statusCode = 400;
    throw err;
  }
  return {
    provider,
    base,
    model: model || (provider === "ollama" ? "llama3" : "default"),
    apiKey: apiKey || "",
    configuredAt: Date.now(),
  };
}

// Render the BYOB config into the env vars Hermes / Aether Core consume.
export function byobToHermesEnv(byob) {
  return {
    HERMES_API_BASE: byob.base,
    HERMES_API_KEY: byob.apiKey,
    HERMES_MODEL: byob.model,
  };
}

export function redact(byob) {
  if (!byob) return null;
  // Strip both the plaintext key and the ciphertext from any response.
  const { apiKey, apiKeyEnc, ...rest } = byob;
  return { ...rest, apiKey: apiKeyEnc || apiKey ? "••••••••" : "" };
}
