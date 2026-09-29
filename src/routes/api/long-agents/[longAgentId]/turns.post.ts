import {
  createError,
  defineEventHandler,
  getRouterParam,
  readBody,
  setResponseStatus,
  setResponseHeader,
} from "nitro/h3";
import { resolveChatHome } from "../../../../chat-home.js";
import { acceptLongAgentTurn, drainLongAgentTurns } from "../../../../long-agents/turn-queue.js";
import { friendExecution } from "../../../../long-agents/turn-feedback.js";
import { parseWorkflowImages } from "../../../../workflows/image-input.js";

export default defineEventHandler(async (event) => {
  const longAgentId = getRouterParam(event, "longAgentId");
  if (!longAgentId) throw createError({ statusCode: 400, statusMessage: "缺少Friend ID" });
  try {
    const body = await readBody<unknown>(event);
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("请求必须是对象");
    const v = body as Record<string, unknown>;
    if (
      Object.keys(v).some(
        (k) => !["workflow", "schemaVersion", "requestId", "sessionId", "text", "images", "contextProjectId", "sessionMemory"].includes(k),
      ) ||
      (v.sessionMemory !== undefined && v.sessionMemory !== "on" && v.sessionMemory !== "off") ||
      v.schemaVersion !== 1 ||
      typeof v.requestId !== "string" ||
      !v.requestId.trim() ||
      (v.sessionId !== undefined && (typeof v.sessionId !== "string" || !v.sessionId)) ||
      (v.contextProjectId !== undefined && !(v.contextProjectId === null || (typeof v.contextProjectId === "string" && v.contextProjectId.trim())))
    )
      throw new Error("无效Friend消息合同");
    const home = resolveChatHome();
    const images = parseWorkflowImages(v.images);
    if (v.workflow !== undefined && typeof v.workflow !== "string") throw new Error("无效Workflow选择");
    const accepted = await acceptLongAgentTurn({
      ...(v.workflow === undefined ? {} : { workflow: v.workflow as string }),
      chatHome: home,
      longAgentId,
      projectId: longAgentId,
      turnId: v.requestId,
      text: v.text,
      ...(v.sessionMemory === "off" ? { sessionMemory: "off" as const } : {}),
      ...(v.contextProjectId === undefined ? {} : { contextProjectId: v.contextProjectId as string | null }),
      ...(v.sessionId === undefined ? {} : { sessionId: v.sessionId as string }),
      ...(images === undefined ? {} : { images }),
    });
    setResponseStatus(event, 202);
    setResponseHeader(event, "Cache-Control", "no-store");
    // The worker belongs to Backend, not this browser connection.
    void drainLongAgentTurns(home, longAgentId).catch((error: unknown) => console.error("Friend队列执行失败", error));
    return friendExecution(home, accepted);
  } catch (error) {
    throw createError({
      statusCode: error instanceof Error && "statusCode" in error && error.statusCode === 409 ? 409 : 400,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
});
