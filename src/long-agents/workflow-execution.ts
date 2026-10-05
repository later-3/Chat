import { recordChatSessionRunBinding } from "../workflows/session-run-registry.js";
import { acceptedRunRuntime } from "../workflows/accepted-run-runtime.js";
import { resolveProjectContext } from "../projects/registry.js";
import { openChatSession } from "../chat-session.js";
import { CHAT_WORKFLOW_IDS, type ChatWorkflowId } from "../workflows/registry.js";
import { resumeWorkflowLaunch } from "../workflows/launch-binding.js";
import { withChatSessionOperationLock, chatSessionOperationKey } from "../session-operation-lock.js";
import type { AcceptedTurn } from "./daily-state.js";
import { readLongAgentState, updateLongAgentState } from "./storage.js";
import { updateTurnStatus } from "./turn-queue.js";
import { getLiveRoundHandle } from "./live-turn.js";

/** Queue admission remains durable and ordered; Workflow is the sole executor of a new round. */
export async function executeAcceptedWorkflowTurn(home: string, turn: AcceptedTurn): Promise<void> {
  if (turn.workflow === undefined) throw new Error("接受记录没有Workflow选择");
  // Workflow 执行与 Run 绑定跟随会话的真实存储项目（LA→Project→Session 时为绑定项目）。
  const project = await resolveProjectContext(turn.storageProjectId ?? turn.longAgentId, home, { ownerLongAgentId: turn.longAgentId });
  const workflow = turn.workflow;
  if (!CHAT_WORKFLOW_IDS.includes(workflow.id as ChatWorkflowId)) throw new Error("Workflow已不可用");
  const bind = async (runId: string) => {
    await recordChatSessionRunBinding(project.projectDataDir, { runId, workflowInvocationId: workflow.invocationId,
      workflowId: workflow.id, projectId: project.projectId, sessionId: turn.sessionId,
      acceptedLongAgentTurn: { longAgentId: turn.longAgentId, turnId: turn.turnId },
      sessionMemoryTarget: { storageProjectId: project.projectId, sessionId: turn.sessionId, ownerLongAgentId: turn.longAgentId } });
    await updateLongAgentState(home, state => ({ state: { ...state, turns: state.turns.map(candidate => {
      if (candidate.turnId !== turn.turnId) return candidate;
      if (candidate.workflow?.runId !== undefined && candidate.workflow.runId !== runId)
        throw new Error("同一接受记录不能绑定两个Workflow Run");
      return { ...candidate, workflow: { ...workflow, runId } };
    }) }, result: undefined }));
  };
  const resumed = await resumeWorkflowLaunch(project.projectDataDir, workflow.invocationId, bind);
  let runId = resumed ?? workflow.runId;
  if (runId === undefined) {
    const started = await acceptedRunRuntime.start({
      projectId: project.projectId, chatHome: home, cwd: project.cwd, sessionId: turn.sessionId,
      workflow: workflow.id as ChatWorkflowId, prompt: turn.text ?? "", ...(turn.images === undefined ? {} : { images: turn.images }),
      acceptedLongAgentTurn: { longAgentId: turn.longAgentId, turnId: turn.turnId },
      ownerLongAgentId: turn.longAgentId,
      ...(turn.promptCapture === "on" ? { promptCaptureEnabled: true } : {}),
      sessionMemoryTarget: { storageProjectId: project.projectId, sessionId: turn.sessionId, ownerLongAgentId: turn.longAgentId },
    }, { workflowInvocationId: workflow.invocationId, onRunBound: bind });
    runId = started.run.runId;
  }
  try {
    await acceptedRunRuntime.result(runId);
    const current = (await readLongAgentState(home)).turns.find(candidate => candidate.turnId === turn.turnId);
    const cancelled = current?.cancelRequested === true;
    await settleTopicRound(home, turn, cancelled ? "cancelled" : "completed");
    await updateTurnStatus(home, turn.turnId, cancelled ? "cancelled" : "completed");
  } catch (error) {
    const current = (await readLongAgentState(home)).turns.find(candidate => candidate.turnId === turn.turnId);
    const outcome = await acceptedRunRuntime.outcome(runId).catch(() => undefined);
    const status = current?.cancelRequested || outcome?.status === "cancelled" ? "cancelled"
      : outcome?.interrupted ? "interrupted" : "failed";
    await settleTopicRound(home, turn, status === "interrupted" ? "failed" : status);
    await updateTurnStatus(home, turn.turnId, status, error instanceof Error ? error.message : String(error));
  } finally { getLiveRoundHandle(home, turn.turnId)?.close(); }
}

async function settleTopicRound(home: string, turn: AcceptedTurn, status: "completed" | "cancelled" | "failed") {
    if (turn.topicNode !== undefined) await withChatSessionOperationLock(chatSessionOperationKey(turn.longAgentId, turn.sessionId), async () => {
      const { appendTopicRoundMarker, collectTopicRoundMarkers } = await import("./topic-anchor.js");
      const session = await openChatSession({ projectId: turn.longAgentId, chatHome: home, sessionId: turn.sessionId, ownerLongAgentId: turn.longAgentId });
      const branch = session.manager.getBranch();
      const start = branch.findIndex(entry => entry.type === "custom" && entry.customType === "chat.topic-round"
        && typeof entry.data === "object" && entry.data !== null && "roundId" in entry.data && entry.data.roundId === turn.turnId);
      const userEntryId = branch.slice(start + 1).find(entry => entry.type === "message" && entry.message.role === "user")?.id;
      if (userEntryId !== undefined && !collectTopicRoundMarkers(branch).some(marker => marker.roundId === turn.turnId && marker.status === (status))) {
        appendTopicRoundMarker(session.manager, { roundId: turn.turnId, userEntryId, status: status });
        session.manager.flush();
      }
    });
}
