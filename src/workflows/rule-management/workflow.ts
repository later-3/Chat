import type { ChatWorkflowInput, ChatWorkflowResult } from "../types.js";
import {
  beginSessionExecution,
  endSessionExecution,
} from "../execution-registry.js";
import { runRuleManagementStep } from "./step.js";

/** Runs one conversational rule-management turn in the current Chat Session. */
export async function ruleManagementWorkflow(input: ChatWorkflowInput): Promise<ChatWorkflowResult> {
  "use workflow";
  if (input.sessionId !== undefined) {
    beginSessionExecution(input.sessionId, "rule-management", input.workflowInvocationId);
  }
  try {
    return await runRuleManagementStep(input);
  } finally {
    if (input.sessionId !== undefined) {
      endSessionExecution(input.sessionId, input.workflowInvocationId);
    }
  }
}
