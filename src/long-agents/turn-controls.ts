import { updateLongAgentState } from "./storage.js";
import { openChatSession } from "../chat-session.js";
import { getLiveTurn } from "./live-turn.js";
import { findFriendTurn, friendExecution } from "./turn-feedback.js";
import { acceptLongAgentTurn, drainLongAgentTurns, updateTurnStatus } from "./turn-queue.js";
import { withFileLock } from "../persistence/versioned-file.js";
import type { AcceptedTurn } from "./daily-state.js";

export const FRIEND_STEERING = "chat.friend-steering.v1";

export async function cancelFriendTurn(home: string, agent: string, id: string) {
  await updateLongAgentState(home, state => {
    const target = state.turns.find(t => t.longAgentId === agent && t.turnId === id);
    if (!target) throw new Error("找不到执行请求");
    if (target.status === "queued" && state.turns.some(t => getLiveTurn(home, t.turnId)?.steering.has(id)))
      throw new Error("引导已进入原生队列，请取消当前执行");
    return { state: { ...state, turns: state.turns.map(turn => {
      if (turn !== target || !["queued", "running"].includes(turn.status)) return turn;
      if (turn.status === "running") return { ...turn, cancelRequested: true };
      const { text: _text, images: _images, seed: _seed, ...receipt } = turn;
      return { ...receipt, status: "cancelled" as const, settledAt: new Date().toISOString(), cancelRequested: true };
    }) }, result: undefined };
  });
  const live = getLiveTurn(home, id);
  if (live) { live.cancelled = true; await live.session.abort(); }
  return friendExecution(home, await findFriendTurn(home, agent, id));
}

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
    // A topic node turn OWNS its target: the frozen collaboration project comes from the durable turn,
    // never from the client, and the steering turn keeps the node binding so it cannot drift into the
    // ordinary private-chat path.
    const topicNode = target.topicNode;
    const contextProjectId = topicNode === undefined ? input.contextProjectId : target.contextProjectId;
    if (target.source !== "chat-web" || (topicNode === undefined && target.contextProjectId !== input.contextProjectId))
      throw new Error("引导仅支持当前同一项目的Web执行；请使用后续消息");
    const accepted = await acceptLongAgentTurn({
      chatHome: home,
      longAgentId: agent,
      projectId: agent,
      ...(topicNode === undefined ? { sessionId: target.sessionId } : {}),
      turnId: input.requestId,
      contextProjectId,
      text: input.text,
      ...(topicNode === undefined ? {} : { topicNode }),
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
            details: { requestTurnId: accepted.turnId, parentTurnId: id, contextProjectId },
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
