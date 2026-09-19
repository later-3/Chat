import { createError, defineEventHandler, getRouterParam, setResponseHeader } from "nitro/h3";
import { resolveChatHome } from "../../../../chat-home.js";
import { readFriendCapabilities } from "../../../../long-agents/capabilities.js";
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, "longAgentId");
  if (!id) throw createError({ statusCode: 400, statusMessage: "缺少Friend ID" });
  setResponseHeader(event, "Cache-Control", "no-store");
  return readFriendCapabilities(id, resolveChatHome());
});
