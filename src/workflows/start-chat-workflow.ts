import { chatSessionOwner, readChatSessionOwnerIndex } from "../session-owner.js";
import { randomUUID } from "node:crypto";
import { start } from "workflow/api";
import type { ChatWorkflowHttpInput } from "../run-request.js";
import { resolveProjectContext } from "../projects/registry.js";
import { requireActiveChatSessionFile } from "../session-state.js";
import { bindPlanningExecutionRun } from "./planning-execution/review-state.js";
import { getChatWorkflowDefinition } from "./registry.js";
import { recordChatSessionRunBinding } from "./session-run-registry.js";
import { bindWorkflowLaunch, finishWorkflowLaunch } from "./launch-binding.js";
import { topicCreationBinding } from "./topic-session-create/request.js";

/** Starts one Workflow invocation and gives all of its Stages one stable ID. */
export async function startChatWorkflow(
  input: ChatWorkflowHttpInput,
  options: { readonly workflowInvocationId?: string; readonly onRunBound?: (runId: string) => Promise<void> } = {},
) {
  const { workflow, ...workflowInput } = input;
  const workflowInvocationId = options.workflowInvocationId ?? randomUUID();
  const chatWorkflowInput = { ...workflowInput, workflowInvocationId };
  const definition = getChatWorkflowDefinition(workflow);
  if (definition === undefined) throw new Error(`找不到Workflow: ${workflow}`);
  const project = input.projectId === undefined
    ? undefined
    : await resolveProjectContext(input.projectId, input.chatHome,
      input.ownerLongAgentId === undefined ? {} : { ownerLongAgentId: input.ownerLongAgentId });
  if (project !== undefined && input.sessionId !== undefined) {
    await requireActiveChatSessionFile(project, input.sessionId);
    const owner = chatSessionOwner(await readChatSessionOwnerIndex(project.projectId, input.chatHome), input.sessionId);
    if (input.acceptedLongAgentTurn !== undefined) {
      const { requireAcceptedWorkflowTurn } = await import("./long-agent-context.js");
      const accepted = await requireAcceptedWorkflowTurn(chatWorkflowInput);
      if (accepted.workflow?.id !== workflow) throw new Error("Workflow选择与接受记录不匹配");
      const { openChatSession } = await import("../chat-session.js");
      const { installAcceptedAssembly } = await import("../long-agents/turn-queue.js");
      const session = await openChatSession(input);
      installAcceptedAssembly(session.manager, accepted, { skipCollaborationHistory: true });
      session.manager.flush();
    } else if (owner.type !== "ordinary") throw new Error("Friend会话不能通过普通Workflow入口继续；请进入Friend今天的会话");
  }
  const bind = async (runId: string) => {
    if (project !== undefined && input.sessionId !== undefined) {
      await recordChatSessionRunBinding(project.projectDataDir, {
        runId,
        workflowInvocationId,
        workflowId: workflow,
        projectId: project.projectId,
        sessionId: input.sessionId,
        ...(input.acceptedLongAgentTurn === undefined ? {} : { acceptedLongAgentTurn: input.acceptedLongAgentTurn }),
        ...(input.topicCreation === undefined ? {} : { topicCreation: topicCreationBinding(input.prompt, input.topicCreation) }),
        ...(input.sessionMemoryTarget === undefined ? {} : { sessionMemoryTarget: input.sessionMemoryTarget }),
      });
    }
    await options.onRunBound?.(runId);
  };
  const run = await start(definition.run, [chatWorkflowInput], project === undefined || input.acceptedLongAgentTurn === undefined ? undefined : {
    world: bindWorkflowLaunch({ projectDataDir: project.projectDataDir, invocationId: workflowInvocationId, bind }),
  });
  if (project === undefined || input.acceptedLongAgentTurn === undefined) await bind(run.runId);
  else await finishWorkflowLaunch(project.projectDataDir, workflowInvocationId);
  if (definition.planReview && project !== undefined) {
    await bindPlanningExecutionRun({
      projectDataDir: project.projectDataDir,
      projectId: project.projectId,
      workflowId: definition.id,
      workflowInvocationId,
      runId: run.runId,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    });
  }
  return { run, workflow, workflowInvocationId };
}
