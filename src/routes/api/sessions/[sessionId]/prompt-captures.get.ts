import { createError, defineEventHandler, getQuery, getRouterParam, setResponseHeader } from "nitro/h3";
import { dirname } from "node:path";
import { readPromptCaptureIndex } from "../../../../session-prompt-capture.js";
import { assertChatSessionReadable, requireChatSession } from "../../../../session-read-model.js";
import { SessionLifecycleError } from "../../../../session-errors.js";
import { toSessionLifecycleHttpError } from "../../../../session-removal-http.js";
import { SessionOwnerResolutionError } from "../../../../session-owner.js";

/**
 * Lists the recorded provider requests of one session (region summaries only;
 * payloads are fetched individually). Owner-facing history entry: group
 * participation history stays readable for the owner.
 */
export default defineEventHandler(async (event) => {
  const sessionId = getRouterParam(event, "sessionId");
  if (!sessionId) throw createError({ statusCode: 400, statusMessage: "缺少sessionId" });
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
    const records = await readPromptCaptureIndex(sessionDir, sessionId);
    return {
      schemaVersion: 1 as const,
      sessionId,
      count: records.length,
      records: records.map(({ regions, ...record }) => ({
        ...record,
        regions: {
          parsed: regions.parsed,
          ...(regions.api === undefined ? {} : { api: regions.api }),
          ...(regions.parseError === undefined ? {} : { parseError: regions.parseError }),
          systemPromptChars: regions.systemPrompt?.chars ?? 0,
          systemSections: regions.systemPrompt?.sections.map((section) => ({ kind: section.kind, label: section.label, chars: section.text.length })) ?? [],
          messageCount: regions.messages?.length ?? 0,
          regionCounts: (regions.messages ?? []).reduce<Record<string, number>>((counts, message) => {
            counts[message.region] = (counts[message.region] ?? 0) + 1;
            return counts;
          }, {}),
          toolCount: regions.tools?.length ?? 0,
          ...(regions.systemPrompt === undefined && regions.parseError === undefined ? { parseError: "请求中没有系统提示或消息" } : {}),
        },
      })),
    };
  } catch (error) {
    console.error("[prompt-captures] Index read failed", error);
    throw createError({ statusCode: 500, statusMessage: "无法读取Prompt记录索引" });
  }
});
