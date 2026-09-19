import { openChatSession } from "../chat-session.js";
import { getLiveTurn } from "./live-turn.js";
import { findFriendTurn, friendExecution } from "./turn-feedback.js";
import { acceptLongAgentTurn, drainLongAgentTurns, updateTurnStatus } from "./turn-queue.js";
import { withFileLock } from "../persistence/versioned-file.js";
import type { AcceptedTurn } from "./daily-state.js";

export const FRIEND_STEERING = "chat.friend-steering.v1";

/** Native custom messages carry the request identity through steering, without text-based deduplication. */
export async function steerFriendTurn(
  home: string,
  agent: string,
  id: string,
  input: {
    requestId: string;
    contextProjectId: string | null;
    text: string;
  },
) {
  return withFileLock(`${home}/runtime/friend-control`, async () => {
    const target = await findFriendTurn(home, agent, id);
    if (target.source !== "chat-web" || target.contextProjectId !== input.contextProjectId)
      throw new Error("引导仅支持当前同一项目的Web执行；请使用后续消息");
    const accepted = await acceptLongAgentTurn({
      chatHome: home,
      longAgentId: agent,
      projectId: agent,
      sessionId: target.sessionId,
      turnId: input.requestId,
      contextProjectId: input.contextProjectId,
      text: input.text,
    });
    const live = getLiveTurn(home, id);
    if (accepted.newAcceptance && live?.session.isStreaming && !live.cancelled) {
      live.steering.add(accepted.turnId);
      try {
        await live.session.sendCustomMessage(
          {
            customType: FRIEND_STEERING,
            display: true,
            content: input.text,
            details: { requestTurnId: accepted.turnId, parentTurnId: id, contextProjectId: input.contextProjectId },
          },
          { deliverAs: "steer" },
        );
      } catch (error) {
        live.steering.delete(accepted.turnId);
        // The durable request still belongs to the ordinary ordered worker.
        console.error("Friend引导未入原生队列，将作为后续请求处理", error);
      }
    }
    void drainLongAgentTurns(home, agent).catch((error: unknown) => console.error("Friend队列执行失败", error));
    return {
      execution: friendExecution(home, accepted),
      delivery: live?.steering.has(accepted.turnId) ? ("steer" as const) : ("followUp" as const),
    };
  });
}

/** A consumed steering message must never become a second prompt, including after restart. */
export async function settleConsumedSteering(home: string, turn: AcceptedTurn): Promise<boolean> {
  const session = await openChatSession({ projectId: turn.longAgentId, sessionId: turn.sessionId, chatHome: home });
  const marker = session.manager
    .getEntries()
    .find(
      (entry) =>
        entry.type === "custom_message" &&
        entry.customType === FRIEND_STEERING &&
        typeof entry.details === "object" &&
        entry.details !== null &&
        "requestTurnId" in entry.details &&
        entry.details.requestTurnId === turn.turnId,
    );
  if (
    marker?.type !== "custom_message" ||
    typeof marker.details !== "object" ||
    marker.details === null ||
    !("parentTurnId" in marker.details) ||
    typeof marker.details.parentTurnId !== "string"
  )
    return false;
  const parent = await findFriendTurn(home, turn.longAgentId, marker.details.parentTurnId);
  await updateTurnStatus(
    home,
    turn.turnId,
    parent.status === "completed" ? "completed" : "interrupted",
    parent.status === "completed" ? null : "引导已进入原始会话，但该轮未正常完成；请检查历史后继续，不自动重放",
  );
  return true;
}
