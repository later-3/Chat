import { createError, defineEventHandler, getQuery, getRouterParam } from "nitro/h3";
import { getRun } from "workflow/api";
import { localTimestamp } from "../../runtime-log.js";
import { resolveProjectContext } from "../../projects/registry.js";
import {
  getPlanningExecutionRun,
  setPlanningExecutionPhase,
} from "../../workflows/planning-execution/review-state.js";

/** 取消指定Workflow Run；Pi Web的停止按钮调用这个接口。 */
export default defineEventHandler(async (event) => {
  const runId = getRouterParam(event, "runId");
  if (!runId) throw createError({ statusCode: 400, statusMessage: "缺少runId" });

  try {
    await getRun(runId).cancel();
    const query = getQuery(event);
    const projectId = typeof query.projectId === "string" ? query.projectId : undefined;
    const workflowInvocationId = typeof query.workflowInvocationId === "string"
      ? query.workflowInvocationId
      : undefined;
    if (projectId !== undefined && workflowInvocationId !== undefined) {
      const project = await resolveProjectContext(projectId);
      const record = await getPlanningExecutionRun(project.projectDataDir, workflowInvocationId);
      if (record?.runId === runId) {
        await setPlanningExecutionPhase({
          projectDataDir: project.projectDataDir,
          projectId,
          workflowInvocationId,
          ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
          phase: "cancelled",
        });
      }
    }
    console.log(`${localTimestamp()} [workflow] cancelled runId=${runId}`);
    return { runId, status: "cancelled" as const };
  } catch (error) {
    throw createError({
      statusCode: 404,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
});
