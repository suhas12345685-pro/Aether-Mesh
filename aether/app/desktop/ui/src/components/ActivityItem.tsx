import { CheckCircle2, AlertCircle, Clock, Package } from "lucide-react";

export interface HeartbeatResult {
  id: string;
  timestamp: string;
  conversations: number;
  tasks_detected: number;
  deliverables_sent: number;
  status: "ok" | "warn" | "error";
  summary: string;
}

interface ActivityItemProps {
  item: HeartbeatResult;
  style?: React.CSSProperties;
}

function StatusIcon({ status }: { status: HeartbeatResult["status"] }) {
  const size = 15;
  if (status === "ok")
    return <CheckCircle2 size={size} style={{ color: "var(--good)", flexShrink: 0 }} />;
  if (status === "warn")
    return <AlertCircle size={size} style={{ color: "var(--warn)", flexShrink: 0 }} />;
  return <AlertCircle size={size} style={{ color: "var(--bad)", flexShrink: 0 }} />;
}

function formatTime(ts: string) {
  try {
    return new Date(ts).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return ts;
  }
}

export default function ActivityItem({ item, style }: ActivityItemProps) {
  return (
    <div
      className="animate-fade-in-up"
      style={{
        display: "flex",
        gap: 12,
        alignItems: "flex-start",
        padding: "10px 0",
        borderBottom: "1px solid var(--border)",
        ...style,
      }}
    >
      <StatusIcon status={item.status} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 3,
          }}
        >
          <span
            className="text-sm font-medium truncate"
            style={{ flex: 1, color: "var(--text)" }}
          >
            {item.summary}
          </span>
          <span className="text-xs text-muted" style={{ flexShrink: 0 }}>
            {formatTime(item.timestamp)}
          </span>
        </div>
        <div
          style={{ display: "flex", gap: 12, alignItems: "center" }}
        >
          <span className="text-xs text-muted">
            <Clock size={10} style={{ display: "inline", marginRight: 3, verticalAlign: "middle" }} />
            {item.conversations} convo{item.conversations !== 1 ? "s" : ""}
          </span>
          <span className="text-xs text-muted">
            <Package size={10} style={{ display: "inline", marginRight: 3, verticalAlign: "middle" }} />
            {item.tasks_detected} tasks
          </span>
          {item.deliverables_sent > 0 && (
            <span className="text-xs" style={{ color: "var(--good)" }}>
              ✓ {item.deliverables_sent} sent
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
