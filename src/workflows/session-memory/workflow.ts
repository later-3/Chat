import type { ChatWorkflowInput, ChatWorkflowResult } from "../types.js";
import { beginSessionExecution, endSessionExecution } from "../execution-registry.js";
import { runSessionMemoryRoundStep } from "./step.js";

/**
 * The manually-triggered session-memory round: ONE node (`remember`) reads the WHOLE session and
 * maintains its session memory. The user selects this Workflow and sends a message; the message is
 * both the trigger and the round's instruction (it may carry focus hints). The invocation is the
 * unit of settlement: the writer's report is the round's answer.
 */
export async function sessionMemoryWorkflow(input: ChatWorkflowInput): Promise<ChatWorkflowResult> {
  "use workflow";
  if (input.sessionId !== undefined) {
    beginSessionExecution(input.sessionId, "session-memory", input.workflowInvocationId);
  }
  try {
    return await runSessionMemoryRoundStep(input);
  } finally {
    if (input.sessionId !== undefined) endSessionExecution(input.sessionId, input.workflowInvocationId);
  }
}
