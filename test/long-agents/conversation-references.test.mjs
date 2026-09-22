import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fixture } from "./daily-fixture.mjs";
import { openChatSession } from "../../src/chat-session.ts";
import { bindParticipationSession, createConversation, readConversation } from "../../src/long-agents/conversations/service.ts";
import { blockHash, publishConversationSpeech, readConversationPublicMessages } from "../../src/long-agents/conversations/publication.ts";
import { readDiscussionState } from "../../src/long-agents/conversations/discussions.ts";

async function setup(f, requestId) {
  const conversation = await createConversation({
    chatHome: f.home, storageProjectId: "a", title: "引用小组", requestId, memberLongAgentIds: ["friend"],
  });
  const bound = await bindParticipationSession({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, longAgentId: "friend" });
  const session = await openChatSession({ chatHome: f.home, projectId: "a", sessionId: bound.sessionId });
  session.manager.appendMessage({ role: "assistant", content: "V9_PUBLISHED_BLOCK", timestamp: Date.now() });
  session.manager.flush();
  const entry = session.manager.getEntries().filter((candidate) => candidate.type === "message" && candidate.message.role === "assistant").at(-1);
  const current = await readConversation(f.home, "a", conversation.id);
  await publishConversationSpeech({
    chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, longAgentId: "friend",
    attemptId: "v9-attempt", participationEpoch: 1, authorizationRevision: current.authorizationRevision,
    sourceSessionId: bound.sessionId, sourceEntryId: entry.id, text: "V9_PUBLISHED_BLOCK",
  });
  return { conversation, bound, session, entryId: entry.id };
}

test("V9: a published reference survives compaction and branching without republishing or re-metering", async (t) => {
  const f = await fixture(t);
  const { conversation, bound, session, entryId } = await setup(f, "v9-compaction");
  const before = await readConversationPublicMessages({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, viewerLongAgentId: null });
  assert.equal(before.filter((message) => message.publicationId !== null).length, 1);
  const sourceEntry = session.manager.getEntry(entryId);
  assert.equal(blockHash(String(entryText(sourceEntry))), blockHash("V9_PUBLISHED_BLOCK"));

  // Compaction does not delete native entries; the projection still resolves the published block.
  session.manager.appendCompaction("compacted history", entryId, 1234);
  session.manager.flush();
  const compacted = await readConversationPublicMessages({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, viewerLongAgentId: null });
  assert.equal(compacted.filter((message) => message.publicationId !== null).length, 1);
  assert.equal(compacted.find((message) => message.publicationId !== null).text, "V9_PUBLISHED_BLOCK");

  // A new branch in the participation Session neither republishes the old block nor duplicates it.
  session.manager.branch(entryId);
  session.manager.appendMessage({ role: "assistant", content: "V9_BRANCH_DRAFT", timestamp: Date.now() });
  session.manager.flush();
  const branched = await readConversationPublicMessages({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, viewerLongAgentId: null });
  assert.equal(branched.filter((message) => message.publicationId !== null).length, 1, "a branch never republishes the previous block");
  assert.equal(JSON.stringify(branched).includes("V9_BRANCH_DRAFT"), false, "an unpublished branch draft stays private");

  // Re-publishing the same source entry is idempotent (lost receipt recovery, no model call).
  const current = await readConversation(f.home, "a", conversation.id);
  const repeat = await publishConversationSpeech({
    chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, longAgentId: "friend",
    attemptId: "v9-attempt", participationEpoch: 1, authorizationRevision: current.authorizationRevision,
    sourceSessionId: bound.sessionId, sourceEntryId: entryId, text: "V9_PUBLISHED_BLOCK",
  });
  assert.equal(repeat.created, false);
  assert.equal((await readConversationPublicMessages({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, viewerLongAgentId: null })).filter((message) => message.publicationId !== null).length, 1);
  assert.equal((await readDiscussionState(f.home, "a", conversation.id)).discussions.length, 0, "reference resolution performs no model work");
});

test("V9: an unavailable source shows an unavailable reference and never falls back to private history", async (t) => {
  const f = await fixture(t);
  const { conversation, bound } = await setup(f, "v9-missing-source");
  // Private content that must not be used as a fallback.
  const session = await openChatSession({ chatHome: f.home, projectId: "a", sessionId: bound.sessionId });
  session.manager.appendMessage({ role: "assistant", content: "V9_PRIVATE_AFTER_PUBLISH", timestamp: Date.now() });
  session.manager.flush();
  const sourceFile = session.manager.getSessionFile();
  assert.equal(typeof sourceFile, "string");
  fs.rmSync(sourceFile, { force: true });
  const projection = await readConversationPublicMessages({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, viewerLongAgentId: null });
  const reference = projection.find((message) => message.publicationId !== null);
  assert.equal(reference.text, null, "an unavailable source is reported, not silently replaced");
  assert.match(reference.unavailableReason, /源 Session 不可读|源条目/);
  assert.equal(JSON.stringify(projection).includes("V9_PRIVATE_AFTER_PUBLISH"), false, "the projection never falls back to private Session history");
});

function entryText(entry) {
  if (entry?.type === "message" && typeof entry.message?.content === "string") return entry.message.content;
  return "";
}
