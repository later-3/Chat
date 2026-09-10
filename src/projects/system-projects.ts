/**
 * 系统管理项目的识别（归一过渡期）。
 *
 * 目标模型只有两种用户可见项目：用户自己的真实项目，以及 Long Agent 自己的 home。
 * 当前实现仍带着归一前的形态：
 * - 共享 `daily`：后续改名为 `longagentshare`（公共 Long Agent 资源共享空间，不对用户展示）
 * - `daily-<longAgentId>`：Long Agent 的日常项目，后续归一为 Agent 自己的根
 *
 * 在物理归一完成前，这些 id 需要被记忆树、项目列表与记忆 Target 一致地识别出来，
 * 避免 Long Agent 的记忆以"项目记忆"的形态重复出现。
 */

/** 归一前的共享空间 id（迁移后为 `longagentshare`）。 */
export const LEGACY_SHARE_PROJECT_ID = "daily";

/** 归一前 Long Agent 日常项目的 id 前缀。 */
export const LEGACY_AGENT_PROJECT_PREFIX = "daily-";

/** 归一后的公共 Long Agent 共享空间 id。 */
export const LONG_AGENT_SHARE_PROJECT_ID = "longagentshare";

/** 判定一个 projectId 是否属于系统管理的 Long Agent 容器（共享空间或某个 Agent 的日常项目）。 */
export function isSystemLongAgentProjectId(
  projectId: string,
  longAgentIds: ReadonlySet<string>,
): boolean {
  if (projectId === LEGACY_SHARE_PROJECT_ID || projectId === LONG_AGENT_SHARE_PROJECT_ID) return true;
  if (!projectId.startsWith(LEGACY_AGENT_PROJECT_PREFIX)) return false;
  return longAgentIds.has(projectId.slice(LEGACY_AGENT_PROJECT_PREFIX.length));
}
