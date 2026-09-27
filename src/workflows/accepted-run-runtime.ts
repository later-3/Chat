import { getWorld } from "workflow/runtime";
import { getRun } from "workflow/api";
import { startChatWorkflow } from "./start-chat-workflow.js";
import type { ChatWorkflowResult } from "./types.js";
import { abortWorkflowAgents } from "./execution-registry.js";

/** SDK transport boundary; domain tests can execute the same Workflow body in-process. */
export const acceptedRunRuntime = {
  start: startChatWorkflow,
  result: (runId: string): Promise<ChatWorkflowResult> => getRun<ChatWorkflowResult>(runId).returnValue,
  outcome: async (runId: string) => {
    const run = await getWorld().runs.get(runId, { resolveData: "none" });
    return { status: run.status, interrupted: run.error?.code === "CHAT_LOCAL_EXECUTION_INTERRUPTED" };
  },
  cancel: async (runId: string): Promise<void> => {
    await getRun(runId).cancel();
    await abortWorkflowAgents(runId);
  },
};
