import { createError, defineEventHandler, getQuery, getRouterParam, readBody, setResponseHeader } from "nitro/h3";
import { assertChatSessionReadable, requireChatSession } from "../../../../session-read-model.js";
import { SessionLifecycleError } from "../../../../session-errors.js";
import { toSessionLifecycleHttpError } from "../../../../session-removal-http.js";
import { SessionOwnerResolutionError } from "../../../../session-owner.js";
import { ContextEditConflictError, setSessionContextEdit } from "../../../../context-edit.js";

/**
 * 写上下文编辑层（B5）。语义：从下一轮生效（02 §2.1）；expectedRevision 不符 → 409。
 */
export default defineEventHandler(async (event) => {
  const sessionId = getRouterParam(event, "sessionId");
  if (!sessionId) throw createError({ statusCode: 400, statusMessage: "缺少sessionId" });
  setResponseHeader(event, "Cache-Control", "no-store");
  const query = getQuery(event);
  const projectId = typeof query.projectId === "string" ? query.projectId : undefined;
  if (projectId === undefined) throw createError({ statusCode: 400, statusMessage: "缺少projectId" });
  const body = (await readBody<{ excluded?: unknown; modified?: unknown; added?: unknown; expectedRevision?: unknown }>(event)) ?? {};
  const excluded = stringArray(body.excluded, "excluded");
  const modified = stringRecord(body.modified, "modified");
  const added = stringListRecord(body.added, "added");
  if (typeof body.expectedRevision !== "number" || !Number.isInteger(body.expectedRevision) || body.expectedRevision < 0) {
    throw createError({ statusCode: 400, statusMessage: "expectedRevision必须是非负整数" });
  }
  try {
    await assertChatSessionReadable({ sessionId, projectId, requester: { kind: "owner" } });
    await requireChatSession(sessionId, projectId);
    return await setSessionContextEdit({
      projectId, sessionId, excluded, modified, added, expectedRevision: body.expectedRevision,
    });
  } catch (error) {
    if (error instanceof ContextEditConflictError) throw createError({ statusCode: 409, statusMessage: error.message });
    if (error instanceof SessionOwnerResolutionError) throw createError({ statusCode: 500, statusMessage: error.message });
    if (error instanceof SessionLifecycleError) throw toSessionLifecycleHttpError(error);
    throw createError({ statusCode: 404, statusMessage: error instanceof Error ? error.message : String(error) });
  }
});

function stringArray(value: unknown, field: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw createError({ statusCode: 400, statusMessage: `${field}必须是字符串数组` });
  }
  return value as string[];
}

function stringRecord(value: unknown, field: string): Readonly<Record<string, string>> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw createError({ statusCode: 400, statusMessage: `${field}必须是对象` });
  }
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item !== "string") throw createError({ statusCode: 400, statusMessage: `${field}.${key}必须是字符串` });
    result[key] = item;
  }
  return result;
}

function stringListRecord(value: unknown, field: string): Readonly<Record<string, readonly string[]>> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw createError({ statusCode: 400, statusMessage: `${field}必须是对象` });
  }
  const result: Record<string, string[]> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(item) || item.some((entry) => typeof entry !== "string")) {
      throw createError({ statusCode: 400, statusMessage: `${field}.${key}必须是字符串数组` });
    }
    result[key] = item as string[];
  }
  return result;
}
