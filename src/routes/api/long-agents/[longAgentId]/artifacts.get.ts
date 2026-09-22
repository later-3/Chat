import { createError, defineEventHandler, getQuery, getRouterParam, setResponseHeader } from "nitro/h3";
import { resolveChatHome } from "../../../../chat-home.js";
import { listFriendArtifacts } from "../../../../long-agents/artifacts/service.js";
import { FriendArtifactError } from "../../../../long-agents/artifacts/contract.js";

/** LA4 artifact view: notes and posts with their real commit state, never a model claim. */
export default defineEventHandler(async (event) => {
  setResponseHeader(event, "Cache-Control", "no-store");
  const longAgentId = getRouterParam(event, "longAgentId");
  if (!longAgentId) throw createError({ statusCode: 400, statusMessage: "缺少Long Agent ID" });
  try {
    const query = getQuery(event);
    return await listFriendArtifacts(resolveChatHome(), longAgentId, {
      ...(typeof query.from === "string" && /^\d{4}-\d\d-\d\d$/.test(query.from) ? { from: query.from } : {}),
      ...(typeof query.to === "string" && /^\d{4}-\d\d-\d\d$/.test(query.to) ? { to: query.to } : {}),
      ...(typeof query.kind === "string" && (query.kind === "post" || query.kind === "note") ? { kind: query.kind } : {}),
    });
  } catch (error) {
    throw createError({
      statusCode: error instanceof FriendArtifactError ? error.statusCode : 500,
      statusMessage: error instanceof FriendArtifactError ? error.message : "读取产物失败，请检查服务日志",
    });
  }
});
