import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { appendChatUserMessage } from "../../src/workflows/session-conversation.ts";
import { appendChatLongAgentTurn } from "../../src/long-agents/session-turn.ts";
import {
  appendTopicRoundMarker,
  readLatestTopicSettledAnchor,
  readTopicSettledAnchors,
  requireTopicAnchor,
} from "../../src/long-agents/topic-anchor.ts";

function turnData(turnId, status) {
  const terminal = status !== "running";
  return {
    turnId, longAgentId: "friend", bindingId: `bind-${turnId}`, source: "chat-web", channelType: null,
    inboundEventId: null, status, startedAt: "2026-09-24T00:00:00.000Z",
    agentGroupContext: {
      contextRevision: `sha256:${"a".repeat(64)}`, agentGroupId: "group",
      agentGroupRevision: `sha256:${"b".repeat(64)}`, indexRevision: `sha256:${"c".repeat(64)}`,
      definitionRevision: `sha256:${"d".repeat(64)}`, stale: false, fetchedAt: "2026-09-24T00:00:00.000Z",
    },
    completedAt: terminal ? "2026-09-24T00:00:05.000Z" : null,
    error: status === "failed" ? "boom" : null,
  };
}

function session() {
  const manager = SessionManager.inMemory("/tmp/topic-anchor");
  const rounds = {};
  const round = (name, status) => {
    rounds[name] = appendChatUserMessage(manager, `问题 ${name}`);
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: `答 ${name}` }], timestamp: Date.now() });
    appendChatLongAgentTurn(manager, turnData(`turn-${name}`, status));
    return rounds[name];
  };
  return { manager, rounds, round };
}

test("P2 anchors: only fully completed rounds are forkable", (t) => {
  const { manager, rounds, round } = session();
  round("a", "completed");
  round("b", "running");
  round("c", "failed");
  round("d", "completed");

  const anchors = readTopicSettledAnchors(manager);
  assert.deepEqual(anchors.map((anchor) => anchor.anchorSequence), [1, 2]);
  assert.equal(anchors[0].anchorEntryId, rounds.a);
  assert.equal(anchors[1].anchorEntryId, rounds.d);
  assert.equal(anchors[0].turnId, "turn-a");
  assert.equal(anchors[1].settledAt, "2026-09-24T00:00:05.000Z");
  assert.equal(readLatestTopicSettledAnchor(manager).anchorEntryId, rounds.d);

  // A completed round is forkable; a running or failed one is not, and neither is an assistant entry.
  assert.equal(requireTopicAnchor(manager, { anchorEntryId: rounds.a, anchorSequence: 1 }).turnId, "turn-a");
  assert.throws(() => requireTopicAnchor(manager, { anchorEntryId: rounds.d, anchorSequence: null }), /必须同时提供 entry 与序号/);
  assert.equal(requireTopicAnchor(manager, { anchorEntryId: rounds.d, anchorSequence: 2 }).anchorSequence, 2);
  assert.throws(() => requireTopicAnchor(manager, { anchorEntryId: rounds.b, anchorSequence: 1 }), /锚点不是已完成的轮次/);
  assert.throws(() => requireTopicAnchor(manager, { anchorEntryId: rounds.c, anchorSequence: 1 }), /锚点不是已完成的轮次/);
  assert.throws(() => requireTopicAnchor(manager, { anchorEntryId: rounds.a, anchorSequence: null }), /必须同时提供 entry 与序号/);
  assert.throws(() => requireTopicAnchor(manager, { anchorEntryId: rounds.a, anchorSequence: 2 }), /锚点序号不一致/);
  // "From the start" is a null anchor, and a sequence without an entry is a mistake.
  assert.equal(requireTopicAnchor(manager, { anchorEntryId: null, anchorSequence: null }), null);
  assert.throws(() => requireTopicAnchor(manager, { anchorEntryId: null, anchorSequence: 3 }), /起始锚点不能带序号/);
  assert.throws(() => requireTopicAnchor(manager, { anchorEntryId: "entry-does-not-exist", anchorSequence: 1 }), /锚点不是已完成的轮次/);
});

test("P2 anchors: a failed retry of the same round does not add a second anchor", (t) => {
  const { manager, rounds, round } = session();
  const anchor = round("a", "completed");
  // A later retry of the SAME round appends another marker after the same user entry.
  appendChatLongAgentTurn(manager, turnData("turn-a-retry", "failed"));
  const anchors = readTopicSettledAnchors(manager);
  assert.equal(anchors.length, 1, "the round keeps one anchor");
  assert.equal(anchors[0].anchorEntryId, anchor);
  assert.equal(anchors[0].turnId, "turn-a");
});

test("P2 anchors: the outer round marker settles a whole work+remember round", (t) => {
  const manager = SessionManager.inMemory("/tmp/topic-anchor-round");
  const first = appendChatUserMessage(manager, "第一轮");
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "答" }], timestamp: Date.now() });
  // The workflow writes the round fact explicitly bound to this round's user entry.
  appendTopicRoundMarker(manager, { roundId: "round-1", userEntryId: first, status: "completed" });
  const second = appendChatUserMessage(manager, "第二轮");
  appendTopicRoundMarker(manager, { roundId: "round-2", userEntryId: second, status: "running" });

  const anchors = readTopicSettledAnchors(manager);
  assert.deepEqual(anchors.map((anchor) => [anchor.anchorEntryId, anchor.anchorSequence]), [[first, 1]]);
  assert.equal(requireTopicAnchor(manager, { anchorEntryId: first, anchorSequence: 1 }).turnId, "round-1");
  // A round whose `remember` step has not finished is not forkable.
  assert.throws(() => requireTopicAnchor(manager, { anchorEntryId: second, anchorSequence: 2 }), /锚点不是已完成的轮次/);
  appendTopicRoundMarker(manager, { roundId: "round-2", userEntryId: second, status: "completed" });
  assert.deepEqual(readTopicSettledAnchors(manager).map((anchor) => anchor.anchorSequence), [1, 2]);

  // A round marker that points at an ASSISTANT entry is not an anchor (and cannot be written at all).
  const fourth = appendChatUserMessage(manager, "第四轮");
  const assistantId = manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "答" }], timestamp: Date.now() });
  assert.throws(() => appendTopicRoundMarker(manager, { roundId: "round-bad", userEntryId: assistantId, status: "completed" }),
    /轮次锚点不是用户消息/);
  // Even if such a marker reaches the file some other way, the reader ignores it.
  manager.appendCustomEntry("chat.topic-round", { roundId: "round-bad", userEntryId: assistantId, status: "completed", settledAt: "2026-09-24T00:00:05.000Z" });
  assert.equal(readTopicSettledAnchors(manager).some((anchor) => anchor.anchorEntryId === assistantId), false);
  assert.equal(readTopicSettledAnchors(manager).some((anchor) => anchor.anchorEntryId === fourth), false);

  // A Long Agent turn marker and a round marker for the same user entry are one anchor, not two.
  const third = appendChatUserMessage(manager, "第三轮");
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "答" }], timestamp: Date.now() });
  appendChatLongAgentTurn(manager, {
    turnId: "turn-3", longAgentId: "friend", bindingId: "bind-3", source: "chat-web", channelType: null,
    inboundEventId: null, status: "completed", startedAt: "2026-09-24T00:00:00.000Z", completedAt: "2026-09-24T00:00:05.000Z", error: null,
    agentGroupContext: { contextRevision: `sha256:${"a".repeat(64)}`, agentGroupId: "group", agentGroupRevision: `sha256:${"b".repeat(64)}`,
      indexRevision: `sha256:${"c".repeat(64)}`, definitionRevision: `sha256:${"d".repeat(64)}`, stale: false, fetchedAt: "2026-09-24T00:00:00.000Z" },
  });
  appendTopicRoundMarker(manager, { roundId: "round-3", userEntryId: third, status: "completed" });
  assert.deepEqual(readTopicSettledAnchors(manager).map((anchor) => anchor.anchorSequence), [1, 2, 3]);
});
