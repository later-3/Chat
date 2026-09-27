import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture } from "./daily-fixture.mjs";
import { createConversation, bindParticipationSession } from "../../src/long-agents/conversations/service.ts";
import { queueSpeechAttempt, readDiscussionState } from "../../src/long-agents/conversations/discussions.ts";
import { dispatchConversationAttempt } from "../../src/long-agents/conversations/dispatch.ts";
import { startConversationWork, drainConversationWorks, listConversationWorks } from "../../src/long-agents/conversations/work.ts";

for (const owner of ["discussion", "work"]) for (const admitted of [false, true]) {
  test(`${owner} budget ${admitted ? "meters" : "denies"} an actual native summary request`, async t => {
    const f = await fixture(t);
    const settingsPath = path.join(f.home, "agent/settings.json"), settings = JSON.parse(fs.readFileSync(settingsPath));
    fs.writeFileSync(settingsPath, JSON.stringify({ ...settings, compaction: { enabled: true, reserveTokens: 2000, keepRecentTokens: 1 } }));
    const conversation = await createConversation({ chatHome: f.home, storageProjectId: "a", title: "summary budget", requestId: "summary-budget", memberLongAgentIds: ["friend"], budget: { maxModelCalls: admitted ? 10 : 1, maxTokensSoft: 1000000 } });
    const bound = await bindParticipationSession({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, longAgentId: "friend" });
    const current = bound.conversation;
    f.setHandler(body => body.messages.some(message => message.role === "system" && JSON.stringify(message.content).includes("context summarization assistant"))
      ? { content: "NATIVE_BUDGET_SUMMARY", usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }
      : { content: "WORK_BEFORE_SUMMARY", usage: { prompt_tokens: 127000, completion_tokens: 10, total_tokens: 127010 } });
    let usage;
    if (owner === "discussion") {
      await queueSpeechAttempt({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, attempt: {
        discussionId: "root", attemptId: "speech", policy: "mention", round: 1, speakerLongAgentId: "friend", participationEpoch: 1,
        inputCutoffEntryId: null, replyToEntryId: null, causationId: null, authorizationRevision: current.authorizationRevision,
        instruction: "Summarize " + "history ".repeat(300), budget: current.budget } });
      await dispatchConversationAttempt({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, discussionId: "root", attemptId: "speech" });
      usage = (await readDiscussionState(f.home, "a", conversation.id)).discussions[0];
    } else {
      await startConversationWork({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id, longAgentId: "friend", requestId: "work", title: "summary", instruction: "Summarize " + "history ".repeat(300) });
      await drainConversationWorks({ chatHome: f.home, storageProjectId: "a", conversationId: conversation.id });
      usage = (await listConversationWorks(f.home, "a", conversation.id))[0];
    }
    assert.equal(usage.modelCalls, f.requests.length, "every summary HTTP call consumes the durable budget");
    if (admitted) {
      assert.ok(f.requests.length > 1);
      assert.equal(usage.tokensUsed, 127010 + (f.requests.length - 1) * 120, "summary usage must reach the next soft-budget admission");
    } else assert.equal(f.requests.length, 1, "denied compaction never reaches HTTP");
  });
}
