import {
  agentDailyProjectId,
  DAILY_PROJECT_ID,
  ensureAgentDailyProject,
} from "../projects/registry.js";
import { ensureProjectLongAgent, projectLongAgentId } from "./project-agent.js";
import { updateLongAgentRegistry, updateLongAgentState } from "./storage.js";
import type { LongAgentConfig } from "./types.js";

/**
 * 确保 Long Agent 拥有独立的 Daily Project（管理架构 S3）。
 * 存量共享 `daily` 的 Agent 在这里一次性迁移归属：创建 `daily-<longAgentId>`
 * Project 与 Managed Workspace，把 Registry 的 defaultProjectId 指向它，建立当日
 * 主 Session，并把指向旧共享 daily 绑定的通道会话重定向到新绑定——否则 Telegram 等
 * 入口会永远路由到旧会话。历史 Session 保留在原 Project，不搬运。
 * 用户显式改过默认项目的 Agent 不动。
 */
export async function ensureLongAgentDailyProject(
  agent: LongAgentConfig,
  chatHome: string,
): Promise<string> {
  const target = agentDailyProjectId(agent.id);
  if (agent.defaultProjectId !== DAILY_PROJECT_ID && agent.defaultProjectId !== target) {
    return agent.defaultProjectId;
  }
  await ensureAgentDailyProject(agent.id, agent.name, chatHome);
  let migrated = agent;
  if (agent.defaultProjectId !== target) {
    await updateLongAgentRegistry(chatHome, (registry) => ({
      registry: {
        ...registry,
        agents: registry.agents.map((candidate) => (
          candidate.id === agent.id ? { ...candidate, defaultProjectId: target } : candidate
        )),
      },
      result: undefined,
    }));
    migrated = { ...agent, defaultProjectId: target };
  }
  // 建立新 Daily Project 的当日主 Session，并重定向旧共享 daily 的通道绑定。
  const { projectAgent } = await ensureProjectLongAgent({
    chatHome,
    projectId: target,
    agent: migrated,
  });
  const legacyBindingId = projectLongAgentId(DAILY_PROJECT_ID, agent.id);
  if (legacyBindingId !== projectAgent.id) {
    await updateLongAgentState(chatHome, (state) => ({
      state: {
        ...state,
        bindings: state.bindings.map((binding) => (
          binding.projectLongAgentId === legacyBindingId
            ? { ...binding, projectLongAgentId: projectAgent.id, updatedAt: new Date().toISOString() }
            : binding
        )),
      },
      result: undefined,
    }));
  }
  return target;
}
