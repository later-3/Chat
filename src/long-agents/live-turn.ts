import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { projectAgentSessionEvent } from "../agents/session-events.js";
import { projectSessionContext, normalizeMessageForFrontend } from "../session-read-model.js";
import type { AcceptedTurn } from "./daily-state.js";

export interface FriendEvent {
  readonly schemaVersion: 1;
  readonly execution: {
    readonly kind: "friend";
    readonly id: string;
    readonly sessionId: string;
    readonly projectId: string;
  };
  readonly seq: number;
  readonly at: string;
  readonly type: "agent_event";
  readonly event: Readonly<Record<string, unknown>>;
}
interface LiveTurn {
  readonly turn: AcceptedTurn;
  readonly session: AgentSession;
  seq: number;
  events: FriendEvent[];
  messages: unknown[];
  partial: unknown | null;
  phase: Readonly<Record<string, unknown>>;
  cancelled: boolean;
  readonly steering: Set<string>;
}
const live = new Map<string, LiveTurn>();
const key = (home: string, id: string) => `${home}\0${id}`;
export function isLiveSteering(home: string, id: string) {
  return [...live.entries()].some(([entryKey, turn]) => entryKey.startsWith(`${home}\0`) && turn.steering.has(id));
}
export function getLiveTurn(home: string, id: string) {
  return live.get(key(home, id));
}

/** Disposable browser projection and Pi handles only. Durable ownership remains in the queue and native Session. */
export function registerLiveTurn(home: string, turn: AcceptedTurn, session: AgentSession, messages: unknown[]) {
  const value: LiveTurn = {
    turn,
    session,
    seq: 0,
    events: [],
    messages: [...messages],
    partial: null,
    phase: { type: "agent_start" },
    cancelled: false,
    steering: new Set(),
  };
  live.set(key(home, turn.turnId), value);
  return {
    publish(event: AgentSessionEvent) {
      if (event.type === "message_update" && "partial" in event.assistantMessageEvent)
        value.partial = structuredClone(event.assistantMessageEvent.partial);
      if (event.type === "message_start" && event.message.role === "assistant")
        value.partial = structuredClone(event.message);
      if (event.type === "message_end") {
        const message = normalizeMessageForFrontend(structuredClone(event.message));
        value.messages.push(message);
        if (event.message.role === "assistant") value.partial = null;
      }
      if (event.type === "compaction_end") {
        value.messages = projectSessionContext(
          session.sessionManager.getEntries(),
          session.sessionManager.getLeafId(),
        ).messages;
        value.partial = null;
      }
      const projected = projectAgentSessionEvent(event);
      if (projected === null) return;
      if (!["message_start", "message_end", "message_update"].includes(event.type)) value.phase = projected;
      value.events.push({
        schemaVersion: 1,
        execution: { kind: "friend", id: turn.turnId, sessionId: turn.sessionId, projectId: turn.longAgentId },
        seq: ++value.seq,
        at: new Date().toISOString(),
        type: "agent_event",
        event: projected,
      });
      // Reconnects older than this window receive an atomic replacement snapshot, never missing deltas.
      if (value.events.length > 256) value.events.splice(0, value.events.length - 256);
    },
    close() {
      if (live.get(key(home, turn.turnId)) === value) live.delete(key(home, turn.turnId));
    },
    get cancelled() {
      return value.cancelled;
    },
  };
}
export function liveTurnSnapshot(home: string, id: string) {
  const value = getLiveTurn(home, id);
  return value === undefined
    ? undefined
    : structuredClone({ seq: value.seq, messages: value.messages, partial: value.partial, phase: value.phase });
}
