import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { fixture } from "./daily-fixture.mjs";
import { readLongAgentRegistry, writeLongAgentRegistry } from "../../src/long-agents/storage.ts";
import { resolveLongAgentScope } from "../../src/long-agents/scope.ts";
import {
  bindParticipationSession,
  createConversation,
  resolveParticipationScope,
} from "../../src/long-agents/conversations/service.ts";
import {
  memberConversationStreamViewerFromScope,
  readConversationStreamSnapshot,
  readConversationStreamTick,
} from "../../src/long-agents/conversations/stream.ts";

const srcRoot = fileURLToPath(new URL("../../src/", import.meta.url));

async function* walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(target);
    else if (entry.name.endsWith(".ts")) yield target;
  }
}

async function addSecondFriend(f) {
  const registry = await readLongAgentRegistry(f.home);
  if (registry.agents.some((candidate) => candidate.id === "friend2")) return;
  const first = registry.agents[0];
  await writeLongAgentRegistry({ ...registry, agents: [...registry.agents, {
    ...first, id: "friend2", name: "Friend2", nanoclawAgentGroupId: "group2", defaultProjectId: "friend2",
    definition: { ...first.definition, id: "friend2", name: "Friend2" },
  }] }, f.home);
}

test("LA5 identity boundary: owner is an entry property, never request input", async () => {
  // The owner viewer is constructed in exactly one place, and that place is the owner HTTP route.
  const importers = [];
  for await (const file of walk(srcRoot)) {
    const relative = path.relative(srcRoot, file).split(path.sep).join("/");
    // The definition module itself is not a consumer.
    if (relative === "long-agents/conversations/stream.ts") continue;
    const source = await readFile(file, "utf8");
    if (source.includes("ownerConversationStreamViewer")) importers.push(relative);
  }
  assert.deepEqual(importers, ["routes/api/long-agents/[longAgentId]/conversations/[conversationId]/stream.get.ts"],
    "only the owner-facing route may construct the owner stream viewer");

  // The route reads no identity from the request and refuses identity parameters outright.
  const route = await readFile(path.join(srcRoot, "routes/api/long-agents/[longAgentId]/conversations/[conversationId]/stream.get.ts"), "utf8");
  assert.equal(route.includes("viewerLongAgentId"), false, "the owner route must not accept a viewer parameter");
  assert.equal(route.includes("query.viewer"), false);
  assert.match(route, /key !== "after"/, "unknown query keys (including identity hints) are rejected");
  assert.match(route, /ownerConversationStreamViewer\(\)/);

  // The viewer union has no `string | null` owner form that could be reached by omission.
  const stream = await readFile(path.join(srcRoot, "long-agents/conversations/stream.ts"), "utf8");
  assert.equal(stream.includes("longAgentId: string | null"), false);
  assert.equal(stream.includes("viewerLongAgentId?:"), false);

  // Agent-facing code must not construct the owner viewer or a bare member viewer.
  const agentFacing = [
    path.join(srcRoot, "long-agents/conversations/dispatch.ts"),
    path.join(srcRoot, "long-agents/conversations/publication.ts"),
  ];
  for await (const file of walk(path.join(srcRoot, "tools"))) agentFacing.push(file);
  for await (const file of walk(path.join(srcRoot, "workflows"))) agentFacing.push(file);
  for await (const file of walk(path.join(srcRoot, "long-agents/conversations"))) {
    if (!file.endsWith("stream.ts") && !file.endsWith("contract.ts")) agentFacing.push(file);
  }
  for (const file of agentFacing) {
    const source = await readFile(file, "utf8");
    assert.equal(source.includes("ownerConversationStreamViewer"), false, `${file} must not construct the owner viewer`);
  }
});

test("LA5 identity boundary: member viewers come from a resolved scope and cannot cross groups or members", async (t) => {
  const f = await fixture(t);
  await addSecondFriend(f);
  const first = await createConversation({
    chatHome: f.home, storageProjectId: "a", title: "群一", requestId: "req-boundary-1", memberLongAgentIds: ["friend", "friend2"],
  });
  const second = await createConversation({
    chatHome: f.home, storageProjectId: "a", title: "群二", requestId: "req-boundary-2", memberLongAgentIds: ["friend"],
  });
  const bound = await bindParticipationSession({ chatHome: f.home, storageProjectId: "a", conversationId: first.id, longAgentId: "friend" });
  const resolved = await resolveParticipationScope({
    chatHome: f.home, storageProjectId: "a", conversationId: first.id, longAgentId: "friend", sessionId: bound.sessionId,
  });
  const viewer = memberConversationStreamViewerFromScope(resolved.scope);
  assert.deepEqual(viewer, { kind: "member", longAgentId: "friend", conversationId: first.id });
  // The viewer works for its own group.
  assert.equal(Array.isArray(await readConversationStreamSnapshot({ chatHome: f.home, storageProjectId: "a", conversationId: first.id, viewer })), true);
  // The same scope cannot be pointed at another group.
  const crossed = await readConversationStreamTick({ chatHome: f.home, storageProjectId: "a", conversationId: second.id, viewer, afterCursor: 0 });
  assert.equal(crossed.closed, true);
  assert.match(crossed.events[0].reason, /作用域与该群不一致/);
  // A viewer naming a non-member is refused even before any data is read.
  const stranger = await readConversationStreamTick({
    chatHome: f.home, storageProjectId: "a", conversationId: first.id,
    viewer: { kind: "member", longAgentId: "stranger", conversationId: first.id }, afterCursor: 0,
  });
  assert.equal(stranger.closed, true);
  assert.match(stranger.events[0].reason, /成员资格已撤销/);
  // A non-conversation scope cannot be turned into a member viewer at all.
  const direct = resolveLongAgentScope({ kind: "direct", longAgentId: "friend", sessionId: "s", storageProjectId: "a" });
  assert.throws(() => memberConversationStreamViewerFromScope(direct), /只有已解析的群参与作用域/);
  // Group scopes stay default-deny: a group Agent has no tool that could even reach a route.
  assert.deepEqual(resolved.scope.allowedTools, { systemToolAddresses: [], nativeTools: [], extensionTools: [] });
});
