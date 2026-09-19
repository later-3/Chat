import { SessionManager } from "@earendil-works/pi-coding-agent";
import { openChatSession } from "../chat-session.js";
import { ensureAgentHomeProject, resolveProjectContext } from "../projects/registry.js";
import { readLongAgentState, updateLongAgentRegistry, updateLongAgentState } from "./storage.js";
import { agentDate, validateTimeZone } from "./calendar.js";
import type { DailySession } from "./daily-state.js";
import type { LongAgentConfig, ProjectLongAgent } from "./types.js";

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

/** Compatibility input projectId is validated; every new direct conversation belongs to Agent Home. */
export async function ensureProjectLongAgent(input: {
  readonly chatHome: string; readonly projectId: string; readonly agent: LongAgentConfig;
  readonly requestedSessionId?: string; readonly now?: Date;
}): Promise<{ readonly projectAgent: ProjectLongAgent; readonly isNewSession: boolean; readonly day: DailySession }> {
  await resolveProjectContext(input.projectId, input.chatHome);
  const agent = await ensureAgentCalendar(input.agent, input.chatHome);
  const own = await ensureAgentHomeProject(agent.id, agent.name, input.chatHome);
  const now = input.now ?? new Date();
  const today = agentDate(agent.timeZone, now);
  return updateLongAgentState(input.chatHome, async (state) => {
    const existing = state.projectAgents.find((candidate) => candidate.projectId === own.projectId && candidate.longAgentId === agent.id);
    const dailySessions = [...state.dailySessions];
    if (existing?.sessionDate !== undefined && !dailySessions.some((entry) => entry.longAgentId === agent.id && entry.date === existing.sessionDate)) {
      await openChatSession({ projectId: own.projectId, chatHome: input.chatHome, sessionId: existing.primarySessionId });
      dailySessions.push({ longAgentId: agent.id, date: existing.sessionDate, timeZone: agent.timeZone, sessionId: existing.primarySessionId, createdAt: existing.createdAt,
        summary: { status: "pending", attempts: 0, cutoff: null, entryId: null, nextAttemptAt: null, error: null, revision: null } });
    }
    let day = dailySessions.find((candidate) => candidate.longAgentId === agent.id && candidate.date === today);
    let isNewSession = false;
    if (day === undefined) {
      // Recover a native day marker left by a crash before the index commit.
      const candidates = (await SessionManager.listAll(own.sessionDir)).filter((info) => {
        const entries = SessionManager.open(info.path, own.sessionDir).getEntries();
        return entries.some((entry) => entry.type === "custom" && entry.customType === "chat.long-agent-day.v1"
          && typeof entry.data === "object" && entry.data !== null && "longAgentId" in entry.data && entry.data.longAgentId === agent.id
          && "date" in entry.data && entry.data.date === today);
      });
      if (candidates.length > 1) throw new Error("同一Friend日期存在多个原生Session，须修复索引，不能合并历史");
      const sessionId = candidates[0]?.id;
      if (input.requestedSessionId !== undefined && input.requestedSessionId !== sessionId) throw new Error("该Session不是Friend今天的会话；历史保持只读，请在今天继续，普通Session不能被接管");
      const session = await openChatSession({ projectId: own.projectId, chatHome: input.chatHome, ...(sessionId === undefined ? {} : { sessionId }) });
      if (sessionId === undefined) session.manager.appendSessionInfo(`${agent.name} · ${today}`);
      isNewSession = sessionId === undefined;
      day = { longAgentId: agent.id, date: today, timeZone: agent.timeZone, sessionId: session.manager.getSessionId(), createdAt: now.toISOString(),
        summary: { status: "pending", attempts: 0, cutoff: null, entryId: null, nextAttemptAt: null, error: null, revision: null } };
      session.manager.appendCustomEntry("chat.long-agent-day.v1", { schemaVersion: 1, longAgentId: agent.id, date: today, timeZone: agent.timeZone });
      session.manager.flush();
      dailySessions.push(day);
    }
    if (input.requestedSessionId !== undefined && input.requestedSessionId !== day.sessionId) {
      throw new Error("该Session不是Friend今天的会话；历史保持只读，请通过开始聊天在今天继续，普通Session不能被接管");
    }
    await openChatSession({ projectId: own.projectId, chatHome: input.chatHome, sessionId: day.sessionId });
    const stamp = now.toISOString();
    const projectAgent: ProjectLongAgent = { id: projectLongAgentId(own.projectId, agent.id), projectId: own.projectId, longAgentId: agent.id,
      primarySessionId: day.sessionId, sessionDate: today, status: "active", createdAt: existing?.createdAt ?? stamp, updatedAt: stamp };
    return { state: { ...state,
      projectAgents: [...state.projectAgents.filter((entry) => entry.id !== projectAgent.id), projectAgent],
      dailySessions,
    }, result: { projectAgent, isNewSession, day } };
  });
}

/** Resolve an already accepted day without ever rotating it at execution time. */
export async function openAcceptedDay(chatHome: string, longAgentId: string, sessionId: string): Promise<ProjectLongAgent> {
  const state = await readLongAgentState(chatHome);
  const day = state.dailySessions.find((item) => item.longAgentId === longAgentId && item.sessionId === sessionId);
  if (day === undefined) throw new Error("已接受请求的每日Session记录缺失");
  return { id: projectLongAgentId(longAgentId, longAgentId), projectId: longAgentId, longAgentId, primarySessionId: sessionId,
    sessionDate: day.date, status: "active", createdAt: day.createdAt, updatedAt: day.createdAt };
}

/** Startup recovery indexes existing Home days only; it never allocates an idle day's Session. */
export async function recoverFriendCalendar(chatHome: string, agent: LongAgentConfig & { timeZone: string }): Promise<void> {
  const own = await ensureAgentHomeProject(agent.id, agent.name, chatHome);
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
    return { state: { ...state, dailySessions: days }, result: undefined };
  });
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
