import { randomUUID } from "node:crypto";
import { start } from "workflow/api";
import type { ChatWorkflowHttpInput } from "../run-request.js";
import { minimalPiCodingAgentWorkflow } from "./minimal-pi-coding-agent.js";
import { planningExecutionWorkflow } from "./planning-execution.js";

/** Starts one Workflow invocation and gives all of its Stages one stable ID. */
export async function startChatWorkflow(input: ChatWorkflowHttpInput) {
  const { workflow, ...workflowInput } = input;
  const workflowInvocationId = randomUUID();
  const chatWorkflowInput = { ...workflowInput, workflowInvocationId };
  const run = workflow === "planning-execution"
    ? await start(planningExecutionWorkflow, [chatWorkflowInput])
    : await start(minimalPiCodingAgentWorkflow, [chatWorkflowInput]);
  return { run, workflow, workflowInvocationId };
}
