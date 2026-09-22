import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./daily-fixture.mjs";
import { systemToolAddress } from "../../src/tools/framework.ts";
import { assertConversationGrantsAllowed, LongAgentScopeError } from "../../src/long-agents/scope.ts";
import {
  bindParticipationSession,
  createConversation,
  readConversation,
  resolveParticipationScope,
  setMemberGrants,
} from "../../src/long-agents/conversations/service.ts";
import { appendConversationUserMessage } from "../../src/long-agents/conversations/public-root.ts";
import { publicationIdOf, readConversationPublicMessages } from "../../src/long-agents/conversations/publication.ts";
import { queueSpeechAttempt } from "../../src/long-agents/conversations/discussions.ts";
import { dispatchConversationAttempt } from "../../src/long-agents/conversations/dispatch.ts";

test("V12: a group speech keeps stable IDs and a duplicated inbound message never re-calls the model", async (t) => {
  const f = await fixture(t);
  const conversation = await createConversation({
    chatHome: f.home, storageProjectId: "a", title: "渠道小组", requestId: "req-v12",
    memberLongAgentIds: ["friend"],
  });
  const bound = await bindParticipationSession({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, longAgentId: "friend" });
  // The inbound user message is idempotent per clientMessageId: the same channel event is not appended twice.
  const first = await appendConversationUserMessage({
    chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, clientMessageId: "channel-event-1", text: "渠道事件",
  });
  const duplicate = await appendConversationUserMessage({
    chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, clientMessageId: "channel-event-1", text: "渠道事件",
  });
  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.message.entryId, first.message.entryId, "the stable entry id is preserved across a repeated inbound event");

  f.setHandler(() => ({ content: "V12_REPLY" }));
  const current = await readConversation(f.home, "a", conversation.id);
  await queueSpeechAttempt({
    chatHome: f.home, storageProjectId: "a", conversationId: conversation.id,
    attempt: {
      discussionId: "v12-root", attemptId: "v12-speech", policy: "mention", round: 1, speakerLongAgentId: "friend",
      participationEpoch: 1, inputCutoffEntryId: null, replyToEntryId: null, causationId: null,
      authorizationRevision: current.authorizationRevision, instruction: "reply", budget: current.budget,
    },
  });
  const callsBefore = f.requests.length;
  const dispatched = await dispatchConversationAttempt({
    chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, discussionId: "v12-root", attemptId: "v12-speech",
  });
  assert.equal(dispatched.attempt.status, "published");
  assert.equal(f.requests.length, callsBefore + 1);
  // A duplicate inbound event after the reply does not append a message or call the model again.
  const afterDuplicate = await appendConversationUserMessage({
    chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, clientMessageId: "channel-event-1", text: "渠道事件",
  });
  assert.equal(afterDuplicate.created, false);
  assert.equal(f.requests.length, callsBefore + 1, "no model call is triggered by a duplicate inbound event");

  // The publication id is deterministic from the trusted attempt + source entry, so a channel
  // association survives retries and re-reads.
  const publicationId = dispatched.publication.publicationId;
  assert.equal(publicationId, publicationIdOf({
    conversationId: conversation.id, attemptId: "v12-speech", sourceSessionId: bound.sessionId,
    sourceEntryId: dispatched.attempt.sourceEntryId, version: 1,
  }));
  const projection = await readConversationPublicMessages({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, viewerLongAgentId: null });
  assert.equal(projection.filter((message) => message.publicationId === publicationId).length, 1);
  assert.equal(projection.find((message) => message.publicationId === publicationId).text, "V12_REPLY");
});

test("V12: external group delivery capabilities are explicitly rejected in LA5", async (t) => {
  const f = await fixture(t);
  const conversation = await createConversation({
    chatHome: f.home, storageProjectId: "a", title: "外群小组", requestId: "req-v12-external",
    memberLongAgentIds: ["friend"],
  });
  await bindParticipationSession({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, longAgentId: "friend" });
  const current = await readConversation(f.home, "a", conversation.id);
  for (const grants of [
    { systemToolAddresses: [systemToolAddress("channel_send")], nativeTools: [], extensionTools: [] },
    { systemToolAddresses: [], nativeTools: [], extensionTools: ["mcp__telegram_group"] },
    { systemToolAddresses: [], nativeTools: ["bash"], extensionTools: [] },
  ]) {
    assert.throws(() => assertConversationGrantsAllowed(grants), LongAgentScopeError);
  }
  // The trusted scope itself never registers an external delivery tool in a group.
  const resolved = await resolveParticipationScope({
    chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, longAgentId: "friend", sessionId: (await readConversation(f.home, "a", conversation.id)).members[0].sessionId,
  });
  assert.deepEqual(resolved.scope.allowedTools, { systemToolAddresses: [], nativeTools: [], extensionTools: [] });
  assert.equal(resolved.scope.excludedCapabilities.some((entry) => entry.id === "channel_send"), true);
  // Writing an unsupported grant is refused at the service boundary too.
  await assert.rejects(setMemberGrants({
    chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, longAgentId: "friend",
    expectedRevision: current.revision,
    grants: { systemToolAddresses: [systemToolAddress("channel_send")], nativeTools: [], extensionTools: [] },
  }), LongAgentScopeError);
  const after = await readConversation(f.home, "a", conversation.id);
  assert.equal(after.authorizationRevision, current.authorizationRevision, "a rejected grant never changed the authorization");
});
