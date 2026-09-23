import { createError, defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { resolveChatHome } from "../../../../../../chat-home.js";
import { SessionMemoryError, writeSessionMemoryEntry } from "../../../../../../long-agents/session-memory.js";
import { resolveSessionMemoryTarget } from "../../../../../../long-agents/session-memory.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Owner-facing edit: append a user-authored entry, or overturn an existing one. Web callers are always
 * the user, so `author` is fixed server-side (never taken from the body); the edit is append-only
 * (`supersede`), so history is preserved.
 */
export default defineEventHandler(async (event) => {
  const longAgentId = getRouterParam(event, "longAgentId");
  const sessionId = getRouterParam(event, "sessionId", { decode: true });
  if (!longAgentId || !sessionId) throw createError({ statusCode: 400, statusMessage: "缺少 longAgentId 或 sessionId" });
  const body = await readBody<unknown>(event);
  const value = isRecord(body) ? body : {};
  // Strict request parsing (review 21): an unknown or missing operation is a 400, never coerced into
  // an append; field combinations are validated per operation (write may not carry supersedes).
  const operation = value.operation;
  if (operation !== "write" && operation !== "supersede")
    throw createError({ statusCode: 400, statusMessage: "operation 必须是 write 或 supersede" });
  const allowed = ["operation", "purpose", "content", "originEntryId", "supersedes", "expectedRevision"];
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw createError({ statusCode: 400, statusMessage: "会话记忆编辑包含未知字段" });
  if (operation === "write" && value.supersedes !== undefined)
    throw createError({ statusCode: 400, statusMessage: "write 不接受 supersedes：推翻请使用 supersede" });
  if (operation === "supersede" && value.supersedes === undefined)
    throw createError({ statusCode: 400, statusMessage: "supersede 必须指定 supersedes" });
  const home = resolveChatHome();
  try {
    const target = await resolveSessionMemoryTarget({ chatHome: home, projectId: longAgentId, sessionId, longAgentId });
    return {
      ...(await writeSessionMemoryEntry({
        chatHome: home, longAgentId: target.longAgentId, sessionId: target.sessionId, operation,
        purpose: value.purpose, author: "user", content: value.content,
        ...(value.originEntryId === undefined ? {} : { originEntryId: value.originEntryId }),
        supersedes: operation === "supersede" ? String(value.supersedes) : null,
        expectedRevision: value.expectedRevision,
      })),
    };
  } catch (error) {
    throw createError({
      statusCode: error instanceof SessionMemoryError ? error.statusCode : 500,
      statusMessage: error instanceof SessionMemoryError ? error.message : "保存会话记忆失败，请检查服务日志",
    });
  }
});
