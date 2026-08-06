import { serviceStatusSchema } from "@chat/contracts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { AppHeader, type ConnectionState } from "./components/AppHeader.js";
import { ChatPanel } from "./components/ChatPanel.js";
import { ModelSelector } from "./components/ModelSelector.js";
import { applyTheme, nextTheme, resolveTheme, type Theme } from "./theme.js";
import {
  MODEL_FIXTURES,
  persistModelId,
  readStoredModelId,
  type ChatMessage,
} from "./viewmodel/chat-view-model.js";

async function fetchServiceStatus() {
  const res = await fetch("/api/healthz");
  if (!res.ok) {
    throw new Error(`healthz failed: ${res.status}`);
  }
  return serviceStatusSchema.parse(await res.json());
}

function createLocalMessage(text: string): ChatMessage {
  return { id: crypto.randomUUID(), role: "user", text };
}

/**
 * P1.1外壳：只投影服务端连接状态，不持有权威事实。
 * 消息与模型选择均为浏览器本地草稿/偏好，不代表正式事实（见P1.3/P1.7）。
 */
export function App() {
  const status = useQuery({ queryKey: ["service-status"], queryFn: fetchServiceStatus });
  const [theme, setTheme] = useState<Theme>(() => resolveTheme(window.localStorage));
  const [modelId, setModelId] = useState(() => readStoredModelId(window.localStorage));
  const [messages, setMessages] = useState<readonly ChatMessage[]>([]);

  const connection: ConnectionState = status.isPending
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

  function handleSend(text: string) {
    setMessages((current) => [...current, createLocalMessage(text)]);
  }

  return (
    <div className="app-shell">
      <AppHeader
        theme={theme}
        onToggleTheme={handleToggleTheme}
        connection={connection}
        modelControl={
          <ModelSelector models={MODEL_FIXTURES} value={modelId} onChange={handleModelChange} />
        }
      />
      <ChatPanel messages={messages} onSend={handleSend} />
    </div>
  );
}
