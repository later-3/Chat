import type { ChatWorkflowInput, ChatWorkflowResult } from "../types.js";
import { runPlanningExecutionStep, runPlanningStep } from "./steps.js";

const EXECUTION_AGENT_ID = "pi-coding-agent";

/** Runs Planner Agent and Pi Coding Agent sequentially in one Chat Session. */
export async function planningExecutionWorkflow(
  input: ChatWorkflowInput,
): Promise<ChatWorkflowResult> {
  "use workflow";

  const planning = await runPlanningStep(input);
  return runPlanningExecutionStep({
    cwd: input.cwd,
    sessionId: planning.sessionId,
    workflowInvocationId: input.workflowInvocationId,
    prompt: input.prompt,
    plan: planning.plan,
    ...(input.agentConfigs?.[EXECUTION_AGENT_ID] === undefined
      ? {}
      : { agentConfig: input.agentConfigs[EXECUTION_AGENT_ID] }),
  });
}
