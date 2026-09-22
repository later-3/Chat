import { readLongAgentState } from "./storage.js";
import { getLiveTurn, isLiveSteering, liveTurnSnapshot } from "./live-turn.js";
import type { AcceptedTurn } from "./daily-state.js";
import { openChatSession } from "../chat-session.js";
import { projectSessionContext } from "../session-read-model.js";

export function friendExecution(home: string, turn: AcceptedTurn) {
  const live = getLiveTurn(home, turn.turnId);
  return {
    schemaVersion: 1 as const,
    kind: "friend" as const,
    ...(turn.workId === undefined ? {} : { workId: turn.workId }),
    id: turn.turnId,
    longAgentId: turn.longAgentId,
    projectId: turn.longAgentId,
    sessionId: turn.sessionId,
    contextProjectId: turn.contextProjectId,
    status: turn.status,
    error: turn.error,
    acceptedAt: turn.acceptedAt,
    capabilities: {
      cancel: (turn.status === "queued" && !isLiveSteering(home, turn.turnId)) || turn.status === "running",
      steer: turn.source === "chat-web" && live?.session.isStreaming === true && !live.cancelled,
      followUp: true,
      images: live?.session.model?.input.includes("image") ?? false,
    },
  };
}
export async function findFriendTurn(home: string, longAgentId: string, id: string) {
  const turn = (await readLongAgentState(home)).turns.find(
    (item) => item.longAgentId === longAgentId && item.turnId === id,
  );
  if (turn === undefined) throw new Error("找不到此 Friend 的执行请求");
  return turn;
}
export async function readFriendFeedback(home: string, longAgentId: string, id: string) {
  const turn = await findFriendTurn(home, longAgentId, id);
  const snapshot = liveTurnSnapshot(home, id);
  if (snapshot !== undefined) return { execution: friendExecution(home, turn), snapshot };
  const session = await openChatSession({ projectId: longAgentId, sessionId: turn.sessionId, chatHome: home });
  // Check again after I/O: the worker may have started while the native Session was opening.
  return {
    execution: friendExecution(home, await findFriendTurn(home, longAgentId, id)),
    snapshot: liveTurnSnapshot(home, id) ?? {
      seq: 0,
      messages: projectSessionContext(session.manager.getEntries(), session.manager.getLeafId()).messages,
      partial: null,
      phase: { type: "agent_start" },
    },
  };
}
export async function readSessionFriendExecution(home: string, longAgentId: string, sessionId: string) {
  const turns = (await readLongAgentState(home)).turns.filter(
    (item) => item.longAgentId === longAgentId && item.sessionId === sessionId,
  );
  const turn =
    turns.find((item) => item.status === "running") ?? turns.find((item) => item.status === "queued") ?? turns.at(-1);
  return turn === undefined ? undefined : friendExecution(home, turn);
}
