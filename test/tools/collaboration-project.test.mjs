import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "../long-agents/daily-fixture.mjs";
import { resolveChatSystemTools } from "../../src/tools/registry.ts";
import { applyScopeToCapabilities, resolveLongAgentScope } from "../../src/long-agents/scope.ts";
import { readLongAgentInteractionProject } from "../../src/long-agents/interaction-project.ts";
import { acceptLongAgentTurn } from "../../src/long-agents/turn-queue.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";

function contextOf(f, longAgentId, longAgentTurnId) {
  const manager = SessionManager.inMemory(f.home);
  return {
    purpose: "execution", projectId: longAgentId, chatHome: f.home, cwd: f.home,
    sessionManager: manager, sessionId: manager.getSessionId(), agentId: longAgentId,
    longAgentId, longAgentTurnId: longAgentTurnId ?? `turn-${longAgentId}-${String(Math.random())}`,
  };
}

test("LA6 A: the Agent entry uses the same association service and the trusted identity", async (t) => {
  const f = await fixture(t);
  // Management authority comes from the authoritative accepted turn: only the owner's private chat.
  const accepted = await acceptLongAgentTurn(f.input("tool-private"));
  const [tool] = resolveChatSystemTools(["system:tool/collaboration_project"], contextOf(f, "friend", accepted.turnId));
  const initial = await tool.definition.execute("c1", { operation: "read" });
  assert.equal(initial.details.status, "unset");
  assert.equal(initial.details.revision, 0);
  const set = await tool.definition.execute("c2", { operation: "set", projectId: "a", expectedRevision: 0 });
  assert.equal(set.details.effective.projectId, "a");
  assert.equal(set.details.revision, 1);
  await assert.rejects(tool.definition.execute("c3", { operation: "set", projectId: "b", expectedRevision: 0 }), /已被修改/);
  const cleared = await tool.definition.execute("c4", { operation: "clear", expectedRevision: 1 });
  assert.equal(cleared.details.status, "set");
  assert.equal(cleared.details.effective.availability, "none");
  assert.equal((await readLongAgentInteractionProject(f.home, "friend")).revision, 2);
  // Identity comes from the trusted context, never from a tool argument.
  const [anonymous] = resolveChatSystemTools(["system:tool/collaboration_project"], { ...contextOf(f, "friend", accepted.turnId), longAgentId: undefined });
  await assert.rejects(anonymous.definition.execute("c5", { operation: "read" }), /只服务于 Long Agent/);
  // Without an owner-private accepted turn (channel/background/unknown), even `read` is refused.
  const [unauthorized] = resolveChatSystemTools(["system:tool/collaboration_project"], contextOf(f, "friend", "channel:friend:unverified"));
  await assert.rejects(unauthorized.definition.execute("c6", { operation: "read" }), /只有用户本人在私聊中/);
});

test("LA6 A: a group participation scope can never register the private project tool", async () => {
  const scope = resolveLongAgentScope({
    kind: "conversation", longAgentId: "friend", sessionId: "s", conversationId: "conv-1",
    participationEpoch: 1, authorizationRevision: 1, storageProjectId: "a",
    grants: { systemToolAddresses: [], nativeTools: [], extensionTools: [] },
  });
  const applied = applyScopeToCapabilities(scope, {
    systemTools: [{ address: "system:tool/collaboration_project", name: "collaboration_project" }],
    nativeTools: [], extensionTools: [],
  });
  assert.deepEqual(applied.systemToolNames, []);
  assert.equal(applied.excluded.some((entry) => entry.id === "collaboration_project"), true);
});
