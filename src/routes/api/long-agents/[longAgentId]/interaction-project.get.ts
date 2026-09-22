import { createError, defineEventHandler, getRouterParam, setResponseHeader } from "nitro/h3";
import { resolveChatHome } from "../../../../chat-home.js";
import { readLongAgentRegistry } from "../../../../long-agents/storage.js";
import { InteractionProjectError, readLongAgentInteractionProject } from "../../../../long-agents/interaction-project.js";

/** Owner-facing read of one Friend's collaboration-project association (unset/null/unavailable). */
export default defineEventHandler(async (event) => {
  setResponseHeader(event, "Cache-Control", "no-store");
  const longAgentId = getRouterParam(event, "longAgentId");
  if (!longAgentId) throw createError({ statusCode: 400, statusMessage: "缺少 Friend ID" });
  const home = resolveChatHome();
  const agent = (await readLongAgentRegistry(home)).agents.find((candidate) => candidate.id === longAgentId);
  if (agent === undefined) throw createError({ statusCode: 404, statusMessage: `找不到 Friend：${longAgentId}` });
  try {
    return { schemaVersion: 1, longAgentId, ...(await readLongAgentInteractionProject(home, longAgentId)) };
  } catch (error) {
    throw createError({
      statusCode: error instanceof InteractionProjectError ? error.statusCode : 500,
      statusMessage: error instanceof Error ? error.message : "读取项目关联失败",
    });
  }
});
