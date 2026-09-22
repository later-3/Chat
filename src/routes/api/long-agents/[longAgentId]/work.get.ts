import { createError, defineEventHandler, getRouterParam, setResponseHeader } from "nitro/h3";
import { resolveChatHome } from "../../../../chat-home.js";
import { listFriendWork } from "../../../../long-agents/work.js";
export default defineEventHandler(async event => {
  setResponseHeader(event, "Cache-Control", "no-store");
  const id = getRouterParam(event, "longAgentId");
  if (!id) throw createError({ statusCode: 400, statusMessage: "缺少Friend ID" });
  return listFriendWork(resolveChatHome(), id);
});
