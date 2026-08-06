import type { Theme } from "../theme.js";

const THEME_ICONS: Record<Theme, { label: string; path: string }> = {
  light: {
    label: "切换到深色主题",
    path: "M13.5 11.5A5.5 5.5 0 0 1 6.5 4.5a5.5 5.5 0 1 0 7 7Z",
  },
  dark: {
    label: "切换到浅色主题",
    path: "",
  },
};

function ThemeIcon({ theme }: { theme: Theme }) {
  if (theme === "light") {
    return (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
        <path
          d={THEME_ICONS.light.path}
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <circle cx="9" cy="9" r="3.5" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M9 1.5v2M9 14.5v2M1.5 9h2M14.5 9h2M3.7 3.7l1.4 1.4M12.9 12.9l1.4 1.4M14.3 3.7l-1.4 1.4M5.1 12.9l-1.4 1.4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

export type ConnectionState = "connecting" | "online" | "offline";

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  connecting: "连接中",
  online: "已连接",
  offline: "未连接",
};

interface AppHeaderProps {
  theme: Theme;
  onToggleTheme: () => void;
  connection: ConnectionState;
  modelControl?: React.ReactNode;
}

export function AppHeader({ theme, onToggleTheme, connection, modelControl }: AppHeaderProps) {
  return (
    <header className="app-header">
      <div className="app-header-left">
        <span className="app-brand">Chat</span>
        {modelControl}
      </div>
      <div className="app-header-right">
        <span className="connection-status" data-state={connection}>
          <span className="connection-dot" aria-hidden="true" />
          {CONNECTION_LABEL[connection]}
        </span>
        <button
          type="button"
          className="theme-toggle"
          aria-label={THEME_ICONS[theme].label}
          onClick={onToggleTheme}
        >
          <ThemeIcon theme={theme} />
        </button>
      </div>
    </header>
  );
}
