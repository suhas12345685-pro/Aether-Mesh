import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AppConfig } from "../App";
import {
  Cpu,
  Download,
  Brain,
  Layers,
  Play,
  CheckCircle,
  AlertTriangle,
  RefreshCw,
} from "lucide-react";

interface SetupProps {
  onComplete: (config: AppConfig) => void;
}

export default function Setup({ onComplete }: SetupProps) {
  const [step, setStep] = useState<"docker" | "pull" | "byob" | "tier" | "launching" | "done">("docker");
  const [dockerAvailable, setDockerAvailable] = useState<boolean | null>(null);
  const [pullProgress, setPullProgress] = useState<string>("Initializing pull...");
  const [pullPercent, setPullPercent] = useState<number>(0);
  
  // BYOB config state
  const [provider, setProvider] = useState("anthropic");
  const [model, setModel] = useState("claude-3-5-sonnet-20241022");
  const [apiKey, setApiKey] = useState("");
  const [ollamaUrl, setOllamaUrl] = useState("http://localhost:11434");
  const [tier, setTier] = useState("starter");
  
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (step === "docker") {
      checkDocker();
    }
  }, [step]);

  const checkDocker = async () => {
    setError(null);
    try {
      const available = await invoke<boolean>("is_docker_available");
      setDockerAvailable(available);
      if (available) {
        setStep("pull");
      }
    } catch (err: any) {
      setError(err.toString());
      setDockerAvailable(false);
    }
  };

  const startPull = async () => {
    setError(null);
    try {
      // Set up listeners for pull events before invoking the command
      const unlistenProgress = await listen<string>("pull-progress", (event) => {
        const line = event.payload;
        setPullProgress(line);
        
        // Simple heuristic to extract percentage if present
        if (line.includes("%")) {
          const match = line.match(/(\d+)%/);
          if (match) {
            setPullPercent(parseInt(match[1], 10));
          }
        } else if (line.includes("Download complete") || line.includes("Extracting")) {
          setPullPercent((prev) => Math.min(prev + 5, 95));
        }
      });

      const unlistenComplete = await listen("pull-complete", () => {
        setPullPercent(100);
        setPullProgress("Pull complete!");
        setTimeout(() => {
          unlistenProgress();
          unlistenComplete();
          setStep("byob");
        }, 1000);
      });

      await invoke("pull_image");
    } catch (err: any) {
      setError(err.toString());
    }
  };

  useEffect(() => {
    if (step === "pull" && dockerAvailable) {
      startPull();
    }
  }, [step, dockerAvailable]);

  const handleSaveByob = async () => {
    setError(null);
    try {
      // Save credentials to Vault
      await invoke("vault_save", { key: "provider", value: provider });
      await invoke("vault_save", { key: "model", value: model });
      await invoke("vault_save", { key: "api_key", value: apiKey });
      if (provider === "ollama") {
        await invoke("vault_save", { key: "ollama_url", value: ollamaUrl });
      } else {
        await invoke("vault_delete", { key: "ollama_url" });
      }
      setStep("tier");
    } catch (err: any) {
      setError(err.toString());
    }
  };

  const handleLaunch = async () => {
    setError(null);
    setStep("launching");
    try {
      // Get current config to update it
      const currentConfig = await invoke<AppConfig>("get_config");
      const updatedConfig: AppConfig = {
        ...currentConfig,
        provider,
        model,
        ollama_url: provider === "ollama" ? ollamaUrl : null,
        tier,
        configured: true,
      };

      // Save to config file
      await invoke("save_config", { cfg: updatedConfig });

      // Start the sandbox
      await invoke("sandbox_start", { tenantId: updatedConfig.tenant_id });

      setStep("done");
      setTimeout(() => {
        onComplete(updatedConfig);
      }, 1500);
    } catch (err: any) {
      setError(err.toString());
      setStep("tier");
    }
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100vh",
        width: "100%",
        background: "radial-gradient(circle at center, #0f1322 0%, var(--bg) 100%)",
        padding: 24,
      }}
    >
      <div
        className="card card-glass card-glow animate-fade-in-up"
        style={{
          width: "100%",
          maxWidth: 480,
          padding: 40,
          display: "flex",
          flexDirection: "column",
          gap: 24,
        }}
      >
        {/* Header */}
        <div style={{ textAlign: "center" }}>
          <div
            style={{
              width: 48,
              height: 48,
              borderRadius: 12,
              background: "linear-gradient(135deg, var(--accent), #818cf8)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              margin: "0 auto 16px auto",
              boxShadow: "0 0 24px var(--accent-glow)",
            }}
          >
            {step === "docker" && <Cpu size={24} style={{ color: "#fff" }} />}
            {step === "pull" && <Download size={24} style={{ color: "#fff" }} />}
            {step === "byob" && <Brain size={24} style={{ color: "#fff" }} />}
            {step === "tier" && <Layers size={24} style={{ color: "#fff" }} />}
            {(step === "launching" || step === "done") && (
              <Play size={24} style={{ color: "#fff" }} />
            )}
          </div>
          <h2 style={{ fontSize: 20, marginBottom: 8 }}>
            {step === "docker" && "Docker Check"}
            {step === "pull" && "Downloading Stack"}
            {step === "byob" && "Brain Configuration"}
            {step === "tier" && "Select Plan Tier"}
            {step === "launching" && "Synthesizing Sandbox..."}
            {step === "done" && "Welcome to Aether Mesh"}
          </h2>
          <p className="text-sm">
            {step === "docker" && "Aether requires Docker to run its secure execution sandbox."}
            {step === "pull" && "Downloading the Aether stack image (~500MB)."}
            {step === "byob" && "Configure the LLM connection. Credentials are saved in the OS vault."}
            {step === "tier" && "Choose a workspace plan tier to launch your synthetic employee."}
            {step === "launching" && "Starting background workers, database, and OpenClaw bridge."}
            {step === "done" && "Aether is ready to join your team!"}
          </p>
        </div>

        {error && (
          <div
            className="badge badge-bad"
            style={{
              padding: 12,
              borderRadius: 8,
              fontSize: 12,
              lineHeight: 1.4,
              textTransform: "none",
              display: "flex",
              gap: 8,
              alignItems: "flex-start",
            }}
          >
            <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
            <div>
              <strong>Setup Error:</strong> {error}
            </div>
          </div>
        )}

        {/* Step Contents */}
        {step === "docker" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {dockerAvailable === false && (
              <div
                style={{
                  padding: 16,
                  background: "rgba(245,158,11,0.08)",
                  border: "1px solid rgba(245,158,11,0.2)",
                  borderRadius: "var(--radius)",
                }}
              >
                <p className="text-sm text-warn" style={{ color: "var(--warn)" }}>
                  Docker Desktop was not found. Please install Docker and verify it is running.
                </p>
                <a
                  href="https://www.docker.com/products/docker-desktop/"
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    display: "inline-block",
                    marginTop: 8,
                    fontSize: 13,
                    fontWeight: 500,
                  }}
                >
                  Download Docker Desktop &rarr;
                </a>
              </div>
            )}
            <button
              className="btn btn-primary btn-lg"
              onClick={checkDocker}
              style={{ width: "100%" }}
            >
              <RefreshCw size={16} /> Check Again
            </button>
          </div>
        )}

        {step === "pull" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div className="progress-bar">
              <div
                className="progress-bar-fill"
                style={{ width: `${pullPercent}%` }}
              />
            </div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: 12,
              }}
            >
              <span className="text-muted truncate" style={{ maxWidth: "80%" }}>
                {pullProgress}
              </span>
              <span style={{ color: "var(--accent)", fontWeight: 600 }}>
                {pullPercent}%
              </span>
            </div>
          </div>
        )}

        {step === "byob" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div className="form-group">
              <label className="label">LLM Provider</label>
              <select
                className="input"
                value={provider}
                onChange={(e) => {
                  setProvider(e.target.value);
                  if (e.target.value === "anthropic") setModel("claude-3-5-sonnet-20241022");
                  else if (e.target.value === "openai") setModel("gpt-4o");
                  else if (e.target.value === "ollama") setModel("llama3");
                }}
              >
                <option value="anthropic">Anthropic Claude</option>
                <option value="openai">OpenAI GPT</option>
                <option value="ollama">Ollama (Local)</option>
              </select>
            </div>

            <div className="form-group">
              <label className="label">Model Identifier</label>
              <input
                type="text"
                className="input"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="e.g., claude-3-5-sonnet-20241022"
              />
            </div>

            {provider !== "ollama" ? (
              <div className="form-group">
                <label className="label">API Key</label>
                <input
                  type="password"
                  className="input input-password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="Enter API key"
                />
              </div>
            ) : (
              <div className="form-group">
                <label className="label">Ollama API URL</label>
                <input
                  type="text"
                  className="input"
                  value={ollamaUrl}
                  onChange={(e) => setOllamaUrl(e.target.value)}
                  placeholder="http://localhost:11434"
                />
              </div>
            )}

            <button
              className="btn btn-primary"
              onClick={handleSaveByob}
              disabled={provider !== "ollama" && !apiKey}
              style={{ width: "100%", marginTop: 8 }}
            >
              Continue
            </button>
          </div>
        )}

        {step === "tier" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {[
                { id: "starter", title: "Starter", desc: "1 agent, 3 Slack channels, daily summary" },
                { id: "pro", title: "Professional", desc: "3 agents, unlimited channels, real-time responses" },
                { id: "enterprise", title: "Enterprise", desc: "Custom on-prem deployment, custom integrations" },
              ].map((t) => (
                <div
                  key={t.id}
                  onClick={() => setTier(t.id)}
                  style={{
                    padding: 16,
                    borderRadius: "var(--radius)",
                    background: tier === t.id ? "var(--accent-glow-sm)" : "var(--surface2)",
                    border: tier === t.id ? "1px solid var(--accent)" : "1px solid var(--border)",
                    cursor: "pointer",
                    transition: "all var(--transition)",
                  }}
                >
                  <h4 style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    {t.title}
                    {tier === t.id && (
                      <span className="badge badge-accent" style={{ fontSize: 9 }}>Active</span>
                    )}
                  </h4>
                  <p className="text-xs" style={{ marginTop: 4 }}>{t.desc}</p>
                </div>
              ))}
            </div>

            <button
              className="btn btn-primary btn-lg"
              onClick={handleLaunch}
              style={{ width: "100%" }}
            >
              Launch Synthetic Worker
            </button>
          </div>
        )}

        {step === "launching" && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 16,
              padding: "20px 0",
            }}
          >
            <div className="spinner" style={{ width: 36, height: 36 }} />
            <p className="text-sm">Allocating secure hypervisor environment...</p>
          </div>
        )}

        {step === "done" && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 16,
              padding: "20px 0",
              textAlign: "center",
            }}
          >
            <CheckCircle size={48} style={{ color: "var(--good)" }} />
            <p className="text-sm" style={{ color: "var(--good)" }}>
              All systems online. Running Docker container stack.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
