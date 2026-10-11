import { createError, defineEventHandler, getQuery, getRouterParam, setResponseHeader } from "nitro/h3";
import { dirname } from "node:path";
import { assertChatSessionReadable, requireChatSession } from "../../../../../session-read-model.js";
import { SessionLifecycleError } from "../../../../../session-errors.js";
import { toSessionLifecycleHttpError } from "../../../../../session-removal-http.js";
import { SessionOwnerResolutionError } from "../../../../../session-owner.js";
import {
  adaptLegacyPromptCaptures,
  hasInteractions,
  readInteractionPage,
  readRecordingBySessionFile,
} from "../../../../../session-interactions.js";
import { readPromptCaptureIndex } from "../../../../../session-prompt-capture.js";

/**
 * 读模型分页接口（02 §4）：行分页 + 按轮次分组摘要 + 当前开关事实。
 * 旧会话（仅 prompt-captures）返回 legacy:true 行（纯读转换，不写回），B3 决定回落策略。
 */
export default defineEventHandler(async (event) => {
  const sessionId = getRouterParam(event, "sessionId");
  if (!sessionId) throw createError({ statusCode: 400, statusMessage: "缺少sessionId" });
  const query = getQuery(event);
  const projectId = typeof query.projectId === "string" ? query.projectId : undefined;
  const cursor = typeof query.cursor === "string" && /^\d+$/.test(query.cursor) ? Number(query.cursor) : 0;
  const limitRaw = typeof query.limit === "string" && /^\d+$/.test(query.limit) ? Number(query.limit) : 200;
  const limit = Math.min(Math.max(limitRaw, 1), 1000);
  setResponseHeader(event, "Cache-Control", "no-store");
  let sessionDir: string; let sessionPath: string;
  try {
    await assertChatSessionReadable({ sessionId, ...(projectId === undefined ? {} : { projectId }), requester: { kind: "owner" } });
    const session = await requireChatSession(sessionId, projectId);
    sessionDir = dirname(session.path);
    sessionPath = session.path;
  } catch (error) {
    if (error instanceof SessionOwnerResolutionError) throw createError({ statusCode: 500, statusMessage: error.message });
    if (error instanceof SessionLifecycleError) throw toSessionLifecycleHttpError(error);
    throw createError({ statusCode: 404, statusMessage: error instanceof Error ? error.message : String(error) });
  }
  try {
    const recording = await readRecordingBySessionFile(sessionPath);
    const legacy = !(await hasInteractions(sessionDir, sessionId));
    // groups = 全量轻摘要（每轮一行，跨页不撕裂）；rows = 重字段按页给（首屏 UI 只消费 groups，
    // 展开轮时由 turnKey 接口取该轮全量行——02 T9 聚合全部在后端）。
    const allRows = legacy
      ? adaptLegacyPromptCaptures(await readPromptCaptureIndex(sessionDir, sessionId)).rows
      : (await readInteractionPage(sessionDir, sessionId, { cursor: 0, limit: 100_000 })).rows;
    const rows = legacy
      ? allRows.filter(row => row.seq > cursor && row.seq <= cursor + limit)
      : (await readInteractionPage(sessionDir, sessionId, { cursor, limit })).rows;
    const groups = new Map<string, { key: string; source: string; stage: { id: string; nodeKind: string }; requestCount: number; failures: number; tokenOut: number }>();
    for (const row of allRows) {
      const key = row.turn.turnKey ?? "系统调用";
      const current = groups.get(key);
      const outcome = (row as { readonly outcome?: { readonly status?: string; readonly usage?: unknown } }).outcome;
      const failed = outcome !== undefined && outcome.status !== "success";
      const usageTotal = (outcome?.usage as { totalTokens?: unknown } | undefined)?.totalTokens;
      const tokens = typeof usageTotal === "number" ? usageTotal : 0;
      if (current === undefined) groups.set(key, { key, source: row.turn.source, stage: row.turn.stage, requestCount: 1, failures: failed ? 1 : 0, tokenOut: tokens });
      else { current.requestCount += 1; if (failed) current.failures += 1; current.tokenOut += tokens; }
    }
    const nextCursor = rows.at(-1)?.seq;
    return {
      sessionId,
      legacy,
      groups: [...groups.values()],
      rows,
      ...(legacy || rows.length < limit || nextCursor === undefined ? {} : { nextCursor }),
      recording,
    };
  } catch (error) {
    console.error("[interactions] index read failed", error);
    throw createError({ statusCode: 500, statusMessage: "无法读取交互记录" });
  }
});
