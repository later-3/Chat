import { getWorld } from "workflow/runtime";
import { WorkflowRunNotFoundError } from "workflow/errors";
import { resolveProjectContext } from "../../projects/registry.js";
import { readTopicGraph } from "../../long-agents/topics.js";
import { listChatSessionRunBindings } from "../session-run-registry.js";
import { getPlanningExecutionRun } from "../planning-execution/review-state.js";

/** Read projection of existing Run bindings. No creation queue, approval store or status mirror. */
export async function listTopicCreationRequests(chatHome: string, longAgentId: string, sourceSessionId?: string) {
  const project = await resolveProjectContext(longAgentId, chatHome);
  if (project.kind !== "agent") throw new Error("主题创建只属于 Friend");
  const bindings = (await listChatSessionRunBindings(project.projectDataDir))
    .filter(binding => binding.workflowId === "topic-session-create" && binding.topicCreation !== undefined
      && (sourceSessionId === undefined || binding.topicCreation.sourceSessionId === sourceSessionId))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const graph = await readTopicGraph(chatHome, longAgentId);
  return Promise.all(bindings.map(async (binding) => {
    const [run, planning] = await Promise.all([
      getWorld().runs.get(binding.runId, { resolveData: "none" }).catch((error: unknown) => {
        if (WorkflowRunNotFoundError.is(error)) return undefined;
        throw error;
      }),
      getPlanningExecutionRun(project.projectDataDir, binding.workflowInvocationId),
    ]);
    const terminal = run === undefined || ["completed", "failed", "cancelled"].includes(run.status);
    const node = graph.nodes.find(candidate => candidate.createdByRequestId === binding.topicCreation!.requestId);
    return {
      requestId: binding.topicCreation!.requestId, sourceSessionId: binding.topicCreation!.sourceSessionId,
      prepareSessionId: binding.sessionId, runId: binding.runId, workflowInvocationId: binding.workflowInvocationId,
      startedAt: binding.startedAt, status: run?.status ?? "interrupted",
      phase: terminal ? null : planning?.phase ?? "collecting",
      review: !terminal && planning?.phase === "waiting_review" ? planning.currentReview ?? null : null,
      error: run === undefined ? "执行记录暂不可用，请保留准备会话并核实" : run.error?.message ?? null,
      node: node === undefined ? null : { topicId: node.topicId, nodeId: node.nodeId, sessionId: node.sessionId, title: node.title },
    };
  }));
}
