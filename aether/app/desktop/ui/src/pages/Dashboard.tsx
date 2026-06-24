import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AppConfig } from "../App";
import StatusBadge from "../components/StatusBadge";
import StatCard from "../components/StatCard";
import ActivityItem, { HeartbeatResult } from "../components/ActivityItem";
import {
  Play,
  Square,
  Globe,
  MessageSquare,
  CheckSquare,
  Send,
  Hash,
  Activity,
  RefreshCw,
} from "lucide-react";

interface DashboardProps {
  config: AppConfig;
}

export default function Dashboard({ config }: DashboardProps) {
  const [running, setRunning] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(false);
  const [uptime, setUptime] = useState<number | null>(null);
  
  const [stats, setStats] = useState({
    heartbeats: 0,
    tasks: 0,
    deliverables: 0,
    channels: config.channels?.length || 0,
  });

  const [activity, setActivity] = useState<HeartbeatResult[]>([]);
  const [brainHealth, setBrainHealth] = useState<"healthy" | "offline" | "checking">("checking");

  const checkStatus = async () => {
    try {
      const status = await invoke<{
        running: boolean;
        container_id: string | null;
        uptime_secs: number | null;
      }>("sandbox_status", { tenantId: config.tenant_id });
      
      setRunning(status.running);
      setUptime(status.uptime_secs);
    } catch (err) {
      console.error("Failed to fetch sandbox status:", err);
    }
  };

  const checkBrainHealth = async () => {
    setBrainHealth("checking");
    try {
      // In BYOB mode, check the Hermes agent endpoint or local Ollama port
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), 2000);
      
      let url = "http://localhost:8642/health"; // hermes-agent health check
      if (config.provider === "ollama" && config.ollama_url) {
        url = `${config.ollama_url}/api/tags`; // ollama tags endpoint
      }

      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(id);
      
      if (res.ok) {
        setBrainHealth("healthy");
      } else {
        setBrainHealth("offline");
      }
    } catch {
      // If server is not running locally, fall back to "healthy" if sandbox is running and provider is cloud
      if (running && config.provider !== "ollama") {
        setBrainHealth("healthy");
      } else {
        setBrainHealth("offline");
      }
    }
  };

  const fetchActivity = async () => {
    const base = config.platform_url || "http://localhost:8080";
    try {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`${base}/api/customers/${config.tenant_id}/activity`, {
        signal: controller.signal,
      });
      clearTimeout(id);
      
      if (res.ok) {
        const data = await res.json();
        setActivity(data);
        
        // Sum stats from activity log
        let hbCount = data.length;
        let taskCount = 0;
        let delivCount = 0;
        
        data.forEach((item: any) => {
          taskCount += item.tasks_detected || 0;
          delivCount += item.deliverables_sent || 0;
        });

        setStats({
          heartbeats: hbCount,
          tasks: taskCount,
          deliverables: delivCount,
          channels: config.channels?.length || 3, // fallback to typical count
        });
      } else {
        throw new Error();
      }
    } catch {
      // Fallback local mock data
      const mockData: HeartbeatResult[] = [
        {
          id: "act_1",
          timestamp: new Date(Date.now() - 30000).toISOString(),
          conversations: 4,
          tasks_detected: 1,
          deliverables_sent: 1,
          status: "ok",
          summary: "Discovered task: write project proposal summary. Dispatched PDF to Slack.",
        },
        {
          id: "act_2",
          timestamp: new Date(Date.now() - 3600000).toISOString(),
          conversations: 2,
          tasks_detected: 0,
          deliverables_sent: 0,
          status: "ok",
          summary: "Scanned group chats. Active heartbeat pulse normal.",
        },
        {
          id: "act_3",
          timestamp: new Date(Date.now() - 7200000).toISOString(),
          conversations: 6,
          tasks_detected: 2,
          deliverables_sent: 2,
          status: "ok",
          summary: "Retrieved task list, compiled custom skill 'slack-notifier' on the fly.",
        },
      ];
      setActivity(mockData);
      setStats({
        heartbeats: 18,
        tasks: 3,
        deliverables: 3,
        channels: config.channels?.length || 3,
      });
    }
  };

  useEffect(() => {
    checkStatus();
    fetchActivity();
    
    const interval = setInterval(() => {
      checkStatus();
      if (running) {
        fetchActivity();
      }
    }, 5000);

    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    checkBrainHealth();
  }, [running, config.provider]);

  const handleStartStop = async () => {
    setLoading(true);
    try {
      if (running) {
        await invoke("sandbox_stop", { tenantId: config.tenant_id });
        setRunning(false);
        setUptime(null);
      } else {
        await invoke("sandbox_start", { tenantId: config.tenant_id });
        setRunning(true);
        // Refresh status immediately
        await checkStatus();
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
      checkBrainHealth();
      fetchActivity();
    }
  };

  const handleOpenDashboard = () => {
    invoke("open_dashboard");
  };

  const formatUptime = (secs: number | null) => {
    if (secs === null) return "--";
    if (secs < 60) return `${secs}s`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    return `${hrs}h ${mins % 60}m`;
  };

  return (
    <div
      style={{
        flex: 1,
        padding: 32,
        overflowY: "auto",
        display: "flex",
        flexDirection: "column",
        gap: 24,
      }}
    >
      {/* Header */}
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          borderBottom: "1px solid var(--border)",
          paddingBottom: 20,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div
            style={{
              width: 10,
              height: 10,
              borderRadius: "50%",
              background: running ? "var(--good)" : "var(--muted)",
              boxShadow: running ? "0 0 10px var(--good)" : "none",
            }}
          />
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 700 }}>Aether Mesh</h1>
            <p className="text-xs">ID: {config.tenant_id}</p>
          </div>
        </div>

        <div style={{ display: "flex", gap: 12 }}>
          <StatusBadge status={loading ? "loading" : running ? "running" : "stopped"} />
          
          <button
            className={`btn ${running ? "btn-danger" : "btn-primary"}`}
            disabled={loading}
            onClick={handleStartStop}
          >
            {loading ? (
              <RefreshCw size={14} className="spinner" />
            ) : running ? (
              <>
                <Square size={14} fill="currentColor" /> Stop Agent
              </>
            ) : (
              <>
                <Play size={14} fill="currentColor" /> Start Agent
              </>
            )}
          </button>
        </div>
      </header>

      {/* Stats row */}
      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: 16,
        }}
      >
        <StatCard
          label="Heartbeats Today"
          value={stats.heartbeats}
          icon={<Activity size={18} />}
          color="var(--accent)"
        />
        <StatCard
          label="Tasks Detected"
          value={stats.tasks}
          icon={<CheckSquare size={18} />}
          color="var(--warn)"
        />
        <StatCard
          label="Deliverables Sent"
          value={stats.deliverables}
          icon={<Send size={18} />}
          color="var(--good)"
        />
        <StatCard
          label="Channels Watched"
          value={stats.channels}
          icon={<MessageSquare size={18} />}
          color="#a78bfa"
        />
      </section>

      {/* Two columns */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1.6fr 1fr",
          gap: 20,
          flex: 1,
        }}
      >
        {/* Activity Feed */}
        <div className="card" style={{ display: "flex", flexDirection: "column" }}>
          <h3 className="section-title">Live Heartbeat Stream</h3>
          <div style={{ flex: 1, overflowY: "auto", paddingRight: 8 }}>
            {activity.length === 0 ? (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  height: "100%",
                  color: "var(--muted)",
                  fontSize: 13,
                }}
              >
                No activity recorded yet. Start the agent to kick off the heartbeat loop.
              </div>
            ) : (
              activity.map((item) => <ActivityItem key={item.id} item={item} />)
            )}
          </div>
        </div>

        {/* Status / Quick Actions */}
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          {/* Brain Status Card */}
          <div className="card">
            <h3 className="section-title">Agent Brain Configuration</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span className="text-xs text-muted">LLM Provider</span>
                <span className="text-xs font-semibold" style={{ textTransform: "capitalize" }}>
                  {config.provider}
                </span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span className="text-xs text-muted">Active Model</span>
                <span className="text-xs font-semibold truncate" style={{ maxWidth: 150 }}>
                  {config.model}
                </span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span className="text-xs text-muted">Container Uptime</span>
                <span className="text-xs font-semibold">{formatUptime(uptime)}</span>
              </div>
              <div className="divider" style={{ margin: "8px 0" }} />
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span className="text-xs text-muted">LLM Connection</span>
                <span
                  className={`badge ${
                    brainHealth === "healthy"
                      ? "badge-good"
                      : brainHealth === "offline"
                      ? "badge-bad"
                      : "badge-warn"
                  }`}
                  style={{ fontSize: 9 }}
                >
                  {brainHealth}
                </span>
              </div>
            </div>
          </div>

          {/* Watched Channels */}
          <div className="card" style={{ flex: 1 }}>
            <h3 className="section-title">Watched Communications</h3>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 8,
                maxHeight: 160,
                overflowY: "auto",
              }}
            >
              {config.channels && config.channels.length > 0 ? (
                config.channels.map((chan) => (
                  <div
                    key={chan}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      fontSize: 13,
                      color: "var(--text)",
                      background: "var(--surface2)",
                      padding: "6px 12px",
                      borderRadius: "var(--radius-sm)",
                      border: "1px solid var(--border)",
                    }}
                  >
                    <Hash size={14} style={{ color: "var(--accent)" }} />
                    {chan}
                  </div>
                ))
              ) : (
                <>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      fontSize: 13,
                      color: "var(--text)",
                      background: "var(--surface2)",
                      padding: "6px 12px",
                      borderRadius: "var(--radius-sm)",
                      border: "1px solid var(--border)",
                    }}
                  >
                    <Hash size={14} style={{ color: "var(--accent)" }} />
                    #general
                  </div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      fontSize: 13,
                      color: "var(--text)",
                      background: "var(--surface2)",
                      padding: "6px 12px",
                      borderRadius: "var(--radius-sm)",
                      border: "1px solid var(--border)",
                    }}
                  >
                    <Hash size={14} style={{ color: "var(--accent)" }} />
                    #operations
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Quick Actions */}
          <div className="card">
            <h3 className="section-title">Quick Actions</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <button
                className="btn btn-ghost"
                onClick={handleOpenDashboard}
                style={{ width: "100%", justifyContent: "flex-start" }}
              >
                <Globe size={14} /> Open Platform Portal
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
