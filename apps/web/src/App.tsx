import { serviceStatusSchema } from "@chat/contracts/public";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { PwaUpdatePrompt } from "./components/PwaUpdatePrompt.js";
import { RealWorkspace } from "./components/RealWorkspace.js";
import { WorkspaceShell, type ConnectionState } from "./components/WorkspaceShell.js";
import { useRealChain } from "./real/use-real-chain.js";
import { applyTheme, nextTheme, resolveTheme, type Theme } from "./theme.js";
import { useOnlineState } from "./use-online-state.js";
import {
  MODEL_FIXTURES,
  persistModelId,
  readStoredModelId,
  type ChatMessage,
} from "./viewmodel/chat-view-model.js";
import { SESSION_FIXTURES, type SessionId } from "./viewmodel/workspace-view-model.js";

async function fetchServiceStatus() {
  const res = await fetch("/api/healthz");
  if (!res.ok) {
    throw new Error(`healthz failed: ${res.status}`);
  }
  return serviceStatusSchema.parse(await res.json());
}

/**
 * 健康检查有限频率轮询间隔。普通 useQuery 只在聚焦/重连时刷新，
 * API 中途宕机而浏览器仍在线时会停留在“已连接”假在线；
 * 30 秒轮询保证发送能力跟随真实服务状态收敛。
 */
export const HEALTH_REFETCH_INTERVAL_MS = 30_000;

function createLocalMessage(text: string): ChatMessage {
  return { id: crypto.randomUUID(), role: "user", text, localOnly: true };
}

const INITIAL_MESSAGES = Object.fromEntries(
  SESSION_FIXTURES.map((session) => [session.id, session.messages]),
) as Record<SessionId, readonly ChatMessage[]>;

/**
 * 真实规划会话是产品默认入口；P1.1 fixture仅保留在?view=fixture用于视觉回归。
 */
export function App() {
  const browserOnline = useOnlineState();
  const status = useQuery({
    queryKey: ["service-status"],
    queryFn: fetchServiceStatus,
    refetchInterval: HEALTH_REFETCH_INTERVAL_MS,
  });
  const [theme, setTheme] = useState<Theme>(() => resolveTheme(window.localStorage));
  const [modelId, setModelId] = useState(() => readStoredModelId(window.localStorage));
  const [messagesBySession, setMessagesBySession] =
    useState<Readonly<Record<SessionId, readonly ChatMessage[]>>>(INITIAL_MESSAGES);
  const [view, setView] = useState<"fixture" | "real">(() =>
    new URLSearchParams(window.location.search).get("view") === "fixture" ? "fixture" : "real",
  );

  // 浏览器离线时直接判为未连接；在线时以 /api/healthz 投影为准。
  // Service Worker 不缓存 /api，健康检查失败永远来自真实网络。
  const connection: ConnectionState = !browserOnline
    ? "offline"
    : status.isPending
      ? "connecting"
      : status.isError
        ? "offline"
        : "online";

  function handleToggleTheme() {
    const next = nextTheme(theme);
    applyTheme(next, document.documentElement, window.localStorage);
    setTheme(next);
  }

  function handleModelChange(nextModelId: string) {
    persistModelId(nextModelId, window.localStorage);
    setModelId(nextModelId);
  }

  function handleSend(sessionId: SessionId, text: string) {
    setMessagesBySession((current) => ({
      ...current,
      [sessionId]: [...current[sessionId], createLocalMessage(text)],
    }));
  }

  if (view === "real") {
    return (
      <>
        <RealView
          theme={theme}
          connection={connection}
          onToggleTheme={handleToggleTheme}
          onBack={() => setView("fixture")}
        />
        <PwaUpdatePrompt />
      </>
    );
  }

  return (
    <>
      <WorkspaceShell
        connection={connection}
        theme={theme}
        onToggleTheme={handleToggleTheme}
        models={MODEL_FIXTURES}
        modelId={modelId}
        onModelChange={handleModelChange}
        messagesBySession={messagesBySession}
        onSend={handleSend}
        onOpenReal={() => setView("real")}
      />
      <PwaUpdatePrompt />
    </>
  );
}

function RealView({
  theme,
  connection,
  onToggleTheme,
  onBack,
}: {
  theme: Theme;
  connection: ConnectionState;
  onToggleTheme: () => void;
  onBack: () => void;
}) {
  const chain = useRealChain(window.localStorage);
  return (
    <div className="workspace-app real-app">
      <section className="workspace-stage">
        <header className="workspace-bar">
          <div className="rail-controls">
            <button className="bar-button" onClick={onBack}>
              查看演示工作区
            </button>
          </div>
          <nav className="workspace-tabs" aria-label="打开的工作空间">
            <span className="workspace-tab active">真实规划会话</span>
          </nav>
          <div className="bar-actions">
            <button
              className="bar-button"
              aria-label={theme === "light" ? "切换到深色主题" : "切换到浅色主题"}
              onClick={onToggleTheme}
            >
              {theme === "light" ? "深色" : "浅色"}
            </button>
          </div>
        </header>
        <div className="workspace-deck">
          <RealWorkspace chain={chain} connected={connection === "online"} />
        </div>
      </section>
    </div>
  );
}
