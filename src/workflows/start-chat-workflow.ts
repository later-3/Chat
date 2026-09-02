import { randomUUID } from "node:crypto";
import { start } from "workflow/api";
import type { ChatWorkflowHttpInput } from "../run-request.js";
import { resolveProjectContext } from "../projects/registry.js";
import { requireActiveChatSessionFile } from "../session-state.js";
import { bindPlanningExecutionRun } from "./planning-execution/review-state.js";
import { getChatWorkflowDefinition } from "./registry.js";
import { recordChatSessionRunBinding } from "./session-run-registry.js";

/** Starts one Workflow invocation and gives all of its Stages one stable ID. */
export async function startChatWorkflow(input: ChatWorkflowHttpInput) {
  const { workflow, ...workflowInput } = input;
  const workflowInvocationId = randomUUID();
  const chatWorkflowInput = { ...workflowInput, workflowInvocationId };
  const definition = getChatWorkflowDefinition(workflow);
  if (definition === undefined) throw new Error(`找不到Workflow: ${workflow}`);
  const project = input.projectId === undefined
    ? undefined
    : await resolveProjectContext(input.projectId, input.chatHome);
  if (project !== undefined && input.sessionId !== undefined) {
    await requireActiveChatSessionFile(project, input.sessionId);
  }
  const run = await start(definition.run, [chatWorkflowInput]);
  if (project !== undefined && input.sessionId !== undefined) {
    await recordChatSessionRunBinding(project.projectDataDir, {
      runId: run.runId,
      workflowInvocationId,
      workflowId: workflow,
      projectId: project.projectId,
      sessionId: input.sessionId,
    });
  }
  if (workflow === "planning-execution" && project !== undefined) {
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
