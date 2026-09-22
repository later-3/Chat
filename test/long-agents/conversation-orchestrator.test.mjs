import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./daily-fixture.mjs";
import { readLongAgentRegistry, writeLongAgentRegistry } from "../../src/long-agents/storage.ts";
import {
  createConversation,
  readConversation,
} from "../../src/long-agents/conversations/service.ts";
import { readDiscussionState, stopDiscussion } from "../../src/long-agents/conversations/discussions.ts";
import {
  parseModeratorChoice,
  runConversationConsultation,
  runConversationDiscussion,
} from "../../src/long-agents/conversations/orchestrator.ts";
import { drainConversationAttempts } from "../../src/long-agents/conversations/dispatch.ts";
import { readConversationPublicMessages } from "../../src/long-agents/conversations/publication.ts";

async function addSecondFriend(f) {
  const registry = await readLongAgentRegistry(f.home);
  if (registry.agents.some((candidate) => candidate.id === "friend2")) return;
  const first = registry.agents[0];
  await writeLongAgentRegistry({ ...registry, agents: [...registry.agents, {
    ...first, id: "friend2", name: "Friend2", nanoclawAgentGroupId: "group2", defaultProjectId: "friend2",
    definition: { ...first.definition, id: "friend2", name: "Friend2" },
  }] }, f.home);
}

async function group(f, { requestId, policy, budget } = {}) {
  await addSecondFriend(f);
  return createConversation({
    chatHome: f.home, storageProjectId: "a", title: "编排小组", requestId: requestId ?? `req-${Math.random()}`,
    memberLongAgentIds: ["friend", "friend2"],
    ...(policy === undefined ? {} : { policy }),
    ...(budget === undefined ? {} : { budget }),
  });
}

async function attemptsOf(f, conversation, discussionId) {
  const state = await readDiscussionState(f.home, "a", conversation.id);
  return state.discussions.find((d) => d.discussionId === discussionId)?.attempts ?? [];
}

async function publicTexts(f, conversation) {
  return (await readConversationPublicMessages({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, viewerLongAgentId: null }))
    .map((message) => message.text);
}

const lastUserText = (body) => {
  const messages = body.messages ?? [];
  const last = [...messages].reverse().find((message) => message.role === "user");
  return typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
};

test("LA5 orchestrator: mention targets only the named member and never broadcasts", async (t) => {
  const f = await fixture(t);
  const conversation = await group(f, { requestId: "req-orch-mention" });
  f.setHandler(() => ({ content: "MENTION_REPLY" }));
  const result = await runConversationDiscussion({
    chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, discussionId: "disc-mention",
    policy: "mention", targets: ["friend"],
  });
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].status, "published");
  assert.equal(result.attempts[0].speakerLongAgentId, "friend");
  assert.equal((await publicTexts(f, conversation)).includes("MENTION_REPLY"), true);
  // With no explicit target, mention does not wake everyone.
  const bare = await runConversationDiscussion({
    chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, discussionId: "disc-mention-bare",
    policy: "mention", targets: [],
  });
  assert.equal(bare.attempts.length, 0);
  assert.match(bare.stopReason, /未指定@目标/);
  assert.equal(f.requests.length, 1, "no broadcast model call was made");
});

test("LA5 orchestrator: round-robin runs each member once per round and stops at maxRounds", async (t) => {
  const f = await fixture(t);
  const conversation = await group(f, { requestId: "req-orch-rr", budget: { maxRounds: 2 } });
  let call = 0;
  f.setHandler(() => ({ content: `RR_${String(++call)}` }));
  const result = await runConversationDiscussion({
    chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, discussionId: "disc-rr", policy: "round-robin",
  });
  const attempts = await attemptsOf(f, conversation, "disc-rr");
  assert.equal(attempts.length, 4, "two members twice");
  assert.equal(attempts.every((attempt) => attempt.status === "published"), true);
  assert.match(result.stopReason, /达到最大轮数/);
  assert.ok(lastUserText(f.requests[1]).includes("RR_1"), "the next speaker sees the preceding publication in the same round");
  assert.ok(attempts.filter((attempt) => attempt.inputCutoffEntryId !== null).length >= 3,
    "sequential speakers persist the public input cutoff they actually consumed");
  // The second round reads the first round's committed messages.
  const secondRound = f.requests.filter((body) => lastUserText(body).includes("RR_1"));
  assert.ok(secondRound.length >= 1, "later rounds see earlier published messages");
});

test("LA5 orchestrator: parallel members share one frozen input cutoff", async (t) => {
  const f = await fixture(t);
  const conversation = await group(f, { requestId: "req-orch-parallel", budget: { maxConcurrentSpeakers: 2 } });
  let call = 0;
  f.setHandler(() => ({ content: `PAR_${String(++call)}` }));
  const result = await runConversationDiscussion({
    chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, discussionId: "disc-parallel", policy: "parallel",
  });
  assert.equal(result.attempts.length, 2);
  assert.equal(result.attempts.every((attempt) => attempt.status === "published"), true);
  assert.equal(f.requests.length, 2);
  // Neither instruction could have contained the other's not-yet-committed answer.
  for (const body of f.requests) assert.equal(lastUserText(body).includes("PAR_"), false);
});

test("LA5 orchestrator: moderator picks the next speaker from its own output and rejects illegal choices", async (t) => {
  const f = await fixture(t);
  const conversation = await group(f, {
    requestId: "req-orch-mod", policy: { defaultPolicy: "moderator", moderatorLongAgentId: "friend", roundRobinOrder: ["friend", "friend2"] },
  });
  let call = 0;
  f.setHandler(() => ({ content: call++ === 0 ? "<next>friend2</next>\nMOD_ONE" : "CHOSEN_REPLY" }));
  const result = await runConversationDiscussion({
    chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, discussionId: "disc-mod",
  });
  const attempts = await attemptsOf(f, conversation, "disc-mod");
  assert.deepEqual(attempts.map((attempt) => attempt.speakerLongAgentId), ["friend", "friend2"]);
  assert.equal(attempts.every((attempt) => attempt.status === "published"), true);
  assert.match(result.stopReason, /主持轮完成/);
  assert.equal(parseModeratorChoice("<next>stranger</next>", ["friend2"]), null);

  const strict = await group(f, {
    requestId: "req-orch-mod-bad", policy: { defaultPolicy: "moderator", moderatorLongAgentId: "friend", roundRobinOrder: ["friend", "friend2"] },
  });
  f.setHandler(() => ({ content: "<next>stranger</next>\nBAD_CHOICE" }));
  const bad = await runConversationDiscussion({
    chatHome: f.home, storageProjectId: "a", conversationId: strict.id, discussionId: "disc-mod-bad",
  });
  assert.match(bad.stopReason, /主持未能给出合法的下一位成员/);
  const badAttempts = await attemptsOf(f, strict, "disc-mod-bad");
  assert.equal(badAttempts.every((attempt) => attempt.speakerLongAgentId === "friend"), true, "an illegal choice never dispatches the named stranger");
});

test("LA5 orchestrator: free discussion allows silence and still terminates", async (t) => {
  const f = await fixture(t);
  const conversation = await group(f, { requestId: "req-orch-free", budget: { maxRounds: 1 } });
  f.setHandler((body) => ({ content: lastUserText(body).includes("身份是 Friend friend。") ? "<silent/>" : "FREE_REPLY" }));
  const result = await runConversationDiscussion({
    chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, discussionId: "disc-free", policy: "free",
  });
  const attempts = await attemptsOf(f, conversation, "disc-free");
  const silent = attempts.find((attempt) => attempt.speakerLongAgentId === "friend");
  const spoke = attempts.find((attempt) => attempt.speakerLongAgentId === "friend2");
  assert.equal(silent.status, "skipped");
  assert.match(silent.reason, /选择不发言/);
  assert.equal(spoke.status, "published");
  assert.equal((await publicTexts(f, conversation)).includes("FREE_REPLY"), true);
  assert.equal((await publicTexts(f, conversation)).includes("<silent/>"), false, "silence never enters the public stream");
  assert.match(result.stopReason, /达到最大轮数/);
});

test("LA5 orchestrator: the frozen budget stops further model calls", async (t) => {
  const f = await fixture(t);
  const conversation = await group(f, { requestId: "req-orch-budget", budget: { maxModelCalls: 1 } });
  f.setHandler(() => ({ content: "BUDGET_REPLY" }));
  const result = await runConversationDiscussion({
    chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, discussionId: "disc-budget",
    policy: "mention", targets: ["friend", "friend2"],
  });
  const attempts = await attemptsOf(f, conversation, "disc-budget");
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].status, "published");
  assert.equal(attempts[1].status, "skipped");
  assert.match(attempts[1].reason, /预算/);
  assert.equal(f.requests.length, 1, "the over-budget speaker never called the model");
  assert.match(result.stopReason, /预算/);
});

test("LA5 S2: the same Friend in two groups keeps independent contexts and no cross leakage", async (t) => {
  const f = await fixture(t);
  await addSecondFriend(f);
  const g1 = await createConversation({ chatHome: f.home, storageProjectId: "a", title: "群一", requestId: "req-s2-1", memberLongAgentIds: ["friend"] });
  const g2 = await createConversation({ chatHome: f.home, storageProjectId: "a", title: "群二", requestId: "req-s2-2", memberLongAgentIds: ["friend"] });
  const replies = ["S2_GROUP_ONE_REPLY", "S2_GROUP_TWO_REPLY"];
  let call = 0;
  f.setHandler(() => ({ content: replies[Math.min(call++, replies.length - 1)] }));
  await runConversationDiscussion({ chatHome: f.home, storageProjectId: "a", conversationId: g1.id, discussionId: "s2-d1", policy: "mention", targets: ["friend"] });
  const afterFirst = f.requests.length;
  await runConversationDiscussion({ chatHome: f.home, storageProjectId: "a", conversationId: g2.id, discussionId: "s2-d2", policy: "mention", targets: ["friend"] });
  const one = await publicTexts(f, g1);
  const two = await publicTexts(f, g2);
  assert.equal(one.includes("S2_GROUP_ONE_REPLY"), true);
  assert.equal(one.includes("S2_GROUP_TWO_REPLY"), false, "group one must not see group two's reply");
  assert.equal(two.includes("S2_GROUP_TWO_REPLY"), true);
  assert.equal(two.includes("S2_GROUP_ONE_REPLY"), false, "group two must not see group one's reply");
  // Group two's instruction was built only from group two's public history.
  const secondInstruction = lastUserText(f.requests[f.requests.length - 1]);
  assert.equal(secondInstruction.includes("S2_GROUP_ONE_REPLY"), false);
  assert.match(secondInstruction, /群「群二」/);
  assert.ok(afterFirst >= 1);
});

test("LA5 S2: a parallel round over capacity queues the rest with a reason and resumes without loss", async (t) => {
  const f = await fixture(t);
  const conversation = await group(f, { requestId: "req-s2-capacity", budget: { maxConcurrentSpeakers: 1 } });
  let call = 0;
  f.setHandler(() => ({ content: `CAP_${String(++call)}` }));
  const first = await runConversationDiscussion({
    chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, discussionId: "s2-capacity", policy: "parallel",
  });
  assert.equal(first.discussion.status, "waiting", "capacity waiting is not a terminal state");
  assert.match(first.stopReason, /并发容量/);
  const queued = (await attemptsOf(f, conversation, "s2-capacity")).find((attempt) => attempt.speakerLongAgentId === "friend2");
  assert.equal(queued.status, "queued");
  assert.match(queued.reason, /并发容量/);
  assert.equal(f.requests.length, 1, "only one speaker ran in the first batch");
  // The same worker resumes the durable queue; nothing is lost or run twice.
  await drainConversationAttempts({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id });
  const state = await readDiscussionState(f.home, "a", conversation.id);
  const discussion = state.discussions.find((item) => item.discussionId === "s2-capacity");
  assert.equal(discussion.status, "completed");
  assert.equal(discussion.attempts.every((attempt) => attempt.status === "published"), true);
  assert.equal(f.requests.length, 2);
});

test("LA5 orchestrator: consultation runs A→B→A with the answer as authorized input and bounded depth", async (t) => {
  const f = await fixture(t);
  const conversation = await group(f, { requestId: "req-orch-consult", budget: { maxDelegationDepth: 1 } });
  let call = 0;
  f.setHandler(() => ({ content: call++ === 0 ? "B_ANSWER" : "A_FINAL" }));
  const result = await runConversationConsultation({
    chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, discussionId: "disc-consult",
    fromLongAgentId: "friend", toLongAgentId: "friend2", question: "请给出结论",
  });
  const attempts = await attemptsOf(f, conversation, "disc-consult");
  assert.deepEqual(attempts.map((attempt) => attempt.speakerLongAgentId), ["friend2", "friend"]);
  assert.equal(attempts.every((attempt) => attempt.status === "published"), true);
  assert.equal(attempts[1].causationId, attempts[0].attemptId, "A's return is caused by B's answer");
  assert.equal(lastUserText(f.requests[1]).includes("B_ANSWER"), true, "A sees B's published answer");
  assert.match(result.stopReason, /请教完成/);
  await assert.rejects(runConversationConsultation({
    chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, discussionId: "disc-consult-2",
    fromLongAgentId: "friend", toLongAgentId: "friend2", question: "再来一次", depth: 2,
  }), /最大委派深度/);
  assert.equal((await readConversation(f.home, "a", conversation.id)).lifecycle, "active");
});

test("user stop prevents a late publication and subsequent round calls",async t=>{
 const f=await fixture(t);const conversation=await group(f,{requestId:"stop-live",budget:{maxRounds:2}});
 f.setHandler(async()=>{
  await stopDiscussion({chatHome:f.home,storageProjectId:"a",conversationId:conversation.id,discussionId:"stop-live",status:"stopped",stopReason:"用户停止"});
  return {content:"MUST_NOT_PUBLISH_AFTER_STOP"};
 });
 const result=await runConversationDiscussion({chatHome:f.home,storageProjectId:"a",conversationId:conversation.id,discussionId:"stop-live",policy:"round-robin"});
 assert.equal(result.discussion.status,"stopped");
 assert.equal(f.requests.length,1);
 assert.equal((await publicTexts(f,conversation)).includes("MUST_NOT_PUBLISH_AFTER_STOP"),false);
});
