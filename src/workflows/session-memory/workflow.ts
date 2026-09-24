import type { ChatWorkflowInput, ChatWorkflowResult } from "../types.js";
import { beginSessionExecution, endSessionExecution } from "../execution-registry.js";
import { runSessionMemoryRememberStep, runSessionMemoryWorkStep } from "./step.js";

/**
 * One round of a topic node session: `work` then `remember`, in this order, in the same Session. The
 * invocation is the unit of settlement: a forkable round needs BOTH stages to finish.
 */
export async function sessionMemoryWorkflow(input: ChatWorkflowInput): Promise<ChatWorkflowResult> {
  "use workflow";
  if (input.sessionId !== undefined) {
    beginSessionExecution(input.sessionId, "session-memory", input.workflowInvocationId);
  }
  try {
    const worked = await runSessionMemoryWorkStep(input);
    // Both stages MUST run in the SAME node Session: the work stage resolves the Session when the caller
    // did not name one (a fresh node round), so the resolved id is forwarded or `remember` would open a
    // second, empty Session and project nothing.
    await runSessionMemoryRememberStep({ ...input, sessionId: worked.sessionId });
    // The round's answer is the WORK answer: the user asked a question, not for a bookkeeping report.
    // The memory write stays in the Session (its own stage records and the writer's visible reply), and
    // the invocation is still settled only when BOTH stages finished (awaited above).
    return worked;
  } finally {
    if (input.sessionId !== undefined) endSessionExecution(input.sessionId, input.workflowInvocationId);
  }
}
