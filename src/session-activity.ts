import type { ChatProjectContext } from "./projects/types.js";
import { SessionLifecycleError } from "./session-errors.js";
import { findActivePlanningExecutionRun } from "./workflows/planning-execution/review-state.js";
import { findActiveChatSessionRun } from "./workflows/session-run-registry.js";

/** Prevents a Session file mutation while Workflow Runtime may still write it. */
export async function assertChatSessionIsIdle(project: ChatProjectContext, sessionId: string): Promise<void> {
  const [run, legacyPlanningRun] = await Promise.all([
    findActiveChatSessionRun(project.projectDataDir, sessionId),
    findActivePlanningExecutionRun(project.projectDataDir, sessionId),
  ]);
  if (run !== undefined) {
    throw new SessionLifecycleError(
      "SESSION_BUSY",
      `Session正在运行Workflow ${run.workflowId}，暂时不能修改`,
    );
  }
  if (legacyPlanningRun !== undefined) {
    throw new SessionLifecycleError("SESSION_BUSY", "Session存在未结束的Planning Workflow，暂时不能修改");
  }
}
