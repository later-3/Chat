import type { ChatWorkflowInput, ChatWorkflowResult } from "../types.js";
import { runPlanningExecutionStep, runPlanningStep } from "./steps.js";

/** Runs Planner Agent and Pi Coding Agent sequentially in one Chat Session. */
export async function planningExecutionWorkflow(
  input: ChatWorkflowInput,
): Promise<ChatWorkflowResult> {
  "use workflow";

  const planning = await runPlanningStep(input);
  return runPlanningExecutionStep({
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    ...(input.chatHome === undefined ? {} : { chatHome: input.chatHome }),
    cwd: input.cwd,
    sessionId: planning.sessionId,
    workflowInvocationId: input.workflowInvocationId,
    prompt: input.prompt,
    plan: planning.plan,
    agent: planning.executionAgent,
  });
}
