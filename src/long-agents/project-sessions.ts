import { SessionManager } from "@earendil-works/pi-coding-agent";
import { openChatSession } from "../chat-session.js";
import { listActiveSessionFiles } from "../session-files.js";
import { listChatSessions } from "../session-read-model.js";
import { resolveProjectContext } from "../projects/registry.js";
import type { ChatProjectContext } from "../projects/types.js";
import { readLongAgentRegistry, readLongAgentState, updateLongAgentState } from "./storage.js";
import { parseProjectSessionBinding, type ProjectSessionBinding } from "./daily-state.js";

export const PROJECT_SESSION_MARKER = "chat.long-agent-project-session.v1";

/**
 * 项目归属会话（LA→Project→Session 三级导航）：从 Long Agent 绑定项目新建的 Web 会话。
 * 存储归属与每轮执行项目都是该项目（对齐群聊轮次规则）；Agent Home 的每日/额外直接
 * 会话不在此表。创建沿用 additionalSessions 合同：原生标记先行，状态索引随后，同一
 * createRequestId 重试返回同一会话，绝不复制历史。
 */

/** Scan the project's native session files for interrupted creations (marker written, index lost). */
export async function discoverProjectSessions(project: ChatProjectContext, longAgentId: string): Promise<ProjectSessionBinding[]> {
  const found = new Map<string, ProjectSessionBinding>();
  for (const info of await listActiveSessionFiles(project)) {
    for (const entry of SessionManager.open(info.path, project.sessionDir).getEntries()) {
      if (entry.type !== "custom" || entry.customType !== PROJECT_SESSION_MARKER) continue;
      const binding = parseProjectSessionBinding(entry.data);
      if (binding.longAgentId !== longAgentId || binding.projectId !== project.projectId || binding.sessionId !== info.id) {
        throw new Error("项目归属会话原生绑定归属冲突");
      }
      const previous = found.get(binding.requestId);
      if (previous && JSON.stringify(previous) !== JSON.stringify(binding)) throw new Error("会话创建请求存在多个原生绑定");
      found.set(binding.requestId, binding);
    }
  }
  return [...found.values()];
}

export async function createProjectSession(input: {
  readonly chatHome: string;
  readonly longAgentId: string;
  readonly projectId: string;
  readonly requestId: string;
  readonly kind: "independent" | "fork";
  readonly forkedFromSessionId?: string;
  readonly now?: Date;
}): Promise<{ binding: ProjectSessionBinding; isNewSession: boolean }> {
  if (!input.requestId.trim() || input.requestId.trim() !== input.requestId || input.requestId.length > 256) {
    throw new Error("新建会话需要有效requestId");
  }
  if (input.kind === "fork" && (input.forkedFromSessionId === undefined || input.forkedFromSessionId === input.requestId
    || input.forkedFromSessionId === "")) {
    throw new Error("派生会话需要有效的来源Session");
  }
  const registry = await readLongAgentRegistry(input.chatHome);
  const agent = registry.agents.find((candidate) => candidate.id === input.longAgentId);
  if (agent === undefined || agent.status === "archived") throw new Error(`找不到可用LongAgent: ${input.longAgentId}`);
  if (!agent.boundProjectIds.includes(input.projectId)) {
    throw new Error(`项目未绑定到此Long Agent: ${input.projectId}`);
  }
  if (input.projectId === input.longAgentId) {
    throw new Error("Agent Workspace由每日与额外直接会话承载，不能创建项目归属会话");
  }
  const project = await resolveProjectContext(input.projectId, input.chatHome, { ownerLongAgentId: input.longAgentId });
  const now = input.now ?? new Date();
  return updateLongAgentState(input.chatHome, async state => {
    let binding = state.projectSessions.find(item => item.longAgentId === input.longAgentId
      && item.projectId === input.projectId && item.requestId === input.requestId);
    let isNewSession = false;
    if (binding === undefined) {
      binding = (await discoverProjectSessions(project, input.longAgentId)).find(item => item.requestId === input.requestId);
      if (binding === undefined) {
        const session = await openChatSession({ chatHome: input.chatHome, projectId: input.projectId, ownerLongAgentId: input.longAgentId });
        binding = {
          longAgentId: input.longAgentId, projectId: input.projectId, sessionId: session.manager.getSessionId(),
          kind: input.kind, ...(input.forkedFromSessionId === undefined ? {} : { forkedFromSessionId: input.forkedFromSessionId }),
          requestId: input.requestId, createdAt: now.toISOString(),
        };
        // 会话标题只由用户写：系统不再替用户命名（列表回退到会话第一句话）。
        session.manager.appendCustomEntry(PROJECT_SESSION_MARKER, binding);
        session.manager.flush();
        isNewSession = true;
      }
    }
    // A removed session stays removed; retry is not authorization to resurrect or replace it.
    await openChatSession({ chatHome: input.chatHome, projectId: input.projectId, sessionId: binding.sessionId, ownerLongAgentId: input.longAgentId });
    const saved = binding;
    return { state: state.projectSessions.some(item => item.sessionId === saved.sessionId) ? state
      : { ...state, projectSessions: [...state.projectSessions, saved] },
      result: { binding: saved, isNewSession } };
  });
}

/** 服务端推导一个 Long Agent 会话的真实存储项目（项目归属绑定优先，缺省 Agent Home）。 */
export async function storageProjectOfSession(chatHome: string, longAgentId: string, sessionId: string): Promise<string> {
  const binding = (await readLongAgentState(chatHome)).projectSessions
    .find(item => item.longAgentId === longAgentId && item.sessionId === sessionId);
  return binding?.projectId ?? longAgentId;
}

export type ProjectSessionKind = "independent" | "fork" | "daily" | "additional" | "work" | "topic";

export interface ProjectSessionListItem {
  readonly sessionId: string;
  readonly projectId: string;
  readonly kind: ProjectSessionKind;
  readonly forkedFromSessionId: string | null;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string | null;
  readonly messageCount: number;
}

/** 会话第一句话作为标题：折叠换行/控制字符与多余空白，并截断为单行（Pi 列表同款处理）。 */
function normalizeUtteranceTitle(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 50);
}

export async function listProjectSessions(chatHome: string, longAgentId: string, projectId: string): Promise<ProjectSessionListItem[]> {
  const state = await readLongAgentState(chatHome);
  const project = await resolveProjectContext(projectId, chatHome, { ownerLongAgentId: longAgentId });
  const sessions = await listChatSessions(projectId, chatHome, undefined, longAgentId);
  const byId = new Map(sessions.map(session => [session.id, session]));
  /** Workspace（projectId === agent id）承载每日/额外/后台/主题会话；其余项目列项目归属会话。 */
  const candidates: readonly { sessionId: string; kind: ProjectSessionKind; forkedFrom: string | null }[] =
    projectId === longAgentId
      ? [
          ...state.dailySessions.filter(item => item.longAgentId === longAgentId).map(item => ({ sessionId: item.sessionId, kind: "daily" as const, forkedFrom: null })),
          ...state.additionalSessions.filter(item => item.longAgentId === longAgentId).map(item => ({ sessionId: item.sessionId, kind: "additional" as const, forkedFrom: null })),
          ...state.works.filter(item => item.longAgentId === longAgentId).map(item => ({ sessionId: item.sessionId, kind: "work" as const, forkedFrom: null })),
          ...state.nodeSessions.filter(item => item.longAgentId === longAgentId).map(item => ({ sessionId: item.sessionId, kind: "topic" as const, forkedFrom: null })),
        ]
      : state.projectSessions
          .filter(item => item.longAgentId === longAgentId && item.projectId === projectId)
          .map(item => ({ sessionId: item.sessionId, kind: item.kind as ProjectSessionKind, forkedFrom: item.forkedFromSessionId ?? null }));
  if (candidates.length === 0) return [];
  const items: ProjectSessionListItem[] = [];
  for (const candidate of candidates) {
    const session = byId.get(candidate.sessionId);
    // 绑定的会话文件已被删除（用户在项目页移除）时，绑定不再展示；状态在下次写时收敛。
    if (session === undefined) continue;
    items.push({
      sessionId: candidate.sessionId, projectId, kind: candidate.kind,
      forkedFromSessionId: candidate.forkedFrom,
      // 与 Pi 的列表显示一致：控制字符（换行等）折叠为空格，再截断为单行标题。
      title: session.name || normalizeUtteranceTitle(session.firstMessage) || `${project.name} · 新会话`,
      createdAt: session.created,
      updatedAt: session.modified,
      messageCount: session.messageCount,
    });
  }
  return items.sort((a, b) => (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt));
}
