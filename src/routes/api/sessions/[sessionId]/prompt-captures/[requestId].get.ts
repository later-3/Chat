import { createError, defineEventHandler, getQuery, getRouterParam, setResponseHeader } from "nitro/h3";
import { dirname } from "node:path";
import { readPromptCaptureIndex, readPromptCapturePayload } from "../../../../../session-prompt-capture.js";
import { assertChatSessionReadable, requireChatSession } from "../../../../../session-read-model.js";
import { SessionLifecycleError } from "../../../../../session-errors.js";
import { toSessionLifecycleHttpError } from "../../../../../session-removal-http.js";
import { SessionOwnerResolutionError } from "../../../../../session-owner.js";

/** Returns one recorded provider request: the region decomposition plus the exact payload sent. */
export default defineEventHandler(async (event) => {
  const sessionId = getRouterParam(event, "sessionId");
  const requestId = getRouterParam(event, "requestId");
  if (!sessionId || !requestId || !/^[0-9a-f-]{36}$/i.test(requestId)) {
    throw createError({ statusCode: 400, statusMessage: "缺少sessionId或requestId" });
  }
  const query = getQuery(event);
  const projectId = typeof query.projectId === "string" ? query.projectId : undefined;
  setResponseHeader(event, "Cache-Control", "no-store");
  let sessionDir: string;
  try {
    await assertChatSessionReadable({ sessionId, ...(projectId === undefined ? {} : { projectId }), requester: { kind: "owner" } });
    const session = await requireChatSession(sessionId, projectId);
    sessionDir = dirname(session.path);
  } catch (error) {
    if (error instanceof SessionOwnerResolutionError) throw createError({ statusCode: 500, statusMessage: error.message });
    if (error instanceof SessionLifecycleError) throw toSessionLifecycleHttpError(error);
    throw createError({ statusCode: 404, statusMessage: error instanceof Error ? error.message : String(error) });
  }
  try {
    const record = (await readPromptCaptureIndex(sessionDir, sessionId)).find((candidate) => candidate.requestId === requestId);
    if (record === undefined) throw createError({ statusCode: 404, statusMessage: "找不到Prompt记录" });
    const payload = await readPromptCapturePayload(sessionDir, sessionId, record);
    return { schemaVersion: 1 as const, record, payload };
  } catch (error) {
    if (error && typeof error === "object" && "statusCode" in error) throw error;
    console.error("[prompt-captures] Capture read failed", error);
    throw createError({ statusCode: 500, statusMessage: "无法读取Prompt记录内容" });
  }
});
