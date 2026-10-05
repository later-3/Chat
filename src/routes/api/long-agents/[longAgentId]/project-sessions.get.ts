import { createError, defineEventHandler, getQuery, getRouterParam } from "nitro/h3";
import { resolveChatHome } from "../../../../chat-home.js";
import { listProjectSessions } from "../../../../long-agents/project-sessions.js";
import { readLongAgentRegistry } from "../../../../long-agents/storage.js";
import { PROJECT_ID_PATTERN } from "../../../../projects/types.js";

/** 项目归属会话列表（LA→Project→Session 第三级）；只读，不执行模型。 */
export default defineEventHandler(async (event) => {
  const longAgentId = getRouterParam(event, "longAgentId");
  if (!longAgentId) throw createError({ statusCode: 400, statusMessage: "缺少longAgentId" });
  const query = getQuery(event);
  const projectId = query.projectId;
  if (typeof projectId !== "string" || !PROJECT_ID_PATTERN.test(projectId)) {
    throw createError({ statusCode: 400, statusMessage: "projectId无效" });
  }
  try {
    const home = resolveChatHome();
    const registry = await readLongAgentRegistry(home);
    if (!registry.agents.some((candidate) => candidate.id === longAgentId)) {
      throw new Error(`找不到LongAgent: ${longAgentId}`);
    }
    const sessions = await listProjectSessions(home, longAgentId, projectId);
    return { schemaVersion: 1, projectId, longAgentId, sessions };
  } catch (error) {
    throw createError({ statusCode: 400, statusMessage: error instanceof Error ? error.message : String(error) });
  }
});
