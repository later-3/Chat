import { createError, defineEventHandler, getRouterParam, setResponseHeader } from "nitro/h3";
import { getRun } from "workflow/api";
import type { ChatWorkflowResult } from "../../workflows/types.js";

/** 返回一次Workflow Run的当前状态；只有完成后才包含`result`。 */
export default defineEventHandler(async (event) => {
  const runId = getRouterParam(event, "runId");
  if (!runId) throw createError({ statusCode: 400, statusMessage: "缺少runId" });
  setResponseHeader(event, "Cache-Control", "no-store");

  const workflowRun = getRun<ChatWorkflowResult>(runId);
  let status;
  try {
    status = await workflowRun.status;
  } catch (error) {
    throw createError({
      statusCode: 404,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
  if (status !== "completed") return { runId, status };
  return { runId, status, result: await workflowRun.returnValue };
});
