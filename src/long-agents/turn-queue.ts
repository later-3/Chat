import { agentDate } from "./calendar.js";
import { settleConsumedSteering } from "./turn-controls.js";
import { getLiveTurn } from "./live-turn.js";
import { createHash, randomUUID } from "node:crypto";
import { readLongAgentInteractionProject } from "./interaction-project.js";
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
  return withFileLock(`${home}/runtime/friend-accept`, async () => {
    // Resolve and freeze the collaboration target inside the accept lock. For the owner-facing private
    // chat the association is authoritative; a declared revision that no longer matches is a conflict,
    // and a per-turn projectId may not silently override the persisted association.
    const prior = (await readLongAgentState(home)).turns.find((turn) => turn.longAgentId === input.longAgentId && turn.source === source && turn.requestId === requestId);
    let contextProjectId = input.contextProjectId ?? null;
    let interactionRevision: number | null = null;
    let work: Awaited<ReturnType<typeof readLongAgentState>>["works"][number] | undefined;
    if (prior !== undefined) {
      // A retry identifies the already accepted input and its frozen target, never today's selection.
      contextProjectId = prior.contextProjectId;
      interactionRevision = prior.interactionRevision ?? null;
    } else if (source === "chat-web") {
      work = input.sessionId === undefined ? undefined
        : (await readLongAgentState(home)).works.find((entry) => entry.sessionId === input.sessionId && entry.longAgentId === input.longAgentId);
      if (work !== undefined) {
        // A work session continues its own frozen target; this is server-derived, not client-claimed.
        if (input.contextProjectId !== undefined && (input.contextProjectId ?? null) !== work.contextProjectId)
          throw new LongAgentRequestConflict("后台工作的项目已固定，请在原项目继续或创建新工作");
        contextProjectId = work.contextProjectId;
      } else if (input.interactionRevision !== undefined) {
        // Ordinary private chat: the association is authoritative and a stale/divergent request conflicts.
        const association = await readLongAgentInteractionProject(home, input.longAgentId);
        if (association.revision !== input.interactionRevision)
          throw new LongAgentRequestConflict("项目关联已变化，请刷新后重新发送");
        if (association.effective.availability === "unavailable")
          throw new LongAgentRequestConflict(`关联项目不可用：${association.effective.reason ?? "请重新选择"}`);
        if (input.contextProjectId !== undefined && (input.contextProjectId ?? null) !== association.effective.projectId)
          throw new LongAgentRequestConflict("请求携带的项目与 Friend 关联不一致，请刷新后重试");
        contextProjectId = association.effective.projectId;
        interactionRevision = association.revision;
      } else if (input.requireInteractionRevision === true) {
        // The owner-facing private-chat entry must not bypass the persisted association.
        throw new LongAgentRequestConflict("私聊消息必须携带 Friend 项目关联 revision");
      }
    }
    // The digest is versioned: a retry of an already accepted request must match the digest of the
    // format that recorded it (older records predate the requested/frozen split), while any changed
    // text/project/revision still fails every candidate and is rejected.
    // JSON.stringify is key-order sensitive, so each historical format keeps its exact field order.
    const digest = (body: Record<string, unknown>) => createHash("sha256").update(JSON.stringify(body)).digest("hex");
    // v1 used the requested project; v2 used the resolved association when a revision was supplied.
    const requestedContextProjectId = input.contextProjectId ?? null;
    const requestedInteractionRevision = input.interactionRevision ?? null;
    const v1 = digest({ text: input.text, images: input.images ?? [], contextProjectId: requestedContextProjectId,
      longAgentId: input.longAgentId, source, summaryDraft: input.summaryDraft ?? false,
      channelType: input.channelType ?? null, inboundEventId: input.inboundEventId ?? null });
    const legacyV2Project = input.contextProjectId === undefined && input.interactionRevision !== undefined
      ? contextProjectId : requestedContextProjectId;
    const v2 = digest({ text: input.text, images: input.images ?? [], contextProjectId: legacyV2Project,
      longAgentId: input.longAgentId, source, summaryDraft: input.summaryDraft ?? false,
      channelType: input.channelType ?? null, inboundEventId: input.inboundEventId ?? null,
      interactionRevision: requestedInteractionRevision });
    const payloadHashV3 = digest({ text: input.text, images: input.images ?? [], requestedContextProjectId: input.contextProjectId ?? null,
      requestedInteractionRevision: input.interactionRevision ?? null, frozenContextProjectId: contextProjectId,
      frozenInteractionRevision: interactionRevision, longAgentId: input.longAgentId, source, summaryDraft: input.summaryDraft ?? false,
      channelType: input.channelType ?? null, inboundEventId: input.inboundEventId ?? null });
    // An explicit format is authoritative. Unversioned records may match historical formats, but
    // v1 cannot attest to a revision that did not exist when that request was accepted.
    const v1Candidates = input.interactionRevision === undefined && (prior?.interactionRevision ?? null) === null ? [v1] : [];
    const payloadHashCandidates = prior?.payloadHashVersion === 3 ? [payloadHashV3]
      : prior?.payloadHashVersion === 2 ? [v2]
      : prior?.payloadHashVersion === 1 ? v1Candidates
      : [...v1Candidates, v2, payloadHashV3];
    const payloadHash = payloadHashV3;
    if (prior !== undefined) {
      if (prior.workId !== undefined && prior.sessionId !== input.sessionId) throw new LongAgentRequestConflict("后台工作请求不能改投其他会话");
      if (input.topicNode !== undefined) {
        // A node retry replays the same acceptance. The client never sends a sessionId for a node round,
        // so the frozen node target and the durable binding are compared — never a sessionId that the
        // caller cannot supply.
        const priorBinding = (await readLongAgentState(home)).nodeSessions.find((entry) => entry.sessionId === prior.sessionId);
        if (priorBinding === undefined || priorBinding.topicId !== input.topicNode.topicId || priorBinding.nodeId !== input.topicNode.nodeId
          || prior.topicNode?.topicId !== input.topicNode.topicId || prior.topicNode?.nodeId !== input.topicNode.nodeId)
          throw new LongAgentRequestConflict("节点轮次不能改投其他主题节点");
      } else if (input.sessionId !== undefined && prior.sessionId !== input.sessionId)
        throw new LongAgentRequestConflict("同一requestId不能改投其他会话");
      if (!payloadHashCandidates.includes(prior.payloadHash)) throw new LongAgentRequestConflict("同一requestId包含不同消息或项目，不能重复接受");
      return { ...prior, newAcceptance: false };
    }
    const agent = (await readLongAgentRegistry(home)).agents.find((candidate) => candidate.id === input.longAgentId && candidate.enabled && candidate.status !== "archived");
    if (agent === undefined) throw new Error(`找不到可用LongAgent: ${input.longAgentId}`);
    if (input.summaryDraft && !await hasFriendDailyActivity(home, agent)) throw new Error("今日没有可整理活动，不创建空会话");
    const calendar = await ensureAgentCalendar(agent, home);
    const acceptedAt = new Date();
    if (work && work.contextProjectId !== contextProjectId) throw new Error("后台工作的项目已固定，请在原项目继续或创建新工作");
    let nodeSessionId: string | undefined;
    if (input.topicNode !== undefined) {
      // A node turn never selects by daily index or requester claim: the caller names the topic and
      // the node, and the graph decides which session that node runs in.
      if (input.sessionId !== undefined) throw new LongAgentRequestConflict("节点轮次不能同时携带 sessionId");
      const { readTopicGraph } = await import("./topics.js");
      const node = (await readTopicGraph(home, input.longAgentId)).nodes.find((candidate) => candidate.nodeId === input.topicNode!.nodeId);
      if (node === undefined) throw new Error(`主题节点不存在：${input.topicNode!.nodeId}`);
      if (node.topicId !== input.topicNode!.topicId) throw new Error(`节点不属于该主题：${input.topicNode!.topicId}`);
      nodeSessionId = node.sessionId;
    }
    const located = work ? { isNewSession: !(await readLongAgentState(home)).turns.some(t => t.workId === work.id),
      day: { sessionId: work.sessionId, date: agentDate(calendar.timeZone), summary: { status: "pending" } } }
      : await ensureProjectLongAgent({ chatHome: home, projectId: input.projectId, agent, now: acceptedAt,
      ...(source !== "chat-web" || input.sessionId === undefined ? {} : { requestedSessionId: input.sessionId }),
      ...(nodeSessionId === undefined && input.topicNode === undefined ? {} : { topicNode: { ...input.topicNode!, sessionId: nodeSessionId! } }) });
    if (located.day.summary.status === "running") throw new Error("该日期正在收尾，请稍后重试；原历史保留");
    const chatSession = await openChatSession({ projectId: agent.id, chatHome: home, sessionId: located.day.sessionId });
    const memory = SessionManager.inMemory(chatSession.cwd);
    // The temporary Session is solely an assembly preview; only its custom snapshots are retained.
    const turnId = `${source}:${agent.id}:${requestId}`;
    const group = await readLongAgentAgentGroup(agent.id, home);
    const prepared = await prepareLongAgentAssembly({ agent, chatHome: home, projectId: contextProjectId, turnId, groupContext: group, today: located.day.date });
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
        // The node binding lands in the SAME write as the turn it serves: the state never holds a turn
        // whose node session has no binding, and never a binding without a cause.
        let nodeSessions = state.nodeSessions;
        if (input.topicNode !== undefined) {
          const binding = { longAgentId: agent.id, sessionId: located.day.sessionId, topicId: input.topicNode.topicId,
            nodeId: input.topicNode.nodeId, createdAt: acceptedAt.toISOString() };
          nodeSessions = [...state.nodeSessions.filter((entry) => entry.sessionId !== binding.sessionId), binding];
        }
        if (work) {
          const active = new Set(state.turns.filter(t => t.longAgentId === agent.id && t.workId && ["queued", "running"].includes(t.status)).map(t => t.workId));
          if (!active.has(work.id) && active.size >= 4) throw new Error("此Friend已有4项后台工作，请等待完成或取消后重试");
        }
        const turn: AcceptedTurn = { ...(work ? { workId: work.id } : {}), ...(input.topicNode === undefined ? {} : { topicNode: { topicId: input.topicNode.topicId, nodeId: input.topicNode.nodeId } }), turnId, requestId, payloadHash, isNewSession: located.isNewSession, summaryDraft: input.summaryDraft ?? false, longAgentId: agent.id, source,
          channelType: input.channelType ?? (source === "chat-web" ? "chat-web" : null), inboundEventId: input.inboundEventId ?? null,
          contextProjectId, interactionRevision, payloadHashVersion: 3, sessionId: located.day.sessionId, date: located.day.date, timeZone: calendar.timeZone,
          acceptedAt: acceptedAt.toISOString(), sequence: state.turns.reduce((max, item) => Math.max(max, item.sequence), 0) + 1,
          status: "queued", error: null, text: input.text as string, ...(input.images === undefined ? {} : { images: input.images }), seed,
          groupContext: agentGroupContextRevisionOf(group) };
        return { state: { ...state, turns: [...state.turns, turn], nodeSessions,
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
  const terminal = status === "completed" || status === "failed" || status === "interrupted" || status === "cancelled";
  const settledAt = terminal ? new Date().toISOString() : null;
  await updateLongAgentState(home, (state) => ({ state: { ...state, turns: state.turns.map((turn) => {
    if (turn.turnId !== turnId) return turn;
    if (status === "completed" || status === "cancelled") {
      const { text: _text, images: _images, seed: _seed, ...receipt } = turn;
      return { ...receipt, status, settledAt, error };
    }
    return { ...turn, status, settledAt, error };
  }) }, result: undefined }));
}

/** Each native Session has one ordered worker; one identity may have independent work in parallel. */
export function drainLongAgentTurns(home: string, longAgentId: string, sessionId?: string): Promise<void> {
  if (sessionId === undefined) return readLongAgentState(home).then(async state => {
    const sessions = new Set(state.turns.filter(t => t.longAgentId === longAgentId && ["queued", "running"].includes(t.status)).map(t => t.sessionId));
    await Promise.all([...sessions].map(id => drainLongAgentTurns(home, longAgentId, id)));
  });
  const queueKey = key(home, `${longAgentId}/${sessionId}`);
  const existing = drains.get(queueKey); if (existing !== undefined) return existing;
  const run = (async () => {
    const { executeAcceptedLongAgentTurn } = await import("./runtime.js");
    const { recoverLongAgentTurns } = await import("./daily-maintenance.js");
    await recoverLongAgentTurns(home, sessionId);
    while (true) {
      const turn = (await readLongAgentState(home)).turns.filter((item) => item.longAgentId === longAgentId && item.sessionId === sessionId && item.status === "queued").sort((a, b) => a.sequence - b.sequence)[0];
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
      finally {
        loaders.delete(key(home, turn.turnId));
        // Return delivery waits for the origin lock independently; never hold up this worker.
        void import("./work.js").then(m => m.deliverFriendWorkReturns(home)).catch(error => console.error("后台工作结果待返回", error));
      }
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
    await drainLongAgentTurns(home, input.longAgentId, turn.sessionId);
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

export function isFriendWorkerActive(home: string, longAgentId: string, sessionId?: string): boolean {
  return sessionId === undefined ? [...drains.keys()].some(id => id.startsWith(key(home, `${longAgentId}/`)))
    : drains.has(key(home, `${longAgentId}/${sessionId}`));
}

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
      if (action === "retry") return { ...item, cancelRequested: false, status: "queued" as const, settledAt: null, error: null };
      const { text: _text, images: _images, seed: _seed, ...receipt } = item;
      loaders.delete(key(home, turnId));
      return { ...receipt, status: "cancelled" as const, settledAt: new Date().toISOString(), error: null };
    }) }, result: undefined };
  });
  if (action === "retry") await drainLongAgentTurns(home, longAgentId);
}
