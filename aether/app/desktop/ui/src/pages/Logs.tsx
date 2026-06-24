import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AppConfig } from "../App";
import {
  ScrollText,
  Copy,
  Trash2,
  Play,
  Pause,
  ArrowDown,
  Search,
} from "lucide-react";

interface LogsProps {
  config: AppConfig;
}

export default function Logs({ config }: LogsProps) {
  const [logs, setLogs] = useState<string[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [levelFilter, setLevelFilter] = useState("all");
  const [paused, setPaused] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);

  const containerRef = useRef<HTMLDivElement>(null);
  const isHoveredRef = useRef(false);

  const fetchLogs = async () => {
    if (paused) return;
    try {
      const fetchedLogs = await invoke<string[]>("get_logs", {
        tenantId: config.tenant_id,
        tail: 200,
      });
      setLogs(fetchedLogs);
    } catch (err) {
      console.error("Failed to fetch logs:", err);
    }
  };

  useEffect(() => {
    fetchLogs();
    const interval = setInterval(fetchLogs, 2000);
    return () => clearInterval(interval);
  }, [paused]);

  // Handle auto-scroll to bottom
  useEffect(() => {
    if (autoScroll && containerRef.current && !paused) {
      // Only scroll if user is not hovering over the logs (pause-on-hover logic)
      if (!isHoveredRef.current) {
        containerRef.current.scrollTop = containerRef.current.scrollHeight;
      }
    }
  }, [logs, autoScroll, paused]);

  const handleCopy = () => {
    const text = logs.join("\n");
    navigator.clipboard.writeText(text);
  };

  const handleClear = () => {
    setLogs([]);
  };

  // Heuristic parser to colorize log levels
  const parseLogLine = (line: string, _index: number) => {
    let type = "debug";
    let message = line;
    let timestamp = "";

    // ISO timestamp match heuristic (e.g. 2026-06-23T...)
    const tsMatch = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z|\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2}(?:\.\d+)?)/);
    if (tsMatch) {
      timestamp = tsMatch[1];
      message = line.substring(timestamp.length).trim();
    }

    const lower = message.toLowerCase();
    if (lower.includes("error") || lower.includes("fail") || lower.includes("exception")) {
      type = "error";
    } else if (lower.includes("warn") || lower.includes("warning")) {
      type = "warn";
    } else if (lower.includes("info") || lower.includes("success") || lower.includes("start")) {
      type = "info";
    }

    return { type, message, timestamp };
  };

  const filteredLogs = logs.filter((line) => {
    const parsed = parseLogLine(line, 0);
    const matchesSearch =
      line.toLowerCase().includes(searchTerm.toLowerCase()) ||
      parsed.message.toLowerCase().includes(searchTerm.toLowerCase());
    
    if (levelFilter === "all") return matchesSearch;
    return matchesSearch && parsed.type === levelFilter;
  });

  return (
    <div
      style={{
        flex: 1,
        padding: 32,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        gap: 20,
      }}
    >
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          borderBottom: "1px solid var(--border)",
          paddingBottom: 20,
          flexShrink: 0,
        }}
      >
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 700, display: "flex", alignItems: "center", gap: 10 }}>
            <ScrollText size={22} style={{ color: "var(--accent)" }} /> System Logs
          </h1>
          <p className="text-xs">
            Viewing live execution logs for Aether Stack container.
          </p>
        </div>

        <div style={{ display: "flex", gap: 10 }}>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => setPaused(!paused)}
            style={{ display: "flex", gap: 6 }}
          >
            {paused ? (
              <>
                <Play size={14} /> Resume Stream
              </>
            ) : (
              <>
                <Pause size={14} /> Pause Stream
              </>
            )}
          </button>
          <button
            className="btn btn-ghost btn-sm"
            onClick={handleCopy}
            disabled={logs.length === 0}
            style={{ display: "flex", gap: 6 }}
          >
            <Copy size={14} /> Copy All
          </button>
          <button
            className="btn btn-ghost btn-sm"
            onClick={handleClear}
            disabled={logs.length === 0}
            style={{ display: "flex", gap: 6 }}
          >
            <Trash2 size={14} /> Clear Screen
          </button>
        </div>
      </header>

      {/* Filter Bar */}
      <div
        style={{
          display: "flex",
          gap: 12,
          flexShrink: 0,
        }}
      >
        <div style={{ position: "relative", flex: 1 }}>
          <input
            type="text"
            className="input"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search log messages..."
            style={{ paddingLeft: 36 }}
          />
          <Search
            size={16}
            style={{
              position: "absolute",
              left: 12,
              top: "50%",
              transform: "translateY(-50%)",
              color: "var(--muted)",
              pointerEvents: "none",
            }}
          />
        </div>

        <select
          className="input"
          value={levelFilter}
          onChange={(e) => setLevelFilter(e.target.value)}
          style={{ width: 140 }}
        >
          <option value="all">All Levels</option>
          <option value="info">Info</option>
          <option value="warn">Warning</option>
          <option value="error">Error</option>
          <option value="debug">Debug</option>
        </select>
      </div>

      {/* Log Console Box */}
      <div
        style={{
          flex: 1,
          background: "#05070c",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          padding: 16,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div
          ref={containerRef}
          onMouseEnter={() => {
            isHoveredRef.current = true;
          }}
          onMouseLeave={() => {
            isHoveredRef.current = false;
          }}
          style={{
            flex: 1,
            overflowY: "auto",
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            paddingRight: 8,
          }}
        >
          {filteredLogs.length === 0 ? (
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
              {searchTerm || levelFilter !== "all"
                ? "No logs match the selected filters."
                : "No log entries to display. Verify the container is running."}
            </div>
          ) : (
            filteredLogs.map((line, idx) => {
              const { type, message, timestamp } = parseLogLine(line, idx);
              return (
                <div key={idx} className="log-line" style={{ display: "flex", alignItems: "flex-start" }}>
                  {timestamp && <span className="log-ts">{timestamp}</span>}
                  <span className={`log-${type}`} style={{ flex: 1 }}>
                    {message}
                  </span>
                </div>
              );
            })
          )}
        </div>

        {/* Scroll helper */}
        {!autoScroll && (
          <button
            className="btn btn-primary btn-sm animate-fade-in"
            onClick={() => {
              setAutoScroll(true);
              if (containerRef.current) {
                containerRef.current.scrollTop = containerRef.current.scrollHeight;
              }
            }}
            style={{
              position: "absolute",
              bottom: 40,
              left: "50%",
              transform: "translateX(-50%)",
              boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
            }}
          >
            <ArrowDown size={12} /> Scroll to Bottom
          </button>
        )}
      </div>
    </div>
  );
}
