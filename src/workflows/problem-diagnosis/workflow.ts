import type { ChatWorkflowInput, ChatWorkflowResult } from "../types.js";
import { runSessionMemoryTail } from "../session-memory/tail.js";
import { beginSessionExecution, endSessionExecution } from "../execution-registry.js";
import { PROBLEM_DIAGNOSIS_WORKFLOW_ID, runProblemDiagnosisStep } from "./step.js";

/** One structured problem-diagnosis turn in the Workflow's own child Session. */
export async function problemDiagnosisWorkflow(input: ChatWorkflowInput): Promise<ChatWorkflowResult> {
  "use workflow";
  if (input.sessionId !== undefined) {
    beginSessionExecution(input.sessionId, PROBLEM_DIAGNOSIS_WORKFLOW_ID, input.workflowInvocationId);
  }
  try {
    return await runSessionMemoryTail(input, await runProblemDiagnosisStep(input), "problem-diagnosis");
  } finally {
    if (input.sessionId !== undefined) {
      endSessionExecution(input.sessionId, input.workflowInvocationId);
    }
  }
}
