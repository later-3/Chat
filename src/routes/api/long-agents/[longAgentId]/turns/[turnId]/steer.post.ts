import { createError, defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { resolveChatHome } from "../../../../../../chat-home.js";
import { steerFriendTurn } from "../../../../../../long-agents/turn-controls.js";
export default defineEventHandler(async (event) => {
  const agent = getRouterParam(event, "longAgentId"),
    id = getRouterParam(event, "turnId", { decode: true });
  if (!agent || !id) throw createError({ statusCode: 400, statusMessage: "缺少执行身份" });
  try {
    const input = await readBody<unknown>(event);
    if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("无效引导请求");
    const v = input as Record<string, unknown>;
    if (
      Object.keys(v).some((k) => !["requestId", "text", "contextProjectId"].includes(k)) ||
      typeof v.requestId !== "string" ||
      typeof v.text !== "string" ||
      !(v.contextProjectId === null || typeof v.contextProjectId === "string")
    )
      throw new Error("无效引导请求");
    return await steerFriendTurn(resolveChatHome(), agent, id, {
      requestId: v.requestId,
      text: v.text,
      contextProjectId: v.contextProjectId,
    });
  } catch (error) {
    throw createError({ statusCode: 409, statusMessage: error instanceof Error ? error.message : String(error) });
  }
});
