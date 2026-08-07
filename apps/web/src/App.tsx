import { serviceStatusSchema } from "@chat/contracts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { PwaUpdatePrompt } from "./components/PwaUpdatePrompt.js";
import { WorkspaceShell, type ConnectionState } from "./components/WorkspaceShell.js";
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
 * P1.1工作空间：只投影服务端连接状态，其余会话、运行和产物均为本地界面fixture。
 * 本地消息与模型选择不代表正式事实（见P1.3/P1.5/P1.7）。
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
      />
      <PwaUpdatePrompt />
    </>
  );
}
