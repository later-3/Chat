import type { ChatWorkflowInput, ChatWorkflowResult } from "../types.js";
import {
  beginSessionExecution,
  endSessionExecution,
} from "../execution-registry.js";
import { runPiCodingAgentPromptStep } from "./step.js";

/** Runs one user turn with Pi Coding Agent in the current Chat Session. */
export async function minimalPiCodingAgentWorkflow(
  input: ChatWorkflowInput,
): Promise<ChatWorkflowResult> {
  "use workflow";
  if (input.sessionId !== undefined) {
    beginSessionExecution(input.sessionId, "minimal-pi-coding-agent", input.workflowInvocationId);
  }
  try {
    return await runPiCodingAgentPromptStep(input);
  } finally {
    if (input.sessionId !== undefined) {
      endSessionExecution(input.sessionId, input.workflowInvocationId);
    }
  }
}
