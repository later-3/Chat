import { createError, defineEventHandler, getQuery, getRouterParam } from "nitro/h3";
import { getRun } from "workflow/api";

function parseStartIndex(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) {
    throw createError({ statusCode: 400, statusMessage: "startIndex必须是整数" });
  }
  return Number.parseInt(value, 10);
}

/** Streams ordered Agent and Workflow Stage events as newline-delimited JSON. */
export default defineEventHandler((event) => {
  const runId = getRouterParam(event, "runId");
  if (!runId) throw createError({ statusCode: 400, statusMessage: "缺少runId" });
  const startIndex = parseStartIndex(getQuery(event).startIndex);
  const readable = getRun(runId).getReadable<string>({
    ...(startIndex === undefined ? {} : { startIndex }),
  });
  return new Response(readable, {
    headers: {
      "Cache-Control": "no-cache, no-store",
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
