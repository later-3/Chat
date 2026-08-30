import type { ChatWorkflowInput, ChatWorkflowResult } from "../types.js";
import { runRuleManagementStep } from "./step.js";

/** Runs one conversational rule-management turn in the current Chat Session. */
export async function ruleManagementWorkflow(input: ChatWorkflowInput): Promise<ChatWorkflowResult> {
  "use workflow";
  return runRuleManagementStep(input);
}
