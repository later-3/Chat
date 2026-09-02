import type { ChatWorkflowInput, ChatWorkflowResult } from "../types.js";
import {
  beginSessionExecution,
  endSessionExecution,
} from "../execution-registry.js";
import { runMemoryAgentStep } from "./step.js";

/** Runs one explicit Memory Agent turn in the current Chat Session. */
export async function memoryWorkflow(
  input: ChatWorkflowInput,
): Promise<ChatWorkflowResult> {
  "use workflow";
  if (input.sessionId !== undefined) {
    beginSessionExecution(input.sessionId, "memory", input.workflowInvocationId);
  }
  try {
    return await runMemoryAgentStep(input);
  } finally {
    if (input.sessionId !== undefined) {
      endSessionExecution(input.sessionId, input.workflowInvocationId);
    }
  }
}
