import { createError, defineEventHandler, getQuery, getRouterParam } from "nitro/h3";
import { getRun } from "workflow/api";
import { abortWorkflowAgents } from "../../workflows/execution-registry.js";
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
    const query = getQuery(event);
    const projectId = typeof query.projectId === "string" ? query.projectId : undefined;
    const workflowInvocationId = typeof query.workflowInvocationId === "string"
      ? query.workflowInvocationId
      : undefined;
    if (projectId !== undefined && workflowInvocationId !== undefined) {
      const project = await resolveProjectContext(projectId);
      const { readChatSessionRunBinding } = await import("../../workflows/session-run-registry.js");
      const binding = await readChatSessionRunBinding(project.projectDataDir, workflowInvocationId);
      if (binding?.runId === runId && binding.acceptedLongAgentTurn !== undefined) {
        const { cancelFriendTurn } = await import("../../long-agents/turn-controls.js");
        await cancelFriendTurn(project.chatHome, binding.acceptedLongAgentTurn.longAgentId, binding.acceptedLongAgentTurn.turnId);
      }
      const record = await getPlanningExecutionRun(project.projectDataDir, workflowInvocationId);
      if (record?.runId === runId) {
        await setPlanningExecutionPhase({
          projectDataDir: project.projectDataDir,
          projectId,
          workflowId: record.workflowId,
          workflowInvocationId,
          ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
          phase: "cancelled",
        });
      }
    }
    await getRun(runId).cancel();
    await abortWorkflowAgents(runId);
    console.log(`${localTimestamp()} [workflow] cancelled runId=${runId}`);
    return { runId, status: "cancelled" as const };
  } catch (error) {
    throw createError({
      statusCode: 404,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
});
