import type { ChatWorkflowInput, ChatWorkflowResult } from "../types.js";
import { runPiCodingAgentPromptStep } from "./step.js";

/** Runs one user turn with Pi Coding Agent in the current Chat Session. */
export async function minimalPiCodingAgentWorkflow(
  input: ChatWorkflowInput,
): Promise<ChatWorkflowResult> {
  "use workflow";

  return runPiCodingAgentPromptStep(input);
}
