import { createError, defineEventHandler, getQuery, getRouterParam, setResponseHeader } from "nitro/h3";
import { dirname } from "node:path";
import { assertChatSessionReadable, requireChatSession } from "../../../../../session-read-model.js";
import { SessionLifecycleError } from "../../../../../session-errors.js";
import { toSessionLifecycleHttpError } from "../../../../../session-removal-http.js";
import { SessionOwnerResolutionError } from "../../../../../session-owner.js";
import {
  adaptLegacyPromptCaptures,
  aggregateInteractionRows,
  interactionTurnKeyOf,
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
    // legacy = 有旧捕获数据（而非"无新数据"——空会话不标 legacy）。
    const legacyIndex = await hasInteractions(sessionDir, sessionId) ? null : await readPromptCaptureIndex(sessionDir, sessionId);
    const legacy = legacyIndex !== null && legacyIndex.length > 0;
    // groups = 全量轻摘要（每轮一行，跨页不撕裂）；rows = 重字段按页给（首屏 UI 只消费 groups，
    // 展开轮时由 turnKey 接口取该轮全量行——02 T9 聚合全部在后端）。
    const allRows = legacyIndex !== null
      ? adaptLegacyPromptCaptures(legacyIndex).rows
      : (await readInteractionPage(sessionDir, sessionId, { cursor: 0, limit: 100_000 })).rows;
    const rows = legacy
      ? allRows.filter(row => row.seq > cursor && row.seq <= cursor + limit)
      : (await readInteractionPage(sessionDir, sessionId, { cursor, limit })).rows;
    // 轮头字段（F4 + E1/E2/E3 修复）：请求数按 retryOf 链去重聚合（=turn 接口一致），
    // attempts=行数；state：末行有 outcome→done，legacy 且全无 outcome→unknown（UI 显示"未记录"），
    // 否则 running。聚合全部在后端（02 T9）。
    type AllRow = (typeof allRows)[number];
    const rowsByKey = new Map<string, AllRow[]>();
    for (const row of allRows) {
      const key = interactionTurnKeyOf(row);
      const bucket = rowsByKey.get(key);
      if (bucket === undefined) rowsByKey.set(key, [row]);
      else bucket.push(row);
    }
    const groups = new Map<string, { key: string; source: string; stage: { id: string; nodeKind: string }; requestCount: number; attempts: number; failures: number; tokenOut: number; promptChars: number; model: string; firstTimestamp: string; agentLabel: string; state: "done" | "running" | "unknown"; hasOutcome: boolean }>();
    for (const [key, rows] of rowsByKey) {
      const aggregated = aggregateInteractionRows(rows);
      const first = rows[0]!;
      const last = rows[rows.length - 1]! as AllRow & { readonly outcome?: unknown };
      const hasOutcome = aggregated.summary.hasOutcome;
      const isLegacy = rows.every(row => (row as { legacy?: boolean }).legacy === true);
      const state = last.outcome !== undefined ? "done" : isLegacy && !hasOutcome ? "unknown" : "running";
      groups.set(key, {
        key,
        source: first.turn.source,
        stage: first.turn.stage,
        requestCount: aggregated.summary.requestCount,
        attempts: aggregated.summary.attempts,
        failures: aggregated.summary.failures,
        tokenOut: aggregated.summary.tokenOut,
        promptChars: aggregated.summary.promptChars,
        model: aggregated.summary.model,
        firstTimestamp: first.timestamp,
        agentLabel: first.agent.agentName ?? first.agent.agentId,
        state,
        hasOutcome,
      });
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
