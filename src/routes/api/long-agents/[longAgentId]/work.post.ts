import { createError, defineEventHandler, getRouterParam, readBody, setResponseStatus } from "nitro/h3";
import { resolveChatHome } from "../../../../chat-home.js";
import { startFriendWork } from "../../../../long-agents/work.js";
export default defineEventHandler(async event => {
  const id = getRouterParam(event, "longAgentId");
  if (!id) throw createError({ statusCode: 400, statusMessage: "缺少Friend ID" });
  try {
    const value = await readBody<unknown>(event);
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("无效后台工作请求");
    const v = value as Record<string, unknown>;
    if (Object.keys(v).some(k => !["schemaVersion", "requestId", "originSessionId", "contextProjectId", "title", "text"].includes(k))
      || v.schemaVersion !== 1 || typeof v.requestId !== "string" || typeof v.originSessionId !== "string"
      || typeof v.title !== "string" || typeof v.text !== "string" || !(v.contextProjectId === null || typeof v.contextProjectId === "string")) throw new Error("无效后台工作字段");
    const result = await startFriendWork({ chatHome: resolveChatHome(), longAgentId: id, requestId: v.requestId,
      originSessionId: v.originSessionId, contextProjectId: v.contextProjectId, title: v.title, text: v.text });
    setResponseStatus(event, 202);
    return result;
  } catch (error) { throw createError({ statusCode: 400, statusMessage: error instanceof Error ? error.message : String(error) }); }
});
