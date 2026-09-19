import { settleConsumedSteering } from "./turn-controls.js";
import { getLiveTurn } from "./live-turn.js";
import { createHash, randomUUID } from "node:crypto";
import { SessionManager, type DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { openChatSession } from "../chat-session.js";
import { resolveChatHome } from "../chat-home.js";
import { withFileLock } from "../persistence/versioned-file.js";
import { createChatPiAgentSession } from "../agents/pi-agent-session.js";
import { assemblyRevision, CHAT_ASSEMBLY_CONTEXT, readAssemblySnapshot, persistAssemblySnapshot } from "../agents/assembly-context.js";
import { prepareLongAgentAssembly } from "./assembly.js";
import { agentGroupContextRevisionOf, readLongAgentAgentGroup } from "./agent-group-service.js";
import { ensureProjectLongAgent, ensureAgentCalendar, hasFriendDailyActivity } from "./project-agent.js";
import { readLongAgentRegistry, readLongAgentState, updateLongAgentState } from "./storage.js";
import type { LongAgentPendingEvent } from "./types.js";
import type { AcceptedTurn } from "./daily-state.js";
import { FriendCancelledError } from "./runtime.js";
import { assertModelSupportsImages } from "../workflows/image-input.js";
import type { ExecuteLongAgentTurnInput, ExecuteLongAgentTurnResult } from "./runtime.js";

const loaders = new Map<string, DefaultResourceLoader>();
const drains = new Map<string, Promise<void>>();
const key = (home: string, turnId: string) => `${home}\0${turnId}`;
export class LongAgentRequestConflict extends Error { readonly statusCode = 409; }

/** Validate and freeze before durable acceptance, without touching the live Session branch. */
export async function acceptLongAgentTurn(input: ExecuteLongAgentTurnInput, pendingEvent?: LongAgentPendingEvent): Promise<AcceptedTurn & { readonly newAcceptance: boolean }> {
  const home = resolveChatHome(input.chatHome);
  const requestId = input.turnId ?? randomUUID();
  if (!requestId.trim() || requestId.length > 256) throw new Error("requestId必须为1–256个字符");
  if (typeof input.text !== "string" || (!input.text.trim() && !input.images?.length) || input.text.length > 100_000) throw new Error("消息必须包含有效正文或图片，正文最多100000字符");
  const source = input.source ?? "chat-web";
  const payloadHash = createHash("sha256").update(JSON.stringify({ text: input.text, images: input.images ?? [], contextProjectId: input.contextProjectId ?? null,
    longAgentId: input.longAgentId, source, summaryDraft: input.summaryDraft ?? false, channelType: input.channelType ?? null, inboundEventId: input.inboundEventId ?? null })).digest("hex");
  return withFileLock(`${home}/runtime/friend-accept`, async () => {
    const prior = (await readLongAgentState(home)).turns.find((turn) => turn.longAgentId === input.longAgentId && turn.source === source && turn.requestId === requestId);
    if (prior !== undefined) {
      if (prior.payloadHash !== payloadHash) throw new LongAgentRequestConflict("同一requestId包含不同消息或项目，不能重复接受");
      return { ...prior, newAcceptance: false };
    }
    const agent = (await readLongAgentRegistry(home)).agents.find((candidate) => candidate.id === input.longAgentId && candidate.enabled && candidate.status !== "archived");
    if (agent === undefined) throw new Error(`找不到可用LongAgent: ${input.longAgentId}`);
    if (input.summaryDraft && !await hasFriendDailyActivity(home, agent)) throw new Error("今日没有可整理活动，不创建空会话");
    const calendar = await ensureAgentCalendar(agent, home);
    const acceptedAt = new Date();
    const located = await ensureProjectLongAgent({ chatHome: home, projectId: input.projectId, agent, now: acceptedAt,
      ...(source !== "chat-web" || input.sessionId === undefined ? {} : { requestedSessionId: input.sessionId }) });
    if (located.day.summary.status === "running") throw new Error("该日期正在收尾，请稍后重试；原历史保留");
    const chatSession = await openChatSession({ projectId: agent.id, chatHome: home, sessionId: located.day.sessionId });
    const memory = SessionManager.inMemory(chatSession.cwd);
    // The temporary Session is solely an assembly preview; only its custom snapshots are retained.
    const turnId = `${source}:${agent.id}:${requestId}`;
    const group = await readLongAgentAgentGroup(agent.id, home);
    const prepared = await prepareLongAgentAssembly({ agent, chatHome: home, projectId: input.contextProjectId ?? null, turnId, groupContext: group, today: located.day.date });
    const created = await createChatPiAgentSession({ chatSession, sessionManager: memory, ...prepared,
      ...(input.summaryDraft ? { agent: { ...prepared.agent, tools: { mode: "none" as const }, resources: { mode: "explicit" as const, skillPaths: [], extensionPaths: [], pluginSources: [] } } } : {}),
      toolContext: { purpose: "execution", agentId: agent.id, longAgentId: agent.id, longAgentTurnId: turnId } });
    try {
      if (source === "chat-web") assertModelSupportsImages(created.session.model, input.images);
      const snapshot = readAssemblySnapshot(memory, turnId);
      if (snapshot === undefined) throw new Error("缺少公共装配快照");
      const { revision: _revision, ...body } = { ...snapshot, sessionId: located.day.sessionId, agent: { ...snapshot.agent,
        tools: snapshot.agent.tools.mode === "pi-default" ? { ...snapshot.agent.tools, mode: "explicit" as const, names: created.session.getActiveToolNames(), exclude: [] } : snapshot.agent.tools } };
      const seed = memory.getEntries().filter((entry) => entry.type === "custom" && entry.customType.startsWith("chat.agent-assembly"))
        .map((entry) => { if (entry.type !== "custom") throw new Error("无效装配记录");
          return { customType: entry.customType, data: entry.customType === CHAT_ASSEMBLY_CONTEXT ? { ...body, revision: assemblyRevision(body) } : entry.data }; });
      const turn = await updateLongAgentState(home, (state) => {
        if (state.dailySessions.some((day) => day.sessionId === located.day.sessionId && day.summary.status === "running")) throw new Error("该日期正在收尾，请稍后重试；原历史保留");
        const turn: AcceptedTurn = { turnId, requestId, payloadHash, isNewSession: located.isNewSession, summaryDraft: input.summaryDraft ?? false, longAgentId: agent.id, source,
          channelType: input.channelType ?? (source === "chat-web" ? "chat-web" : null), inboundEventId: input.inboundEventId ?? null,
          contextProjectId: input.contextProjectId ?? null, sessionId: located.day.sessionId, date: located.day.date, timeZone: calendar.timeZone,
          acceptedAt: acceptedAt.toISOString(), sequence: state.turns.reduce((max, item) => Math.max(max, item.sequence), 0) + 1,
          status: "queued", error: null, text: input.text as string, ...(input.images === undefined ? {} : { images: input.images }), seed,
          groupContext: agentGroupContextRevisionOf(group) };
        return { state: { ...state, turns: [...state.turns, turn],
          pendingEvents: pendingEvent === undefined || state.pendingEvents.some((item) => item.event.eventId === pendingEvent.event.eventId) ? state.pendingEvents : [...state.pendingEvents, pendingEvent], dailySessions: state.dailySessions.map((day) => day.sessionId === turn.sessionId && (day.summary.status !== "pending" || day.summary.cutoff !== null)
          ? { ...day, summary: { status: "pending" as const, attempts: 0, cutoff: null, entryId: null, nextAttemptAt: null, error: null, revision: null } } : day) }, result: turn };
      });
      loaders.set(key(home, turn.turnId), created.resourceLoader);
      return { ...turn, newAcceptance: true };
    } finally { created.session.dispose(); }
  });
}

export function installAcceptedAssembly(manager: SessionManager, turn: AcceptedTurn): void {
  if (readAssemblySnapshot(manager, turn.turnId) !== undefined) return;
  const memory = SessionManager.inMemory(manager.getCwd());
  for (const entry of turn.seed ?? []) memory.appendCustomEntry(entry.customType, entry.data);
  const snapshot = readAssemblySnapshot(memory, turn.turnId);
  if (snapshot === undefined || snapshot.sessionId !== manager.getSessionId()) throw new Error("已接受快照不属于当前Session");
  for (const entry of turn.seed ?? []) if (entry.customType !== CHAT_ASSEMBLY_CONTEXT) manager.appendCustomEntry(entry.customType, entry.data);
  persistAssemblySnapshot(manager, snapshot);
}

export async function updateTurnStatus(home: string, turnId: string, status: AcceptedTurn["status"], error: string | null = null): Promise<void> {
  await updateLongAgentState(home, (state) => ({ state: { ...state, turns: state.turns.map((turn) => {
    if (turn.turnId !== turnId) return turn;
    if (status === "completed" || status === "cancelled") {
      const { text: _text, images: _images, seed: _seed, ...receipt } = turn;
      return { ...receipt, status, error };
    }
    return { ...turn, status, error };
  }) }, result: undefined }));
}

/** One ordered worker per Friend, using the existing native Session runtime. Different Friends remain concurrent. */
export function drainLongAgentTurns(home: string, longAgentId: string): Promise<void> {
  const queueKey = key(home, longAgentId);
  const existing = drains.get(queueKey); if (existing !== undefined) return existing;
  const run = (async () => {
    const { executeAcceptedLongAgentTurn } = await import("./runtime.js");
    const { recoverLongAgentTurns } = await import("./daily-maintenance.js");
    await recoverLongAgentTurns(home, longAgentId);
    while (true) {
      const turn = (await readLongAgentState(home)).turns.filter((item) => item.longAgentId === longAgentId && item.status === "queued").sort((a, b) => a.sequence - b.sequence)[0];
      if (turn === undefined) return;
      if (await settleConsumedSteering(home, turn)) continue;
      const claimed = await updateLongAgentState(home, (state) => {
        const current = state.turns.find((entry) => entry.turnId === turn.turnId);
        if (current?.status !== "queued") return { state, result: false };
        return { state: { ...state, turns: state.turns.map((entry) => entry.turnId === turn.turnId ? { ...entry, status: "running" as const } : entry) }, result: true };
      });
      if (!claimed) continue;
      try {
        await executeAcceptedLongAgentTurn({ longAgentId, projectId: longAgentId, sessionId: turn.sessionId, text: turn.text,
          ...(turn.images === undefined ? {} : { images: turn.images }), chatHome: home, turnId: turn.turnId, source: turn.source, channelType: turn.channelType,
          ...(turn.inboundEventId === null ? {} : { inboundEventId: turn.inboundEventId }), contextProjectId: turn.contextProjectId }, turn, loaders.get(key(home, turn.turnId)));
        await updateTurnStatus(home, turn.turnId, "completed");
      } catch (error) { await updateTurnStatus(home, turn.turnId, error instanceof FriendCancelledError ? "cancelled" : "failed", error instanceof Error ? error.message : String(error)); }
      finally { loaders.delete(key(home, turn.turnId)); }
    }
  })().finally(() => { if (drains.get(queueKey) === run) drains.delete(queueKey); });
  drains.set(queueKey, run); return run;
}

export async function executeQueuedLongAgentTurn(input: ExecuteLongAgentTurnInput): Promise<ExecuteLongAgentTurnResult> {
  const home = resolveChatHome(input.chatHome);
  // The registered worker checks closing days independently; acceptance never waits for a summary.
  const { notifyDailyMaintenance } = await import("./daily-maintenance.js");
  notifyDailyMaintenance(home);
  const accepted = await acceptLongAgentTurn(input);
  let turn: AcceptedTurn = accepted;
  while (turn.status === "queued" || turn.status === "running") {
    await drainLongAgentTurns(home, input.longAgentId);
    turn = (await readLongAgentState(home)).turns.find((item) => item.turnId === accepted.turnId)!;
    if (turn.status === "running" && !isFriendWorkerActive(home, input.longAgentId)) {
      const { recoverLongAgentTurns } = await import("./daily-maintenance.js");
      await recoverLongAgentTurns(home);
      turn = (await readLongAgentState(home)).turns.find((item) => item.turnId === accepted.turnId)!;
    }
  }
  if (turn.status !== "completed") throw new Error(turn.error ?? `请求状态：${turn.status}`);
  const { executeAcceptedLongAgentTurn } = await import("./runtime.js");
  return executeAcceptedLongAgentTurn({ ...input, projectId: input.longAgentId, sessionId: turn.sessionId, turnId: turn.turnId }, turn);
}

export function isFriendWorkerActive(home: string, longAgentId: string): boolean { return drains.has(key(home, longAgentId)); }

export async function controlQueuedRequest(home: string, longAgentId: string, turnId: string, action: "cancel" | "retry"): Promise<void> {
  await updateLongAgentState(home, (state) => {
    const turn = state.turns.find((item) => item.longAgentId === longAgentId && item.turnId === turnId);
    if (turn === undefined || (action === "cancel" ? turn.status !== "queued" : turn.status !== "failed")) throw new Error("请求状态不支持该操作；结果不明的中断须检查后发起新消息");
    if (action === "cancel" && state.turns.some(item => getLiveTurn(home, item.turnId)?.steering.has(turnId))) throw new Error("引导已进入原生队列，不能单独撤回；可以取消当前执行");
    if (action === "retry" && state.dailySessions.some((day) => day.sessionId === turn.sessionId && (day.summary.status === "completed" || day.summary.status === "running"))) throw new Error("该日期已收尾或正在收尾，请在今天发起新消息");
    if (action === "retry" && state.turns.some((item) => item.sessionId === turn.sessionId && item.sequence > turn.sequence && item.status !== "queued" && item.status !== "cancelled")) throw new Error("该请求后已有对话，不能回退历史；请在当前会话发起新消息");
    return { state: { ...state, dailySessions: action !== "retry" ? state.dailySessions : state.dailySessions.map((day) => day.sessionId === turn.sessionId
      ? { ...day, summary: { status: "pending" as const, attempts: 0, cutoff: null, entryId: null, nextAttemptAt: null, error: null, revision: null } } : day), turns: state.turns.map((item) => {
      if (item.turnId !== turnId) return item;
      if (action === "retry") return { ...item, status: "queued" as const, error: null };
      const { text: _text, images: _images, seed: _seed, ...receipt } = item;
      loaders.delete(key(home, turnId));
      return { ...receipt, status: "cancelled" as const, error: null };
    }) }, result: undefined };
  });
  if (action === "retry") await drainLongAgentTurns(home, longAgentId);
}
