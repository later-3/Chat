import type { Message } from "@ag-ui/core";

import type { RuntimeEventEnvelope } from "./session-api.js";

export class RuntimeReplayGapError extends Error {}
export class RuntimeReplayConflictError extends Error {}

export interface RuntimeReplayState {
  attemptId: string;
  lastSequence: number;
  hashes: Map<number, string>;
  messages: Message[];
  lastTerminal: Record<string, unknown> | null;
}

function cloneMessages(values: Message[]): Message[] {
  return structuredClone(values);
}

/** Apply only public chat events; Workflow activity remains a Trace projection. */
export function replayRuntimeEvents(
  state: RuntimeReplayState,
  events: RuntimeEventEnvelope[],
): RuntimeReplayState {
  const next: RuntimeReplayState = {
    ...state,
    hashes: new Map(state.hashes),
    messages: cloneMessages(state.messages),
  };
  for (const envelope of events) {
    if (envelope.run_attempt_id !== next.attemptId) {
      throw new RuntimeReplayConflictError("事件属于另一个Run Attempt");
    }
    const knownHash = next.hashes.get(envelope.sequence);
    if (knownHash) {
      if (knownHash !== envelope.payload_hash) {
        throw new RuntimeReplayConflictError("相同Sequence出现不同Payload Hash");
      }
      continue;
    }
    if (envelope.sequence !== next.lastSequence + 1) {
      throw new RuntimeReplayGapError(
        `Runtime事件缺口：期望${next.lastSequence + 1}，收到${envelope.sequence}`,
      );
    }
    next.hashes.set(envelope.sequence, envelope.payload_hash);
    next.lastSequence = envelope.sequence;
    const event = envelope.payload;
    const type = String(event.type ?? "");
    if (type === "TEXT_MESSAGE_START") {
      const messageId = String(event.messageId ?? "");
      if (messageId && !next.messages.some((message) => message.id === messageId)) {
        next.messages.push({ id: messageId, role: "assistant", content: "" });
      }
    } else if (type === "TEXT_MESSAGE_CONTENT") {
      const message = next.messages.find((value) => value.id === String(event.messageId ?? ""));
      if (message && typeof message.content === "string") {
        message.content += String(event.delta ?? "");
      }
    } else if (type === "MESSAGES_SNAPSHOT" && Array.isArray(event.messages)) {
      next.messages = cloneMessages(event.messages as Message[]);
    } else if (type === "RUN_STARTED") {
      next.lastTerminal = null;
    } else if (type === "RUN_FINISHED" || type === "RUN_ERROR") {
      next.lastTerminal = event;
    }
  }
  return next;
}
