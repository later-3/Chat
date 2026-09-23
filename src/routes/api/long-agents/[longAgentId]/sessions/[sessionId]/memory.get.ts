import { createError, defineEventHandler, getRouterParam, setResponseHeader } from "nitro/h3";
import { resolveChatHome } from "../../../../../../chat-home.js";
import { readSessionMemory, SessionMemoryError } from "../../../../../../long-agents/session-memory.js";

/** Owner-facing read of one session's session memory (works for removed sessions too: orphan entries). */
export default defineEventHandler(async (event) => {
  setResponseHeader(event, "Cache-Control", "no-store");
  const longAgentId = getRouterParam(event, "longAgentId");
  const sessionId = getRouterParam(event, "sessionId", { decode: true });
  if (!longAgentId || !sessionId) throw createError({ statusCode: 400, statusMessage: "缺少 longAgentId 或 sessionId" });
  try {
    return { ...(await readSessionMemory(resolveChatHome(), longAgentId, sessionId)) };
  } catch (error) {
    throw createError({
      statusCode: error instanceof SessionMemoryError ? error.statusCode : 500,
      statusMessage: error instanceof SessionMemoryError ? error.message : "读取会话记忆失败，请检查服务日志",
    });
  }
});
