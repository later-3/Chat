import { createError, defineEventHandler, getRouterParam } from "nitro/h3";
import { resolveChatHome } from "../../../../../chat-home.js";
import { findFriendTurn, friendExecution } from "../../../../../long-agents/turn-feedback.js";
import { getLiveTurn } from "../../../../../long-agents/live-turn.js";
import { controlQueuedRequest } from "../../../../../long-agents/turn-queue.js";
export default defineEventHandler(async (event) => {
  const agent = getRouterParam(event, "longAgentId"),
    id = getRouterParam(event, "turnId", { decode: true });
  if (!agent || !id) throw createError({ statusCode: 400, statusMessage: "缺少执行身份" });
  const home = resolveChatHome();
  try {
    const turn = await findFriendTurn(home, agent, id);
    if (turn.status === "queued") await controlQueuedRequest(home, agent, id, "cancel");
    else if (turn.status === "running") {
      const live = getLiveTurn(home, id);
      if (!live) throw new Error("执行正在装配或收尾，请稍后重试；尚未确认取消");
      live.cancelled = true;
      await live.session.abort();
    }
    return friendExecution(home, await findFriendTurn(home, agent, id));
  } catch (error) {
    throw createError({ statusCode: 409, statusMessage: error instanceof Error ? error.message : String(error) });
  }
});
