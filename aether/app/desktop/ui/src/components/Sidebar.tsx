import { Page } from "../App";
import {
  LayoutDashboard,
  ScrollText,
  Brain,
  Settings,
} from "lucide-react";

interface SidebarProps {
  currentPage: Page;
  onNavigate: (page: Page) => void;
}

interface NavItem {
  id: Page;
  label: string;
  icon: React.ReactNode;
}

const NAV_ITEMS: NavItem[] = [
  {
    id: "dashboard",
    label: "Dashboard",
    icon: <LayoutDashboard size={18} />,
  },
  {
    id: "logs",
    label: "Logs",
    icon: <ScrollText size={18} />,
  },
  {
    id: "byob",
    label: "Brain",
    icon: <Brain size={18} />,
  },
  {
    id: "settings",
    label: "Settings",
    icon: <Settings size={18} />,
  },
];

export default function Sidebar({ currentPage, onNavigate }: SidebarProps) {
  return (
    <aside
      style={{
        width: 64,
        background: "var(--surface)",
        borderRight: "1px solid var(--border)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        padding: "16px 0",
        gap: 4,
        flexShrink: 0,
      }}
    >
      {/* Logo */}
      <div
        style={{
          width: 36,
          height: 36,
          borderRadius: 10,
          background:
            "linear-gradient(135deg, var(--accent), #818cf8)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          marginBottom: 20,
          boxShadow: "0 0 20px var(--accent-glow)",
          flexShrink: 0,
        }}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="3" fill="white" />
          <circle cx="4" cy="6" r="2" fill="white" fillOpacity="0.7" />
          <circle cx="20" cy="6" r="2" fill="white" fillOpacity="0.7" />
          <circle cx="4" cy="18" r="2" fill="white" fillOpacity="0.7" />
          <circle cx="20" cy="18" r="2" fill="white" fillOpacity="0.7" />
          <line x1="12" y1="12" x2="4" y2="6" stroke="white" strokeOpacity="0.5" strokeWidth="1.5" />
          <line x1="12" y1="12" x2="20" y2="6" stroke="white" strokeOpacity="0.5" strokeWidth="1.5" />
          <line x1="12" y1="12" x2="4" y2="18" stroke="white" strokeOpacity="0.5" strokeWidth="1.5" />
          <line x1="12" y1="12" x2="20" y2="18" stroke="white" strokeOpacity="0.5" strokeWidth="1.5" />
        </svg>
      </div>

      {/* Nav items */}
      {NAV_ITEMS.map((item) => {
        const active = currentPage === item.id;
        return (
          <button
            key={item.id}
            onClick={() => onNavigate(item.id)}
            data-tooltip={item.label}
            style={{
              width: 44,
              height: 44,
              borderRadius: 10,
              background: active
                ? "var(--accent-glow-sm)"
                : "transparent",
              border: active
                ? "1px solid rgba(99,102,241,0.3)"
                : "1px solid transparent",
              color: active ? "var(--accent)" : "var(--muted)",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              transition: "all var(--transition)",
              position: "relative",
            }}
            onMouseEnter={(e) => {
              if (!active) {
                (e.currentTarget as HTMLButtonElement).style.background =
                  "var(--surface2)";
                (e.currentTarget as HTMLButtonElement).style.color =
                  "var(--text)";
              }
            }}
            onMouseLeave={(e) => {
              if (!active) {
                (e.currentTarget as HTMLButtonElement).style.background =
                  "transparent";
                (e.currentTarget as HTMLButtonElement).style.color =
                  "var(--muted)";
              }
            }}
          >
            {active && (
              <div
                style={{
                  position: "absolute",
                  left: -1,
                  top: "50%",
                  transform: "translateY(-50%)",
                  width: 3,
                  height: 20,
                  background: "var(--accent)",
                  borderRadius: "0 2px 2px 0",
                  boxShadow: "0 0 8px var(--accent)",
                }}
              />
            )}
            {item.icon}
          </button>
        );
      })}
    </aside>
  );
}
