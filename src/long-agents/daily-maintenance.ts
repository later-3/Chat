import { openChatSession } from "../chat-session.js";
import { resolveChatHome } from "../chat-home.js";
import { ensureAgentCalendar, recoverFriendCalendar } from "./project-agent.js";
import { readLongAgentRegistry, readLongAgentState } from "./storage.js";
import { appendChatLongAgentTurn, latestChatLongAgentTurn, collectChatLongAgentTurnMarkers } from "./session-turn.js";
import { collectTopicRoundMarkers } from "./topic-anchor.js";
import { drainLongAgentTurns, isFriendWorkerActive, updateTurnStatus } from "./turn-queue.js";
const checks = new Map<string, Promise<void>>();
const timers = new Map<string, NodeJS.Timeout>();

/** Recover only proven completion. Unknown interrupted writes never auto-replay. */
export async function recoverLongAgentTurns(home: string, workerOwnsSession?: string): Promise<void> {
  for (const turn of (await readLongAgentState(home)).turns) {
    if (turn.status !== "running" || (isFriendWorkerActive(home, turn.longAgentId, turn.sessionId) && workerOwnsSession !== turn.sessionId)) continue;
    // New receipts are governed by the Workflow World. A completed work marker cannot settle a
    // suspended review or unfinished memory Step; the ordered worker reattaches to that same Run.
    if (turn.workflow !== undefined) continue;
    const session = await openChatSession({ projectId: turn.longAgentId, sessionId: turn.sessionId, chatHome: home });
    const entries = session.manager.getBranch();
    const marker = latestChatLongAgentTurn(entries, turn.turnId);
    const error = "Backend中断，工具结果可能未知；已保留原始历史，不自动重放，请检查后发起新消息";
    // A topic round is governed by its OWN outer round marker, not by the work segment. Resolve the
    // LATEST marker per roundId: a normal round keeps BOTH its `running` opener and its `completed`
    // closer, so a naive `some(status !== "completed")` would always see the stale opener. Only a round
    // whose latest marker is still not `completed` is incomplete.
    const latestStatusByRound = new Map<string, string>();
    for (const round of collectTopicRoundMarkers(entries)) latestStatusByRound.set(round.roundId, round.status);
    let governingRoundId: string | null = null;
    if (latestStatusByRound.has(turn.turnId)) governingRoundId = turn.turnId;
    else for (const roundId of latestStatusByRound.keys()) if (turn.turnId.endsWith(`:${roundId}`)) { governingRoundId = roundId; break; }
    const incompleteTopicRound = governingRoundId !== null && latestStatusByRound.get(governingRoundId) !== "completed";
    if (incompleteTopicRound) {
      if (marker !== undefined && marker.status !== "completed") { appendChatLongAgentTurn(session.manager, { ...marker, status: "failed", completedAt: new Date().toISOString(), error }); session.manager.flush(); }
      await updateTurnStatus(home, turn.turnId, "interrupted", error);
      continue;
    }
    if (marker?.status === "completed") { await updateTurnStatus(home, turn.turnId, "completed"); continue; }
    const startIndex = marker === undefined ? -1 : entries.findIndex((entry) => entry.id === marker.entryId);
    const nextTurn = collectChatLongAgentTurnMarkers(entries.slice(startIndex + 1)).find((entry) => entry.turnId !== turn.turnId);
    const endIndex = nextTurn === undefined ? entries.length : entries.findIndex((entry) => entry.id === nextTurn.entryId);
    const after = startIndex < 0 ? [] : entries.slice(startIndex + 1, endIndex);
    const last = after.findLast((entry) => entry.type === "message");
    if (marker?.status === "running" && last?.type === "message" && last.message.role === "assistant" && last.message.stopReason === "stop") {
      appendChatLongAgentTurn(session.manager, { ...marker, status: "completed", completedAt: new Date().toISOString(), error: null });
      session.manager.flush();
      await updateTurnStatus(home, turn.turnId, "completed");
    } else {
      if (marker !== undefined) { appendChatLongAgentTurn(session.manager, { ...marker, status: "failed", completedAt: new Date().toISOString(), error }); session.manager.flush(); }
      await updateTurnStatus(home, turn.turnId, "interrupted", error);
    }
  }
}

export function maintainLongAgentDays(chatHome = resolveChatHome(), _now = new Date()): Promise<void> {
  const home = resolveChatHome(chatHome); const existing = checks.get(home); if (existing !== undefined) return existing;
  const running = (async () => {
    await recoverLongAgentTurns(home);
    await import("./tasks/service.js").then(m => m.reconcileFriendTasks(home)).catch(error => console.error("任务管理恢复失败", error));
    await import("./work.js").then(m => m.deliverFriendWorkReturns(home)).catch(error => console.error("后台工作结果待返回", error));
    const registry = await readLongAgentRegistry(home);
    await Promise.all(registry.agents.filter((agent) => agent.enabled && agent.status !== "archived").map(async (entry) => {
      const agent = await ensureAgentCalendar(entry, home);
      await recoverFriendCalendar(home, agent);
      void drainLongAgentTurns(home, agent.id).catch(error => console.error("Friend队列恢复失败", error));

    }));
  })().finally(() => { if (checks.get(home) === running) checks.delete(home); });
  checks.set(home, running); return running;
}

export function notifyDailyMaintenance(home: string): void {
  if (timers.has(home)) void maintainLongAgentDays(home).catch((error: unknown) => console.error("Friend日历检查失败:", error instanceof Error ? error.message : String(error)));
}
export function startLongAgentDailyMaintenance(home: string): void {
  if (timers.has(home)) return;
  const run = () => { void maintainLongAgentDays(home).catch((error: unknown) => console.error("Friend日历恢复失败:", error instanceof Error ? error.message : String(error))); };
  run(); const timer = setInterval(run, 60_000); timer.unref(); timers.set(home, timer);
}
