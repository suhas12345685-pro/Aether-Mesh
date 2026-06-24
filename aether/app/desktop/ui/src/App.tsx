import { invoke } from "@tauri-apps/api/core";
import { useState, useEffect } from "react";
import Sidebar from "./components/Sidebar";
import Dashboard from "./pages/Dashboard";
import Logs from "./pages/Logs";
import BYOB from "./pages/BYOB";
import Setup from "./pages/Setup";

export type Page = "dashboard" | "logs" | "byob" | "settings";

export interface AppConfig {
  tenant_id: string;
  auto_start: boolean;
  provider: string;
  model: string;
  ollama_url: string | null;
  tier: string;
  channels: string[];
  configured: boolean;
  platform_url: string;
}

export default function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState<Page>("dashboard");

  useEffect(() => {
    invoke<AppConfig>("get_config")
      .then((cfg) => setConfig(cfg))
      .catch(() => setConfig(null))
      .finally(() => setLoading(false));
  }, []);

  const handleSetupComplete = (cfg: AppConfig) => {
    setConfig(cfg);
  };

  if (loading) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100vh",
          flexDirection: "column",
          gap: 16,
        }}
      >
        <div className="spinner" style={{ width: 32, height: 32 }} />
        <p className="text-muted text-sm">Loading Aether…</p>
      </div>
    );
  }

  if (!config?.configured) {
    return <Setup onComplete={handleSetupComplete} />;
  }

  return (
    <div style={{ display: "flex", height: "100vh", overflow: "hidden" }}>
      <Sidebar currentPage={page} onNavigate={setPage} />
      <main
        style={{
          flex: 1,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {page === "dashboard" && <Dashboard config={config} />}
        {page === "logs" && <Logs config={config} />}
        {page === "byob" && (
          <BYOB
            config={config}
            onSaved={(updated) => setConfig(updated)}
          />
        )}
        {page === "settings" && <Dashboard config={config} />}
      </main>
    </div>
  );
}
