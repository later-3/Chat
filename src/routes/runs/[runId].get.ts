import { createError, defineEventHandler, getQuery, getRouterParam, setResponseHeader } from "nitro/h3";
import { getRun } from "workflow/api";
import type { ChatWorkflowResult } from "../../workflows/types.js";
import { resolveProjectContext } from "../../projects/registry.js";
import { getPlanningExecutionRun } from "../../workflows/planning-execution/review-state.js";

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
  const query = getQuery(event);
  const projectId = typeof query.projectId === "string" ? query.projectId : undefined;
  const workflowInvocationId = typeof query.workflowInvocationId === "string"
    ? query.workflowInvocationId
    : undefined;
  let planningExecution;
  if (projectId !== undefined && workflowInvocationId !== undefined) {
    try {
      const project = await resolveProjectContext(projectId);
      const record = await getPlanningExecutionRun(project.projectDataDir, workflowInvocationId);
      if (record?.runId === runId) planningExecution = record;
    } catch {
      planningExecution = undefined;
    }
  }
  if (status !== "completed") {
    return {
      runId,
      status,
      ...(planningExecution === undefined
        ? {}
        : {
            phase: planningExecution.phase,
            ...(planningExecution.currentReview === undefined
              ? {}
              : { review: planningExecution.currentReview }),
          }),
    };
  }
  return { runId, status, result: await workflowRun.returnValue };
});
