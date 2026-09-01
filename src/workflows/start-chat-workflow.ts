import { randomUUID } from "node:crypto";
import { start } from "workflow/api";
import type { ChatWorkflowHttpInput } from "../run-request.js";
import { resolveProjectContext } from "../projects/registry.js";
import { bindPlanningExecutionRun } from "./planning-execution/review-state.js";
import { getChatWorkflowDefinition } from "./registry.js";

/** Starts one Workflow invocation and gives all of its Stages one stable ID. */
export async function startChatWorkflow(input: ChatWorkflowHttpInput) {
  const { workflow, ...workflowInput } = input;
  const workflowInvocationId = randomUUID();
  const chatWorkflowInput = { ...workflowInput, workflowInvocationId };
  const definition = getChatWorkflowDefinition(workflow);
  if (definition === undefined) throw new Error(`找不到Workflow: ${workflow}`);
  const run = await start(definition.run, [chatWorkflowInput]);
  if (workflow === "planning-execution" && input.projectId !== undefined) {
    const project = await resolveProjectContext(input.projectId, input.chatHome);
    await bindPlanningExecutionRun({
      projectDataDir: project.projectDataDir,
      projectId: project.projectId,
      workflowInvocationId,
      runId: run.runId,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    });
  }
  return { run, workflow, workflowInvocationId };
}
