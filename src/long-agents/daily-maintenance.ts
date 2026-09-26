import { createHash } from "node:crypto";
import { openChatSession } from "../chat-session.js";
import { resolveChatHome } from "../chat-home.js";
import { chatSessionOperationKey, withChatSessionOperationLock } from "../session-operation-lock.js";
import { createChatPiAgentSession } from "../agents/pi-agent-session.js";
import { prepareLongAgentAssembly } from "./assembly.js";
import { agentDate } from "./calendar.js";
import { ensureAgentCalendar, recoverFriendCalendar } from "./project-agent.js";
import { readLongAgentRegistry, readLongAgentState, updateLongAgentState } from "./storage.js";
import { appendChatLongAgentTurn, latestChatLongAgentTurn, collectChatLongAgentTurnMarkers } from "./session-turn.js";
import { collectTopicRoundMarkers } from "./topic-anchor.js";
import { drainLongAgentTurns, isFriendWorkerActive, updateTurnStatus } from "./turn-queue.js";
import { readLongAgentSummary, writeLongAgentSummary } from "./summaries.js";
import type { DailySession } from "./daily-state.js";
import type { LongAgentConfig } from "./types.js";

const checks = new Map<string, Promise<void>>();
const timers = new Map<string, NodeJS.Timeout>();
const SUMMARY_TRIGGER = "chat.daily-summary.v1";

async function updateSummary(home: string, day: DailySession, summary: DailySession["summary"]): Promise<void> {
  await updateLongAgentState(home, (state) => ({ state: { ...state, dailySessions: state.dailySessions.map((entry) =>
    entry.longAgentId === day.longAgentId && entry.date === day.date ? { ...entry, summary } : entry) }, result: undefined }));
}
function summaryBody(text: string) {
  const value: unknown = JSON.parse(text.trim());
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("did" in value) || !("reflections" in value) || !("handoff" in value)
    || !Array.isArray(value.did) || !Array.isArray(value.reflections) || typeof value.handoff !== "string"
    || !value.did.every((item: unknown) => typeof item === "string") || !value.reflections.every((item: unknown) => typeof item === "string")
    || text.length > 20_000) throw new Error("总结必须是有效JSON，包含did/reflections字符串数组和handoff字符串，最多20000字符");
  return { did: value.did as string[], reflections: value.reflections as string[], handoff: value.handoff };
}

/** A maintenance turn lives in the old native Session, never a hidden second Agent runtime. */
async function summarizeDay(home: string, agent: LongAgentConfig, day: DailySession, now: Date): Promise<void> {
  await withChatSessionOperationLock(chatSessionOperationKey(agent.id, day.sessionId), async () => {
    const chatSession = await openChatSession({ projectId: agent.id, sessionId: day.sessionId, chatHome: home });
    const manager = chatSession.manager;
    const branch = manager.getBranch();
    if (!branch.some((entry) => entry.type === "message")) {
      await updateSummary(home, day, { ...day.summary, status: "completed", error: null });
      return;
    }
    const cutoff = day.summary.cutoff ?? manager.getLeafId();
    if (cutoff === null) return;
    const previous = await readLongAgentSummary(home, agent.id, day.date);
    if (previous?.source?.cutoff === cutoff && previous.source.sessionId === day.sessionId) {
      await writeLongAgentSummary({ chatHome: home, longAgentId: agent.id, ...previous });
      await updateSummary(home, day, { ...day.summary, status: "completed", cutoff, entryId: previous.source.entryId, revision: previous.source.revision, error: null, nextAttemptAt: null });
      return;
    }
    const started = { ...day.summary, status: "running" as const, attempts: day.summary.status === "running" ? day.summary.attempts : day.summary.attempts + 1, cutoff, error: null, nextAttemptAt: null };
    const claimed = await updateLongAgentState(home, (state) => {
      if (state.turns.some((turn) => turn.sessionId === day.sessionId && (turn.status === "queued" || turn.status === "running"))) return { state, result: false };
      return { state: { ...state, dailySessions: state.dailySessions.map((entry) => entry.sessionId === day.sessionId ? { ...entry, summary: started } : entry) }, result: true };
    });
    if (!claimed) return;
    let created: Awaited<ReturnType<typeof createChatPiAgentSession>> | undefined;
    try {
      // Crash after a native assistant append but before the JSON commit: reuse that output.
      const triggerIndex = branch.findLastIndex((entry) => entry.type === "custom_message" && entry.customType === SUMMARY_TRIGGER
        && typeof entry.details === "object" && entry.details !== null && "cutoff" in entry.details && entry.details.cutoff === cutoff);
      let output = day.summary.status !== "running" || triggerIndex < 0 ? undefined : branch.slice(triggerIndex + 1).findLast((entry) => entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "stop");
      if (output === undefined) {
        const prepared = await prepareLongAgentAssembly({ agent, chatHome: home, projectId: null,
          turnId: `summary:${day.date}:${cutoff}:${started.attempts}`, today: day.date });
        created = await createChatPiAgentSession({ chatSession, sessionManager: manager, ...prepared,
          agent: { ...prepared.agent, tools: { mode: "none" }, resources: { mode: "explicit", skillPaths: [], extensionPaths: [], pluginSources: [] } },
          toolContext: { purpose: "execution", agentId: agent.id, longAgentId: agent.id, longAgentTurnId: prepared.invocation.turnId } });
        await created.session.sendCustomMessage({ customType: SUMMARY_TRIGGER, display: false, details: { date: day.date, cutoff },
          content: `内部日终整理：总结 ${day.date}，原Session ${day.sessionId}，截止Entry ${cutoff}。只依据本Session原始记录，区分每段历史的项目；保留未完成事项、待用户决定和下一步。不执行工具、不发送消息、不写Memory。仅返回JSON：{"did":["事实及项目"],"reflections":["具体问题"],"handoff":"待续工作及项目、未完成状态"}。这不是用户的新发言。` }, { triggerTurn: true });
        output = manager.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
      }
      if (output?.type !== "message" || output.message.role !== "assistant" || output.message.stopReason !== "stop") throw new Error(output?.type === "message" && output.message.role === "assistant" ? output.message.errorMessage ?? "总结模型未正常完成" : "总结模型未正常完成");
      const text = output.message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
      const body = summaryBody(text);
      const revision = createHash("sha256").update(JSON.stringify({ sessionId: day.sessionId, cutoff, body })).digest("hex");
      await writeLongAgentSummary({ chatHome: home, longAgentId: agent.id, date: day.date, ...body,
        source: { sessionId: day.sessionId, cutoff, entryId: output.id, revision } });
      await updateSummary(home, day, { ...started, status: "completed", entryId: output.id, revision });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const transient = !(error instanceof SyntaxError)
        && !/credential|api.?key|permission|unauthorized|forbidden|\b401\b|\b403\b|认证|权限/i.test(message)
        && /timeout|timed out|network|ECONN|429|503|502|504|temporar/i.test(message);
      await updateSummary(home, day, { ...started, status: "failed", error: message,
        nextAttemptAt: transient && started.attempts < 3 ? new Date(now.getTime() + (started.attempts === 1 ? 60_000 : 300_000)).toISOString() : null });
    } finally { created?.session.dispose(); }
  }, { longAgentId: agent.id });
}

/** Recover only proven completion. Unknown interrupted writes never auto-replay. */
export async function recoverLongAgentTurns(home: string, workerOwnsSession?: string): Promise<void> {
  for (const turn of (await readLongAgentState(home)).turns) {
    if (turn.status !== "running" || (isFriendWorkerActive(home, turn.longAgentId, turn.sessionId) && workerOwnsSession !== turn.sessionId)) continue;
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

export function maintainLongAgentDays(chatHome = resolveChatHome(), now = new Date()): Promise<void> {
  const home = resolveChatHome(chatHome); const existing = checks.get(home); if (existing !== undefined) return existing;
  const running = (async () => {
    await recoverLongAgentTurns(home);
    void import("./tasks/service.js").then(m => m.reconcileFriendTasks(home)).catch(error => console.error("任务管理恢复失败", error));
    void import("./work.js").then(m => m.deliverFriendWorkReturns(home)).catch(error => console.error("后台工作结果待返回", error));
    const registry = await readLongAgentRegistry(home);
    await Promise.all(registry.agents.filter((agent) => agent.enabled && agent.status !== "archived").map(async (entry) => {
      const agent = await ensureAgentCalendar(entry, home);
      await recoverFriendCalendar(home, agent);
      void drainLongAgentTurns(home, agent.id).catch(error => console.error("Friend队列恢复失败", error));
      const state = await readLongAgentState(home);
      for (const day of state.dailySessions.filter((day) => day.longAgentId === agent.id && day.date < agentDate(agent.timeZone, now))) {
        if (state.turns.some((turn) => turn.sessionId === day.sessionId && (turn.status === "queued" || turn.status === "running"))) continue;
        if (day.summary.status === "completed" || (day.summary.status === "failed" && (day.summary.nextAttemptAt === null || Date.parse(day.summary.nextAttemptAt) > now.getTime()))) continue;
        await summarizeDay(home, agent, day, now);
      }
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
export async function retryDailySummary(home: string, longAgentId: string, date: string): Promise<void> {
  const day = (await readLongAgentState(home)).dailySessions.find((day) => day.longAgentId === longAgentId && day.date === date);
  if (day === undefined || day.summary.status !== "failed") throw new Error("仅失败的日终总结可以重试");
  await updateSummary(home, day, { ...day.summary, status: "pending", nextAttemptAt: null });
  await maintainLongAgentDays(home);
}
