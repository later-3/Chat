import {
  agentDailyProjectId,
  DAILY_PROJECT_ID,
  ensureAgentDailyProject,
} from "../projects/registry.js";
import { updateLongAgentRegistry } from "./storage.js";
import type { LongAgentConfig } from "./types.js";

/**
 * 确保 Long Agent 拥有独立的 Daily Project（管理架构 S3）。
 * 存量共享 `daily` 的 Agent 在这里一次性迁移归属：创建 `daily-<longAgentId>`
 * Project 与 Managed Workspace，并把 Registry 的 defaultProjectId 指向它。
 * 历史 Session 保留在原 Project，不搬运。用户显式改过默认项目的 Agent 不动。
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
  if (agent.defaultProjectId === target) return target;
  await updateLongAgentRegistry(chatHome, (registry) => ({
    registry: {
      ...registry,
      agents: registry.agents.map((candidate) => (
        candidate.id === agent.id ? { ...candidate, defaultProjectId: target } : candidate
      )),
    },
    result: undefined,
  }));
  return target;
}
