import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./daily-fixture.mjs";
import {
  bindParticipationSession,
  createConversation,
  readConversation,
  revokeMember,
} from "../../src/long-agents/conversations/service.ts";
import { readChatSession, readChatToolResultImage } from "../../src/session-read-model.ts";
import { readSessionTranscript } from "../../src/session-transcript.ts";

test("LA5 read guards: every generic read entry refuses an unauthorized participation Session", async (t) => {
  const f = await fixture(t);
  const created = await createConversation({
    chatHome: f.home, storageProjectId: "a", title: "守卫小组", requestId: "req-read-guards",
    memberLongAgentIds: ["friend"],
  });
  const bound = await bindParticipationSession({ chatHome: f.home, storageProjectId: "a", conversationId: created.id, longAgentId: "friend" });
  // A participation Session keeps a real entry so the reads would return content if unguarded.
  const { openChatSession } = await import("../../src/chat-session.ts");
  const session = await openChatSession({ chatHome: f.home, projectId: "a", sessionId: bound.sessionId });
  session.manager.appendMessage({ role: "user", content: "PRIVATE_PARTICIPATION_ENTRY" });
  session.manager.flush();

  // Ordinary detail/history: no declared reader is refused; the owner and the current executor pass.
  await assert.rejects(readChatSession(bound.sessionId, undefined, {}, "a", f.home), /明确的读取身份/);
  const asFriend = await readChatSession(bound.sessionId, undefined, {}, "a", f.home, { kind: "friend", longAgentId: "friend" });
  assert.equal(JSON.stringify(asFriend).includes("PRIVATE_PARTICIPATION_ENTRY"), true);
  await assert.rejects(readChatSession(bound.sessionId, undefined, {}, "a", f.home, { kind: "friend", longAgentId: "stranger" }), /属于另一位参与者/);
  const asOwner = await readChatSession(bound.sessionId, undefined, {}, "a", f.home, { kind: "owner" });
  assert.equal(asOwner !== undefined, true);

  // Attachment / tool-result media reads the same guard before touching any entry.
  await assert.rejects(readChatToolResultImage(bound.sessionId, "missing-entry", 0, "a", f.home), /明确的读取身份/);
  assert.equal((await readChatToolResultImage(bound.sessionId, "missing-entry", 0, "a", f.home, { kind: "owner" })).status, "not-found");
  await assert.rejects(
    readChatToolResultImage(bound.sessionId, "missing-entry", 0, "a", f.home, { kind: "friend", longAgentId: "stranger" }),
    /属于另一位参与者/,
  );

  // History transcript: the TUI/owner entry passes the reader identity explicitly.
  await assert.rejects(readSessionTranscript({ projectId: "a", sessionId: bound.sessionId }, f.home), /明确的读取身份/);
  const transcript = await readSessionTranscript({ projectId: "a", sessionId: bound.sessionId, requester: { kind: "owner" } }, f.home);
  assert.equal(JSON.stringify(transcript).includes("PRIVATE_PARTICIPATION_ENTRY"), true);

  // Revocation takes effect on the very next read for the Friend, while the owner keeps history.
  await revokeMember({ chatHome: f.home, storageProjectId: "a", conversationId: created.id, longAgentId: "friend", expectedRevision: (await readConversation(f.home, "a", created.id)).revision });
  await assert.rejects(readChatSession(bound.sessionId, undefined, {}, "a", f.home, { kind: "friend", longAgentId: "friend" }), /成员资格已撤销/);
  await assert.rejects(readSessionTranscript({ projectId: "a", sessionId: bound.sessionId, requester: { kind: "friend", longAgentId: "friend" } }, f.home), /成员资格已撤销/);
  const ownerAfter = await readChatSession(bound.sessionId, undefined, {}, "a", f.home, { kind: "owner" });
  assert.equal(ownerAfter !== undefined, true, "history stays readable for a reader that still holds permission");
});
