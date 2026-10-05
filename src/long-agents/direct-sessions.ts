import { SessionManager } from "@earendil-works/pi-coding-agent";
import { openChatSession } from "../chat-session.js";
import { listActiveSessionFiles } from "../session-files.js";
import type { ChatProjectContext } from "../projects/types.js";
import { parseAdditionalSession, type AdditionalSession, type DailySession } from "./daily-state.js";
import { updateLongAgentState } from "./storage.js";

const DIRECT_SESSION_MARKER = "chat.long-agent-direct.v1";

/** The day-shaped return is a locator for existing acceptance callers, not a daily-default record. */
export function additionalSessionDay(session: AdditionalSession): DailySession {
  return { ...session, summary: { status: "pending", attempts: 0, cutoff: null, entryId: null,
    nextAttemptAt: null, error: null, revision: null } };
}

export async function discoverAdditionalSessions(project: ChatProjectContext): Promise<AdditionalSession[]> {
  const found = new Map<string, AdditionalSession>();
  for (const info of await listActiveSessionFiles(project)) {
    for (const entry of SessionManager.open(info.path, project.sessionDir).getEntries()) {
      if (entry.type !== "custom" || entry.customType !== DIRECT_SESSION_MARKER) continue;
      const binding = parseAdditionalSession(entry.data);
      if (binding.longAgentId !== project.projectId || binding.sessionId !== info.id) throw new Error("额外会话原生绑定归属冲突");
      const previous = found.get(binding.requestId);
      if (previous && JSON.stringify(previous) !== JSON.stringify(binding)) throw new Error("会话创建请求存在多个原生绑定");
      found.set(binding.requestId, binding);
    }
  }
  return [...found.values()];
}

/** Native marker precedes the index, allowing an interrupted creation to be retried by requestId. */
export async function createAdditionalSession(input: {
  project: ChatProjectContext; name: string; requestId: string; date: string; explicitDate: boolean; timeZone: string; now: Date;
}): Promise<{ day: DailySession; isNewSession: boolean }> {
  const { project } = input;
  if (!input.requestId.trim() || input.requestId.trim() !== input.requestId || input.requestId.length > 256) throw new Error("新建会话需要有效requestId");
  return updateLongAgentState(project.chatHome, async state => {
    let binding = state.additionalSessions.find(item => item.longAgentId === project.projectId && item.requestId === input.requestId);
    let isNewSession = false;
    if (binding === undefined) {
      binding = (await discoverAdditionalSessions(project)).find(item => item.requestId === input.requestId);
      if (binding === undefined) {
        const session = await openChatSession({ chatHome: project.chatHome, projectId: project.projectId });
        binding = { longAgentId: project.projectId, sessionId: session.manager.getSessionId(), requestId: input.requestId,
          date: input.date, timeZone: input.timeZone, createdAt: input.now.toISOString() };
        // 会话标题只由用户写：系统不再替用户命名（列表回退到会话第一句话）。
        session.manager.appendCustomEntry(DIRECT_SESSION_MARKER, binding);
        session.manager.flush();
        isNewSession = true;
      }
    }
    if (input.explicitDate && binding.date !== input.date) throw new Error("同一创建requestId不能改变日期");
    // A removed session stays removed; retry is not authorization to resurrect or replace it.
    await openChatSession({ chatHome: project.chatHome, projectId: project.projectId, sessionId: binding.sessionId });
    const saved = binding;
    return { state: state.additionalSessions.some(item => item.sessionId === saved.sessionId) ? state
      : { ...state, additionalSessions: [...state.additionalSessions, saved] },
      result: { day: additionalSessionDay(saved), isNewSession } };
  });
}
