import { createError, defineEventHandler, getRouterParam, readBody, setResponseStatus } from "nitro/h3";
import { forkChatSession, parseForkSessionInput } from "../../../../session-fork.js";
import { SessionInputError, SessionLifecycleError } from "../../../../session-errors.js";
import { toSessionLifecycleHttpError } from "../../../../session-removal-http.js";

export default defineEventHandler(async (event) => {
  const sessionId = getRouterParam(event, "sessionId");
  if (!sessionId) throw createError({ statusCode: 400, statusMessage: "缺少sessionId" });
  try {
    const result = await forkChatSession(sessionId, parseForkSessionInput(await readBody<unknown>(event)));
    setResponseStatus(event, 201);
    return result;
  } catch (error) {
    if (error instanceof SessionLifecycleError) throw toSessionLifecycleHttpError(error);
    if (error instanceof SessionInputError) throw createError({ statusCode: 400, statusMessage: error.message });
    console.error("[session-fork] Fork failed", error);
    throw createError({ statusCode: 500, statusMessage: "无法分叉会话，请检查后端日志" });
  }
});
