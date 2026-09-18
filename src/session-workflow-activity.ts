import type { ChatProjectContext } from "./projects/types.js";
import { findActiveChatSessionRun } from "./workflows/session-run-registry.js";
import { getPlanningExecutionRun } from "./workflows/planning-execution/review-state.js";

/** Shared recovery projection for Web and terminal clients; Runtime owns status. */
export async function readSessionWorkflowActivity(project: ChatProjectContext, sessionId: string) {
  const run = await findActiveChatSessionRun(project.projectDataDir, sessionId);
  if (run === undefined) return undefined;
  const planning = await getPlanningExecutionRun(project.projectDataDir, run.workflowInvocationId);
  return {
    runId: run.runId, workflowInvocationId: run.workflowInvocationId,
    workflowId: run.workflowId, projectId: project.projectId,
    phase: planning?.phase ?? "executing" as const,
    ...(planning?.phase === "waiting_review" ? { review: planning.currentReview } : {}),
  };
}
