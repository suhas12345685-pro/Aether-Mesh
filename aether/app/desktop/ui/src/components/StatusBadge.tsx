interface StatusBadgeProps {
  status: "running" | "stopped" | "error" | "loading";
  label?: string;
}

const CONFIG: Record<
  StatusBadgeProps["status"],
  { label: string; cls: string; dot: string }
> = {
  running: { label: "Running",  cls: "badge-good",    dot: "good" },
  stopped: { label: "Stopped",  cls: "badge-neutral",  dot: "" },
  error:   { label: "Error",    cls: "badge-bad",      dot: "bad" },
  loading: { label: "Starting", cls: "badge-warn",     dot: "warn" },
};

export default function StatusBadge({ status, label }: StatusBadgeProps) {
  const { label: defaultLabel, cls, dot } = CONFIG[status];

  return (
    <span className={`badge ${cls}`} style={{ gap: 6 }}>
      {dot && <span className={`pulse-dot ${dot}`} />}
      {label ?? defaultLabel}
    </span>
  );
}
