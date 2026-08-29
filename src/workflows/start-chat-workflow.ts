import { randomUUID } from "node:crypto";
import { start } from "workflow/api";
import type { ChatWorkflowHttpInput } from "../run-request.js";
import { getChatWorkflowDefinition } from "./registry.js";

/** Starts one Workflow invocation and gives all of its Stages one stable ID. */
export async function startChatWorkflow(input: ChatWorkflowHttpInput) {
  const { workflow, ...workflowInput } = input;
  const workflowInvocationId = randomUUID();
  const chatWorkflowInput = { ...workflowInput, workflowInvocationId };
  const definition = getChatWorkflowDefinition(workflow);
  if (definition === undefined) throw new Error(`找不到Workflow: ${workflow}`);
  const run = await start(definition.run, [chatWorkflowInput]);
  return { run, workflow, workflowInvocationId };
}
