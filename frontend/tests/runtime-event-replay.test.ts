import assert from "node:assert/strict";
import test from "node:test";

import {
  RuntimeReplayConflictError,
  RuntimeReplayGapError,
  type RuntimeReplayState,
  replayRuntimeEvents,
} from "../src/runtime-event-replay.js";
import type { RuntimeEventEnvelope } from "../src/session-api.js";

function event(
  sequence: number,
  payload: Record<string, unknown>,
  hash = `hash-${sequence}`,
): RuntimeEventEnvelope {
  return {
    id: `event-${sequence}`,
    runtime_job_id: "job-1",
    run_attempt_id: "attempt-1",
    sequence,
    event_type: String(payload.type),
    payload,
    payload_hash: hash,
    is_terminal: payload.type === "RUN_FINISHED",
    cursor: `cursor-${sequence}`,
  };
}

function initial(): RuntimeReplayState {
  return {
    attemptId: "attempt-1",
    lastSequence: 0,
    hashes: new Map(),
    messages: [{ id: "user-1", role: "user", content: "问题" }],
    lastTerminal: null,
  };
}

test("游标回放按Sequence恢复文本并忽略同Hash重复事件", () => {
  const first = replayRuntimeEvents(initial(), [
    event(1, { type: "RUN_STARTED" }),
    event(2, { type: "TEXT_MESSAGE_START", messageId: "assistant-1" }),
    event(3, { type: "TEXT_MESSAGE_CONTENT", messageId: "assistant-1", delta: "答案" }),
  ]);
  const replayed = replayRuntimeEvents(first, [
    event(3, { type: "TEXT_MESSAGE_CONTENT", messageId: "assistant-1", delta: "答案" }),
    event(4, { type: "TEXT_MESSAGE_END", messageId: "assistant-1" }),
    event(5, { type: "RUN_FINISHED" }),
  ]);
  assert.equal(replayed.lastSequence, 5);
  assert.equal(replayed.messages[1].content, "答案");
  assert.equal(replayed.lastTerminal?.type, "RUN_FINISHED");
});

test("事件缺口和同Sequence不同Hash都失败关闭", () => {
  assert.throws(
    () => replayRuntimeEvents(initial(), [event(2, { type: "RUN_STARTED" })]),
    RuntimeReplayGapError,
  );
  const first = replayRuntimeEvents(initial(), [event(1, { type: "RUN_STARTED" })]);
  assert.throws(
    () => replayRuntimeEvents(first, [event(1, { type: "RUN_STARTED" }, "changed")]),
    RuntimeReplayConflictError,
  );
});

test("Checkpoint恢复的新RUN_STARTED会清除上一段的Interrupt终帧", () => {
  const interrupted = replayRuntimeEvents(initial(), [
    event(1, { type: "RUN_STARTED" }),
    event(2, { type: "RUN_FINISHED", outcome: { type: "interrupt", interrupts: [] } }),
  ]);
  assert.equal(interrupted.lastTerminal?.type, "RUN_FINISHED");

  const resumed = replayRuntimeEvents(interrupted, [event(3, { type: "RUN_STARTED" })]);
  assert.equal(resumed.lastTerminal, null);
  assert.equal(resumed.lastSequence, 3);
});
