import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fixture } from "../long-agents/daily-fixture.mjs";
import { readLongAgentRegistry, writeLongAgentRegistry } from "../../src/long-agents/storage.ts";
import { resolveChatSystemTools } from "../../src/tools/registry.ts";
import { createConversation, readConversation } from "../../src/long-agents/conversations/service.ts";
import { appendConversationUserMessage } from "../../src/long-agents/conversations/public-root.ts";

async function addSecondFriend(f) {
  const registry = await readLongAgentRegistry(f.home);
  if (registry.agents.some((candidate) => candidate.id === "friend2")) return;
  const first = registry.agents[0];
  await writeLongAgentRegistry({ ...registry, agents: [...registry.agents, {
    ...first, id: "friend2", name: "Friend2", nanoclawAgentGroupId: "group2", defaultProjectId: "friend2",
    definition: { ...first.definition, id: "friend2", name: "Friend2" },
  }] }, f.home);
}

function contextOf(f, longAgentId, extra = {}) {
  const manager = SessionManager.inMemory(f.home);
  return {
    purpose: "execution", projectId: longAgentId, chatHome: f.home, cwd: f.home,
    sessionManager: manager, sessionId: manager.getSessionId(), agentId: longAgentId,
    longAgentId, longAgentTurnId: `turn-${longAgentId}-${String(Math.random())}`,
    ...extra,
  };
}

test("LA5 D: conversation_manage is read-only, identity-bound and never crosses groups", async (t) => {
  const f = await fixture(t);
  await addSecondFriend(f);
  const g1 = await createConversation({ chatHome: f.home, storageProjectId: "a", title: "群一", requestId: "req-tool-1", memberLongAgentIds: ["friend"] });
  const g2 = await createConversation({ chatHome: f.home, storageProjectId: "a", title: "群二", requestId: "req-tool-2", memberLongAgentIds: ["friend2"] });
  await appendConversationUserMessage({ chatHome: f.home, storageProjectId: "a", conversationId: g1.id, clientMessageId: "m1", text: "G1_PUBLIC_MESSAGE" });
  await appendConversationUserMessage({ chatHome: f.home, storageProjectId: "a", conversationId: g2.id, clientMessageId: "m2", text: "G2_PUBLIC_MESSAGE" });

  const [tool] = resolveChatSystemTools(["system:tool/conversation_manage"], contextOf(f, "friend"));
  const listed = await tool.definition.execute("c1", { operation: "list" });
  assert.deepEqual(listed.details.conversations.map((conversation) => conversation.id), [g1.id], "only the Friend's own groups are listed");

  const read = await tool.definition.execute("c2", { operation: "read", conversationId: g1.id });
  assert.equal(JSON.stringify(read.details).includes("G1_PUBLIC_MESSAGE"), true);
  assert.equal(JSON.stringify(read.details).includes("G2_PUBLIC_MESSAGE"), false, "another group's content is never returned");
  await assert.rejects(tool.definition.execute("c3", { operation: "read", conversationId: g2.id }), /找不到你参与的该群/);

  // A proposal is data for the user; nothing is applied and no authorization changes.
  const proposal = await tool.definition.execute("c4", {
    operation: "propose", conversationId: g1.id,
    proposal: { kind: "add-member", longAgentId: "friend2", reason: "需要一个研究员" },
  });
  assert.equal(proposal.details.applied, false);
  assert.equal((await readConversation(f.home, "a", g1.id)).members.length, 1, "the group membership is unchanged");

  // Identity comes from the trusted tool context, never from tool arguments.
  const [anonymous] = resolveChatSystemTools(["system:tool/conversation_manage"], {
    ...contextOf(f, "friend"), longAgentId: undefined,
  });
  await assert.rejects(anonymous.definition.execute("c5", { operation: "list" }), /只服务于 Long Agent/);
});
