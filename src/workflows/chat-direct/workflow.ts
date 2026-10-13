import type { ChatWorkflowInput, ChatWorkflowResult } from "../types.js";
import {
  beginSessionExecution,
  endSessionExecution,
} from "../execution-registry.js";
import { runChatDirectStep } from "./step.js";

/** Runs one user turn with Pi Coding Agent in the current Chat Session. */
export async function chatDirectWorkflow(
  input: ChatWorkflowInput,
): Promise<ChatWorkflowResult> {
  "use workflow";
  if (input.sessionId !== undefined) {
    beginSessionExecution(input.sessionId, "chat-direct", input.workflowInvocationId);
  }
  try {
    return await runChatDirectStep(input);
  } finally {
    if (input.sessionId !== undefined) {
      endSessionExecution(input.sessionId, input.workflowInvocationId);
    }
  }
}
