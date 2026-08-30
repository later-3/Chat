import type { ChatWorkflowInput, ChatWorkflowResult } from "../types.js";
import { runMemoryAgentStep } from "./step.js";

/** Runs one explicit Memory Agent turn in the current Chat Session. */
export async function memoryWorkflow(
  input: ChatWorkflowInput,
): Promise<ChatWorkflowResult> {
  "use workflow";

  return runMemoryAgentStep(input);
}
