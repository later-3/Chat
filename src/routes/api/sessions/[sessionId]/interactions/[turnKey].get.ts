import { createError, defineEventHandler, getQuery, getRouterParam, setResponseHeader } from "nitro/h3";
import { dirname } from "node:path";
import { assertChatSessionReadable, requireChatSession } from "../../../../../session-read-model.js";
import { SessionLifecycleError } from "../../../../../session-errors.js";
import { toSessionLifecycleHttpError } from "../../../../../session-removal-http.js";
import { SessionOwnerResolutionError } from "../../../../../session-owner.js";
import { adaptLegacyPromptCaptures, aggregateInteractionRows, hasInteractions, readInteractionTurnGroup } from "../../../../../session-interactions.js";
import { readPromptCaptureIndex } from "../../../../../session-prompt-capture.js";

/** 按轮次读取：阶段 + 请求行（不含原文）。direct 轮与系统调用归 key="系统调用"（D5）。 */
export default defineEventHandler(async (event) => {
  const sessionId = getRouterParam(event, "sessionId");
  const turnKey = getRouterParam(event, "turnKey");
  if (!sessionId || !turnKey) throw createError({ statusCode: 400, statusMessage: "缺少sessionId或turnKey" });
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
    const key = decodeURIComponent(turnKey);
    if (await hasInteractions(sessionDir, sessionId)) {
      const group = await readInteractionTurnGroup(sessionDir, sessionId, key);
      return { sessionId, legacy: false, turnKey: key, rows: group.rows, summary: group.summary, requests: group.requests };
    }
    const rows = adaptLegacyPromptCaptures(await readPromptCaptureIndex(sessionDir, sessionId)).rows
      .filter((row) => (row.turn.turnKey ?? "系统调用") === key);
    // legacy 同样给聚合（适配行带 attempt/retryOf，同一聚合器）——UI 合同一致（D3 矩阵）。
    const aggregated = aggregateInteractionRows(rows);
    return { sessionId, legacy: true, turnKey: key, rows, summary: aggregated.summary, requests: aggregated.requests };
  } catch (error) {
    console.error("[interactions] turn read failed", error);
    throw createError({ statusCode: 500, statusMessage: "无法读取轮次交互记录" });
  }
});
