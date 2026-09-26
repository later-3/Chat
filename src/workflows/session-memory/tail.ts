import type { ChatWorkflowInput, ChatWorkflowResult } from "../types.js";
// STATIC import: the Workflow runtime registers Steps by static analysis of the Workflow module graph.
// The Workflow BODY may not import Node built-ins (the Builder rejects it), so the tail only decides and
// delegates; everything that touches the filesystem lives inside the Step.
import { runSessionMemoryRememberStep } from "./step.js";
import { memoryTailFollows } from "./tail-policy.js";

/**
 * The LAST node of every interactive Workflow: after the answering stage has finished, the SAME Session
 * runs the session-memory writer (declared as the `remember` node in each workflow.json).
 *
 * The WORK answer is the round's answer, but the memory node is part of the round: it is awaited, and a
 * failure or cancellation is reported honestly (never rewritten as success) by the Step itself.
 */
export async function runSessionMemoryTail(
  input: ChatWorkflowInput,
  result: ChatWorkflowResult,
  ownerWorkflowId: string,
): Promise<ChatWorkflowResult> {
  if (!memoryTailFollows(input)) return result;
  await runSessionMemoryRememberStep({ ...input, sessionId: result.sessionId, sessionMemoryOwnerWorkflowId: ownerWorkflowId });
  return result;
}
