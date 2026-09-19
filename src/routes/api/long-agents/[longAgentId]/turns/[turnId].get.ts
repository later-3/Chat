import { createError, defineEventHandler, getRouterParam, setResponseHeader } from "nitro/h3";
import { resolveChatHome } from "../../../../../chat-home.js";
import { readFriendFeedback } from "../../../../../long-agents/turn-feedback.js";
export default defineEventHandler(async (event) => {
  const agent = getRouterParam(event, "longAgentId"),
    id = getRouterParam(event, "turnId", { decode: true });
  if (!agent || !id) throw createError({ statusCode: 400, statusMessage: "缺少执行身份" });
  setResponseHeader(event, "Cache-Control", "no-store");
  try {
    return await readFriendFeedback(resolveChatHome(), agent, id);
  } catch (error) {
    throw createError({ statusCode: 404, statusMessage: error instanceof Error ? error.message : String(error) });
  }
});
