import { createError, defineEventHandler, getRouterParam } from "nitro/h3";
import { resolveChatHome } from "../../../../../chat-home.js";
import { cancelFriendTurn } from "../../../../../long-agents/turn-controls.js";
export default defineEventHandler(async (event) => {
  const agent = getRouterParam(event, "longAgentId"),
    id = getRouterParam(event, "turnId", { decode: true });
  if (!agent || !id) throw createError({ statusCode: 400, statusMessage: "缺少执行身份" });
  const home = resolveChatHome();
  try {
    return cancelFriendTurn(home, agent, id);
  } catch (error) {
    throw createError({ statusCode: 409, statusMessage: error instanceof Error ? error.message : String(error) });
  }
});
