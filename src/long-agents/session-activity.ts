import { collectChatLongAgentTurnMarkers } from "./session-turn.js";

/** A read projection of native turn records and the current process's Session lock. */
export function projectLongAgentActivity(entries: readonly unknown[], sessionBusy: boolean) {
  const latest = collectChatLongAgentTurnMarkers(entries).at(-1);
  const status = sessionBusy ? "running" as const
    : latest?.status === "running" ? "interrupted" as const
    : latest?.status ?? "idle" as const;
  return {
    schemaVersion: 1 as const,
    status,
    turnId: latest?.turnId ?? null,
    startedAt: latest?.startedAt ?? null,
    error: status === "interrupted" ? "Backend 已中断这次处理。已有消息和工具结果已保留，请检查后继续。" : latest?.error ?? null,
  };
}
