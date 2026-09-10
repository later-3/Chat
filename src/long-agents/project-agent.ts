import { openChatSession, reserveChatSession } from "../chat-session.js";
import { agentHomeProjectId, resolveProjectContext } from "../projects/registry.js";
import { updateLongAgentState } from "./storage.js";
import type { LongAgentConfig, ProjectLongAgent } from "./types.js";

/** 本地日历日期（YYYY-MM-DD）；Agent 时区配置是后续项。 */
function localDate(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function projectLongAgentId(projectId: string, longAgentId: string): string {
  return `project-long-agent:${projectId}:${longAgentId}`;
}

export async function ensureProjectLongAgent(input: {
  readonly chatHome: string;
  readonly projectId: string;
  readonly agent: LongAgentConfig;
  readonly requestedSessionId?: string;
}): Promise<{ readonly projectAgent: ProjectLongAgent; readonly isNewSession: boolean }> {
  await resolveProjectContext(input.projectId, input.chatHome);
  return updateLongAgentState<{
    readonly projectAgent: ProjectLongAgent;
    readonly isNewSession: boolean;
  }>(input.chatHome, async (state) => {
    const existing = state.projectAgents.find((candidate) => candidate.projectId === input.projectId
      && candidate.longAgentId === input.agent.id);
    // S5：Agent 独立 Daily Project 的日常主 Session 按日轮换；历史 Session 原位保留。
    if (existing !== undefined && input.projectId === agentHomeProjectId(input.agent.id)) {
      const today = localDate();
      if (existing.sessionDate === today) {
        // 当天复用。
      } else {
        const reserved = await reserveChatSession(
          { projectId: input.projectId, chatHome: input.chatHome },
          `${input.agent.name} · ${today}`,
        );
        const rotated: ProjectLongAgent = {
          ...existing,
          primarySessionId: reserved.manager.getSessionId(),
          sessionDate: today,
          status: "active",
          updatedAt: new Date().toISOString(),
        };
        return {
          state: {
            ...state,
            projectAgents: state.projectAgents.map((candidate) => (
              candidate.id === rotated.id ? rotated : candidate
            )),
          },
          result: { projectAgent: rotated, isNewSession: true },
        };
      }
    }
    if (existing !== undefined) {
      if (input.requestedSessionId !== undefined && input.requestedSessionId !== existing.primarySessionId) {
        throw new Error(
          `Long Agent ${input.agent.name}在Project ${input.projectId}已有专属Session ${existing.primarySessionId}；普通Session不能被隐式接管`,
        );
      }
      await openChatSession({
        projectId: existing.projectId,
        chatHome: input.chatHome,
        sessionId: existing.primarySessionId,
      });
      const active = existing.status === "active"
        ? existing
        : { ...existing, status: "active" as const, updatedAt: new Date().toISOString() };
      return {
        state: active === existing
          ? state
          : { ...state, projectAgents: state.projectAgents.map((candidate) => candidate.id === active.id ? active : candidate) },
        result: { projectAgent: active, isNewSession: false },
      };
    }
    if (input.requestedSessionId !== undefined) {
      throw new Error(`Long Agent ${input.agent.name}尚未在Project ${input.projectId}启动，不能接管已有普通Session`);
    }
    const isDaily = input.projectId === agentHomeProjectId(input.agent.id);
    const reserved = await reserveChatSession(
      { projectId: input.projectId, chatHome: input.chatHome },
      isDaily ? `${input.agent.name} · ${localDate()}` : `${input.agent.name} · 专属会话`,
    );
    const now = new Date().toISOString();
    const projectAgent: ProjectLongAgent = {
      id: projectLongAgentId(input.projectId, input.agent.id),
      projectId: input.projectId,
      longAgentId: input.agent.id,
      primarySessionId: reserved.manager.getSessionId(),
      status: "active",
      ...(isDaily ? { sessionDate: localDate() } : {}),
      createdAt: now,
      updatedAt: now,
    };
    return {
      state: { ...state, projectAgents: [...state.projectAgents, projectAgent] },
      result: { projectAgent, isNewSession: true },
    };
  });
}
