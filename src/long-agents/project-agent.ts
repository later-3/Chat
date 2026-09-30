import { SessionManager } from "@earendil-works/pi-coding-agent";
import { stat } from "node:fs/promises";
import { openChatSession } from "../chat-session.js";
import { ensureAgentHomeProject, resolveProjectContext } from "../projects/registry.js";
import { readLongAgentState, updateLongAgentRegistry, updateLongAgentState } from "./storage.js";
import { findActiveSessionFile } from "../session-files.js";
import { agentDate, validateCalendarDate, validateTimeZone } from "./calendar.js";
import type { DailySession } from "./daily-state.js";
import type { LongAgentConfig, ProjectLongAgent } from "./types.js";
import { additionalSessionDay, createAdditionalSession, discoverAdditionalSessions } from "./direct-sessions.js";

export function projectLongAgentId(projectId: string, longAgentId: string): string {
  return `project-long-agent:${projectId}:${longAgentId}`;
}
export async function ensureAgentCalendar(agent: LongAgentConfig, chatHome: string): Promise<LongAgentConfig & { timeZone: string }> {
  if (agent.timeZone !== undefined) return { ...agent, timeZone: validateTimeZone(agent.timeZone) };
  return updateLongAgentRegistry(chatHome, (registry) => {
    const current = registry.agents.find((entry) => entry.id === agent.id);
    if (current === undefined) throw new Error("Friend已不存在");
    const updated = { ...current, timeZone: current.timeZone ?? validateTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone) };
    return { registry: { ...registry, agents: registry.agents.map((entry) => entry.id === agent.id ? updated : entry) }, result: updated };
  });
}

/** Only an exact migration receipt into this Friend's own Home may resume as that Friend. */
async function openLegacyHomeSession(chatHome: string, longAgentId: string, sessionId: string) {
  const { readLegacyFriendSessions } = await import("../migrations/agent-home-normalization.js");
  const owned = (await readLegacyFriendSessions(chatHome)).some(entry => entry.longAgentId === longAgentId
    && entry.targetProjectId === longAgentId && entry.sessionId === sessionId);
  return owned ? openChatSession({ chatHome, projectId: longAgentId, sessionId }) : undefined;
}

/** Compatibility input projectId is validated; every new direct conversation belongs to Agent Home. */
export async function ensureProjectLongAgent(input: {
  readonly chatHome: string; readonly projectId: string; readonly agent: LongAgentConfig;
  readonly requestedSessionId?: string;
  readonly createRequestId?: string;
  /** Explicit calendar creation/opening. Date groups the Session; it never backdates messages or schedules execution. */
  readonly date?: string;
  /**
   * Topic node target for an owner-confirmed node round. Verified against the topic graph: the trio
   * must reference each other exactly. The primary-Session binding is only read, never rewritten.
   */
  readonly topicNode?: { readonly topicId: string; readonly nodeId: string; readonly sessionId?: string };
  readonly now?: Date;
}): Promise<{ readonly projectAgent: ProjectLongAgent; readonly isNewSession: boolean; readonly day: DailySession }> {
  await resolveProjectContext(input.projectId, input.chatHome);
  const agent = await ensureAgentCalendar(input.agent, input.chatHome);
  const own = await ensureAgentHomeProject(agent.id, agent.name, input.chatHome);
  const now = input.now ?? new Date();
  const today = agentDate(agent.timeZone, now);
  if (input.date !== undefined && (input.requestedSessionId !== undefined || input.topicNode !== undefined)) throw new Error("日历日期不能与另一会话目标同时指定");
  let date = input.date === undefined ? today : validateCalendarDate(input.date);
  if (input.createRequestId !== undefined) {
    if (input.requestedSessionId !== undefined || input.topicNode !== undefined) throw new Error("新建会话不能同时指定已有目标");
    const result = await createAdditionalSession({ project: own, name: agent.name, requestId: input.createRequestId,
      date, explicitDate: input.date !== undefined, timeZone: agent.timeZone, now });
    return { ...result, projectAgent: { id: projectLongAgentId(own.projectId, agent.id), projectId: own.projectId,
      longAgentId: agent.id, primarySessionId: result.day.sessionId, sessionDate: result.day.date, status: "active",
      createdAt: result.day.createdAt, updatedAt: result.day.createdAt } };
  }
  // READ-ONLY FAST PATH: the requested Session and its binding exist and the file is really there, so
  // opening the same Friend again must not bump `updatedAt` or rewrite the whole state file. Only the
  // "nothing to change" case short-circuits; first creation, a new day and every repair still go through
  // the protected write path below.
  if (input.topicNode === undefined) {
    const settled = await readLongAgentState(input.chatHome);
    const existingAgent = settled.projectAgents.find((candidate) => candidate.projectId === own.projectId && candidate.longAgentId === agent.id);
    if (input.requestedSessionId !== undefined) {
      const additional = settled.additionalSessions.find(session => session.longAgentId === agent.id && session.sessionId === input.requestedSessionId);
      if (additional !== undefined) {
        await openChatSession({ chatHome: input.chatHome, projectId: own.projectId, sessionId: additional.sessionId });
        return { projectAgent: { id: projectLongAgentId(own.projectId, agent.id), projectId: own.projectId,
          longAgentId: agent.id, primarySessionId: additional.sessionId, sessionDate: additional.date, status: "active",
          createdAt: additional.createdAt, updatedAt: additional.createdAt }, day: additionalSessionDay(additional), isNewSession: false };
      }
      const requested = settled.dailySessions.find(day => day.longAgentId === agent.id && day.sessionId === input.requestedSessionId);
      if (requested === undefined) {
        const legacy = await openLegacyHomeSession(input.chatHome, agent.id, input.requestedSessionId);
        if (legacy === undefined) throw new Error("该Session不属于此Friend的日常会话，不能接管普通或其他Friend的会话");
        const createdAt = legacy.manager.getHeader()!.timestamp;
        const legacyDate = agentDate(agent.timeZone, new Date(createdAt));
        return { projectAgent: { id: projectLongAgentId(own.projectId, agent.id), projectId: own.projectId,
          longAgentId: agent.id, primarySessionId: input.requestedSessionId, sessionDate: legacyDate,
          status: "active", createdAt, updatedAt: createdAt }, isNewSession: false,
          day: { longAgentId: agent.id, sessionId: input.requestedSessionId, date: legacyDate, timeZone: agent.timeZone, createdAt,
            summary: { status: "pending", attempts: 0, cutoff: null, entryId: null, nextAttemptAt: null, error: null, revision: null } } };
      }
      date = requested.date;
    }
    const settledDay = settled.dailySessions.find((candidate) => candidate.longAgentId === agent.id && candidate.date === date);
    if (settledDay !== undefined && (date !== today || (existingAgent?.sessionDate === today && settledDay.sessionId === existingAgent.primarySessionId))
      && await findActiveSessionFile(own, settledDay.sessionId) !== undefined) {
      return { projectAgent: { id: projectLongAgentId(own.projectId, agent.id), projectId: own.projectId,
        longAgentId: agent.id, primarySessionId: settledDay.sessionId, sessionDate: date, status: "active",
        createdAt: existingAgent?.createdAt ?? settledDay.createdAt, updatedAt: existingAgent?.updatedAt ?? settledDay.createdAt },
        isNewSession: false, day: settledDay };
    }
  }
  return updateLongAgentState(input.chatHome, async (state) => {
    // A topic node target bypasses today's index entirely: it is verified against the topic graph and
    // only located, never registered as today's Session or primary binding.
    if (input.topicNode !== undefined) {
      const { readTopicGraph } = await import("./topics.js");
      const graph = await readTopicGraph(input.chatHome, agent.id);
      const node = graph.nodes.find((candidate) => candidate.nodeId === input.topicNode!.nodeId);
      if (node === undefined) throw new Error(`主题节点不存在：${input.topicNode!.nodeId}`);
      if (node.topicId !== input.topicNode!.topicId) throw new Error(`节点不属于该主题：${input.topicNode!.topicId}`);
      await openChatSession({ projectId: agent.id, chatHome: input.chatHome, sessionId: node.sessionId });
      const existing = state.projectAgents.find((candidate) => candidate.projectId === own.projectId && candidate.longAgentId === agent.id);
      // The binding is only read: when no primary Session exists yet the location stands on its own
      // (defined without an optional field touching the contract, and never written back).
      const projectAgent: ProjectLongAgent = existing ?? { id: projectLongAgentId(own.projectId, agent.id), projectId: own.projectId,
        longAgentId: agent.id, primarySessionId: node.sessionId, sessionDate: today,
        status: "active", createdAt: now.toISOString(), updatedAt: now.toISOString() };
      return { state, result: { projectAgent, isNewSession: false as const,
        day: { longAgentId: agent.id, date: today, timeZone: agent.timeZone, sessionId: node.sessionId, createdAt: now.toISOString(),
          summary: { status: "pending" as const, attempts: 0, cutoff: null, entryId: null, nextAttemptAt: null, error: null, revision: null } } } };
    }
    const existing = state.projectAgents.find((candidate) => candidate.projectId === own.projectId && candidate.longAgentId === agent.id);
    const dailySessions = [...state.dailySessions];
    if (existing?.sessionDate !== undefined && !dailySessions.some((entry) => entry.longAgentId === agent.id && entry.date === existing.sessionDate)) {
      await openChatSession({ projectId: own.projectId, chatHome: input.chatHome, sessionId: existing.primarySessionId });
      dailySessions.push({ longAgentId: agent.id, date: existing.sessionDate, timeZone: agent.timeZone, sessionId: existing.primarySessionId, createdAt: existing.createdAt,
        summary: { status: "pending", attempts: 0, cutoff: null, entryId: null, nextAttemptAt: null, error: null, revision: null } });
    }
    let day = dailySessions.find((candidate) => candidate.longAgentId === agent.id && candidate.date === date);
    let isNewSession = false;
    if (day === undefined) {
      // Recover a native day marker left by a crash before the index commit.
      const candidates = (await SessionManager.listAll(own.sessionDir)).filter((info) => {
        const entries = SessionManager.open(info.path, own.sessionDir).getEntries();
        return entries.some((entry) => entry.type === "custom" && entry.customType === "chat.long-agent-day.v1"
          && typeof entry.data === "object" && entry.data !== null && "longAgentId" in entry.data && entry.data.longAgentId === agent.id
          && "date" in entry.data && entry.data.date === date);
      });
      if (candidates.length > 1) throw new Error("同一Friend日期存在多个原生Session，须修复索引，不能合并历史");
      const sessionId = candidates[0]?.id;
      if (input.requestedSessionId !== undefined && input.requestedSessionId !== sessionId) throw new Error("Friend会话绑定不匹配");
      const session = await openChatSession({ projectId: own.projectId, chatHome: input.chatHome, ...(sessionId === undefined ? {} : { sessionId }) });
      if (sessionId === undefined) session.manager.appendSessionInfo(`${agent.name} · ${date}`);
      isNewSession = sessionId === undefined;
      day = { longAgentId: agent.id, date, timeZone: agent.timeZone, sessionId: session.manager.getSessionId(), createdAt: now.toISOString(),
        summary: { status: "pending", attempts: 0, cutoff: null, entryId: null, nextAttemptAt: null, error: null, revision: null } };
      session.manager.appendCustomEntry("chat.long-agent-day.v1", { schemaVersion: 1, longAgentId: agent.id, date, timeZone: agent.timeZone });
      session.manager.flush();
      dailySessions.push(day);
    }
    if (input.requestedSessionId !== undefined && input.requestedSessionId !== day.sessionId) {
      throw new Error("Friend会话绑定不匹配");
    }
    await openChatSession({ projectId: own.projectId, chatHome: input.chatHome, sessionId: day.sessionId });
    const stamp = now.toISOString();
    const projectAgent: ProjectLongAgent = { id: projectLongAgentId(own.projectId, agent.id), projectId: own.projectId, longAgentId: agent.id,
      primarySessionId: day.sessionId, sessionDate: date, status: "active", createdAt: existing?.createdAt ?? stamp, updatedAt: stamp };
    return { state: { ...state,
      // An explicit past/future date never changes the default "chat with Friend" target.
      projectAgents: date === today ? [...state.projectAgents.filter((entry) => entry.id !== projectAgent.id), projectAgent] : state.projectAgents,
      dailySessions,
    }, result: { projectAgent, isNewSession, day } };
  });
}

/** Resolve an already accepted day without ever rotating it at execution time. */
export async function openAcceptedDay(chatHome: string, longAgentId: string, sessionId: string): Promise<ProjectLongAgent> {
  const state = await readLongAgentState(chatHome);
  const day = [...state.dailySessions, ...state.additionalSessions].find((item) => item.longAgentId === longAgentId && item.sessionId === sessionId);
  if (day !== undefined) {
    return { id: projectLongAgentId(longAgentId, longAgentId), projectId: longAgentId, longAgentId, primarySessionId: sessionId,
      sessionDate: day.date, status: "active", createdAt: day.createdAt, updatedAt: day.createdAt };
  }
  // Topic node sessions are not daily sessions: their authority lives in the matching node binding.
  const node = state.nodeSessions.find((item) => item.longAgentId === longAgentId && item.sessionId === sessionId);
  if (node === undefined) {
    const legacy = await openLegacyHomeSession(chatHome, longAgentId, sessionId);
    if (legacy === undefined) throw new Error("已接受请求的目标Session不在每日记录、节点绑定或已核实Home历史中");
    const createdAt = legacy.manager.getHeader()!.timestamp;
    return { id: projectLongAgentId(longAgentId, longAgentId), projectId: longAgentId, longAgentId,
      primarySessionId: sessionId, sessionDate: createdAt.slice(0, 10), status: "active", createdAt, updatedAt: createdAt };
  }
  return { id: projectLongAgentId(longAgentId, longAgentId), projectId: longAgentId, longAgentId, primarySessionId: sessionId,
    sessionDate: node.createdAt.slice(0, 10), status: "active", createdAt: node.createdAt, updatedAt: node.createdAt };
}

/** Startup recovery indexes existing Home days only; it never allocates an idle day's Session. */

// The per-minute maintenance tick calls this for every Friend. A full rescan parses every session
// file in the Friend's directory (large history files included) and rewrites the whole state file
// even when nothing changed, which stalls the event loop for ~1s each minute. The scan result is a
// pure function of the directory contents, so an unchanged file fingerprint (id + mtime + size)
// means the previous scan already indexed exactly these files and the pass can be skipped.
const calendarScanFingerprints = new Map<string, string>();

async function calendarScanFingerprint(sessionDir: string): Promise<string> {
  const entries = await Promise.all((await SessionManager.listAll(sessionDir)).map(async (info) => {
    const file = await stat(info.path).catch(() => undefined);
    return file === undefined ? null : `${info.id}:${file.mtimeMs}:${file.size}`;
  }));
  return entries.filter((entry) => entry !== null).sort().join("|");
}

export async function recoverFriendCalendar(chatHome: string, agent: LongAgentConfig & { timeZone: string }): Promise<void> {
  const own = await ensureAgentHomeProject(agent.id, agent.name, chatHome);
  const bindingFingerprint = (state: Awaited<ReturnType<typeof readLongAgentState>>) => JSON.stringify([
    state.dailySessions.filter(day => day.longAgentId === agent.id).map(day => [day.date, day.sessionId]),
    state.additionalSessions.filter(session => session.longAgentId === agent.id),
  ]);
  const filesFingerprint = await calendarScanFingerprint(own.sessionDir);
  const fingerprint = filesFingerprint + bindingFingerprint(await readLongAgentState(chatHome));
  const cacheKey = `${chatHome}\0${agent.id}`;
  if (calendarScanFingerprints.get(cacheKey) === fingerprint) return;
  await updateLongAgentState(chatHome, async (state) => {
    const days = [...state.dailySessions];
    const add = (date: string, timeZone: string, sessionId: string, createdAt: string) => {
      const existing = days.find((entry) => entry.longAgentId === agent.id && entry.date === date);
      if (existing !== undefined) {
        if (existing.sessionId !== sessionId) throw new Error("同一Friend日期存在多个Session，请修复索引，不能合并历史");
        return;
      }
      days.push({ longAgentId: agent.id, date, timeZone, sessionId, createdAt,
        summary: { status: "pending", attempts: 0, cutoff: null, entryId: null, nextAttemptAt: null, error: null, revision: null } });
    };
    const legacy = state.projectAgents.find((entry) => entry.projectId === own.projectId && entry.longAgentId === agent.id);
    if (legacy?.sessionDate !== undefined) add(legacy.sessionDate, agent.timeZone, legacy.primarySessionId, legacy.createdAt);
    for (const info of await SessionManager.listAll(own.sessionDir)) {
      for (const entry of SessionManager.open(info.path, own.sessionDir).getEntries()) {
        if (entry.type !== "custom" || entry.customType !== "chat.long-agent-day.v1") continue;
        const data = entry.data;
        if (typeof data !== "object" || data === null || !("longAgentId" in data) || data.longAgentId !== agent.id
          || !("date" in data) || typeof data.date !== "string" || !("timeZone" in data)) throw new Error("原生日历标记无效");
        add(data.date, validateTimeZone(data.timeZone), info.id, entry.timestamp);
      }
    }
    const additionalSessions = [...state.additionalSessions];
    for (const binding of await discoverAdditionalSessions(own)) {
      const previous = additionalSessions.find(item => item.longAgentId === agent.id && item.requestId === binding.requestId);
      if (previous && JSON.stringify(previous) !== JSON.stringify(binding)) throw new Error("额外会话索引与原生绑定冲突");
      if (!previous) additionalSessions.push(binding);
    }
    return { state: { ...state, dailySessions: days, additionalSessions }, result: undefined };
  });
  calendarScanFingerprints.set(cacheKey, filesFingerprint + bindingFingerprint(await readLongAgentState(chatHome)));
}

/** A timer alone is not daily activity. Do not allocate a Session just to summarize nothing. */
export async function hasFriendDailyActivity(chatHome: string, agent: LongAgentConfig): Promise<boolean> {
  const calendar = await ensureAgentCalendar(agent, chatHome);
  const today = agentDate(calendar.timeZone);
  const state = await readLongAgentState(chatHome);
  const day = state.dailySessions.find((entry) => entry.longAgentId === agent.id && entry.date === today);
  const sessionId = day?.sessionId ?? state.projectAgents.find((entry) => entry.projectId === agent.id && entry.longAgentId === agent.id && entry.sessionDate === today)?.primarySessionId;
  if (sessionId === undefined) return false;
  if (state.turns.some((turn) => turn.sessionId === sessionId && !turn.summaryDraft && turn.status !== "cancelled")) return true;
  const session = await openChatSession({ projectId: agent.id, chatHome, sessionId });
  return session.manager.getEntries().some((entry) => entry.type === "message" && entry.message.role === "user");
}
