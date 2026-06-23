interface StatCardProps {
  label: string;
  value: number | string;
  icon: React.ReactNode;
  color?: string;
  style?: React.CSSProperties;
}

export default function StatCard({
  label,
  value,
  icon,
  color = "var(--accent)",
  style,
}: StatCardProps) {
  return (
    <div
      className="card animate-fade-in-up"
      style={{
        flex: 1,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        gap: 12,
        ...style,
      }}
    >
      <div
        style={{
          width: 36,
          height: 36,
          borderRadius: 8,
          background: `${color}18`,
          border: `1px solid ${color}30`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color,
        }}
      >
        {icon}
      </div>
      <div>
        <div
          style={{
            fontSize: 26,
            fontWeight: 700,
            color: "var(--text)",
            lineHeight: 1,
            marginBottom: 4,
          }}
        >
          {typeof value === "number" ? value.toLocaleString() : value}
        </div>
        <div className="text-xs text-muted">{label}</div>
      </div>
    </div>
  );
}
