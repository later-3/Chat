import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture } from "./daily-fixture.mjs";
import { readLongAgentRegistry, writeLongAgentRegistry, longAgentConfigRoot } from "../../src/long-agents/storage.ts";
import {
  InteractionProjectError,
  readLongAgentInteractionProject,
  setLongAgentInteractionProject,
} from "../../src/long-agents/interaction-project.ts";
import { acceptLongAgentTurn } from "../../src/long-agents/turn-queue.ts";
import { executeLongAgentTurn } from "../../src/long-agents/runtime.ts";
import { readLongAgentState } from "../../src/long-agents/storage.ts";

async function addSecondFriend(f) {
  const registry = await readLongAgentRegistry(f.home);
  if (registry.agents.some((candidate) => candidate.id === "friend2")) return;
  const first = registry.agents[0];
  await writeLongAgentRegistry({ ...registry, agents: [...registry.agents, {
    ...first, id: "friend2", name: "Friend2", nanoclawAgentGroupId: "group2", defaultProjectId: "friend2",
    definition: { ...first.definition, id: "friend2", name: "Friend2" },
  }] }, f.home);
}

function interactionFile(home, longAgentId) {
  return path.join(longAgentConfigRoot(home, longAgentId), "interaction.json");
}

test("LA6 A: unset/null/active/unavailable are distinct and CAS-protected", async (t) => {
  const f = await fixture(t);
  const unset = await readLongAgentInteractionProject(f.home, "friend");
  assert.deepEqual({ status: unset.status, revision: unset.revision, availability: unset.effective.availability, projectId: unset.effective.projectId }, { status: "unset", revision: 0, availability: "none", projectId: null });
  assert.equal(fs.existsSync(interactionFile(f.home, "friend")), false, "reading unset never writes a record");

  const set = await setLongAgentInteractionProject({ chatHome: f.home, longAgentId: "friend", projectId: "a", expectedRevision: 0 });
  assert.deepEqual({ status: set.status, revision: set.revision, availability: set.effective.availability, projectId: set.effective.projectId }, { status: "set", revision: 1, availability: "active", projectId: "a" });
  await assert.rejects(setLongAgentInteractionProject({ chatHome: f.home, longAgentId: "friend", projectId: "b", expectedRevision: 0 }), InteractionProjectError);
  await assert.rejects(setLongAgentInteractionProject({ chatHome: f.home, longAgentId: "friend", projectId: "missing-project", expectedRevision: 1 }), /找不到可关联/);

  // Explicit clear is a record, not unset.
  const cleared = await setLongAgentInteractionProject({ chatHome: f.home, longAgentId: "friend", projectId: null, expectedRevision: 1 });
  assert.deepEqual({ status: cleared.status, revision: cleared.revision, availability: cleared.effective.availability }, { status: "set", revision: 2, availability: "none" });
  assert.equal(fs.existsSync(interactionFile(f.home, "friend")), true);

  // A record whose project disappeared is `unavailable`, never silently another project.
  fs.writeFileSync(interactionFile(f.home, "friend"), JSON.stringify({ schemaVersion: 1, projectId: "gone", revision: 3, updatedAt: new Date().toISOString() }));
  const unavailable = await readLongAgentInteractionProject(f.home, "friend");
  assert.equal(unavailable.status, "set");
  assert.equal(unavailable.effective.availability, "unavailable");
  assert.equal(unavailable.effective.projectId, null);
  assert.match(unavailable.effective.reason, /不可用|不存在/);
  const replacement = await setLongAgentInteractionProject({ chatHome: f.home, longAgentId: "friend", projectId: "b", expectedRevision: 3 });
  assert.equal(replacement.effective.projectId, "b");
});

test("LA6 A: concurrent writes are serialized by revision CAS", async (t) => {
  const f = await fixture(t);
  await setLongAgentInteractionProject({ chatHome: f.home, longAgentId: "friend", projectId: "a", expectedRevision: 0 });
  const results = await Promise.allSettled([
    setLongAgentInteractionProject({ chatHome: f.home, longAgentId: "friend", projectId: "b", expectedRevision: 1 }),
    setLongAgentInteractionProject({ chatHome: f.home, longAgentId: "friend", projectId: null, expectedRevision: 1 }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1, "exactly one writer wins the revision");
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  const state = await readLongAgentInteractionProject(f.home, "friend");
  assert.equal(state.revision, 2);
});

test("LA6 A: each Friend keeps its own project (A/P -> B/Q -> A/P)", async (t) => {
  const f = await fixture(t);
  await addSecondFriend(f);
  await setLongAgentInteractionProject({ chatHome: f.home, longAgentId: "friend", projectId: "a", expectedRevision: 0 });
  await setLongAgentInteractionProject({ chatHome: f.home, longAgentId: "friend2", projectId: "b", expectedRevision: 0 });
  assert.equal((await readLongAgentInteractionProject(f.home, "friend")).effective.projectId, "a");
  assert.equal((await readLongAgentInteractionProject(f.home, "friend2")).effective.projectId, "b");
  // Switching back to the first Friend restores its own association, not the last write.
  assert.equal((await readLongAgentInteractionProject(f.home, "friend")).effective.projectId, "a");
  // Re-pointing friend2 does not touch friend.
  await setLongAgentInteractionProject({ chatHome: f.home, longAgentId: "friend2", projectId: "a", expectedRevision: 1 });
  assert.equal((await readLongAgentInteractionProject(f.home, "friend")).effective.projectId, "a");
  assert.equal((await readLongAgentInteractionProject(f.home, "friend")).revision, 1);
});

test("LA6 A: acceptance resolves and freezes the association project, and rejects stale/divergent input", async (t) => {
  const f = await fixture(t);
  await setLongAgentInteractionProject({ chatHome: f.home, longAgentId: "friend", projectId: "a", expectedRevision: 0 });
  const accepted = await acceptLongAgentTurn({
    chatHome: f.home, longAgentId: "friend", projectId: "friend", turnId: "assoc-1", text: "hello",
    interactionRevision: 1,
  });
  assert.equal(accepted.contextProjectId, "a", "the frozen target comes from the association");
  assert.equal(accepted.interactionRevision, 1);
  // A stale revision is a conflict instead of silently adopting the current value.
  await assert.rejects(acceptLongAgentTurn({
    chatHome: f.home, longAgentId: "friend", projectId: "friend", turnId: "assoc-2", text: "hi", interactionRevision: 0,
  }), /项目关联已变化/);
  // A per-turn projectId that diverges from the association may not override it.
  await assert.rejects(acceptLongAgentTurn({
    chatHome: f.home, longAgentId: "friend", projectId: "friend", turnId: "assoc-3", text: "hi", contextProjectId: "b", interactionRevision: 1,
  }), /不一致/);
  // Unavailable association blocks acceptance.
  fs.writeFileSync(interactionFile(f.home, "friend"), JSON.stringify({ schemaVersion: 1, projectId: "gone", revision: 2, updatedAt: new Date().toISOString() }));
  await assert.rejects(acceptLongAgentTurn({
    chatHome: f.home, longAgentId: "friend", projectId: "friend", turnId: "assoc-4", text: "hi", interactionRevision: 2,
  }), /关联项目不可用/);
});

test("LA6 A: the real model request uses the associated project's context, not another Friend's", async (t) => {
  const f = await fixture(t);
  const registry = await readLongAgentRegistry(f.home);
  await writeLongAgentRegistry({ ...registry, agents: registry.agents.map((agent) => ({
    ...agent,
    definition: { ...agent.definition, tools: { mode: "explicit", names: [], exclude: [], addresses: [] } },
  })) }, f.home);
  await setLongAgentInteractionProject({ chatHome: f.home, longAgentId: "friend", projectId: "a", expectedRevision: 0 });
  f.setHandler(() => ({ content: "ok" }));
  const before = f.requests.length;
  await executeLongAgentTurn({
    chatHome: f.home, longAgentId: "friend", projectId: "friend", turnId: "assoc-model", text: "hello",
    interactionRevision: 1,
  });
  const request = JSON.stringify(f.requests.slice(before));
  assert.equal(request.includes("RULE_a"), true, "the associated project's context reaches the model request");
  assert.equal(request.includes("RULE_b"), false, "no other project's context is injected");
  const turn = (await readLongAgentState(f.home)).turns.find((item) => item.requestId === "assoc-model");
  assert.equal(turn.contextProjectId, "a");
  assert.equal(turn.interactionRevision, 1);
});

test("LA6 A review: an accepted request remains idempotent after changing the association", async (t) => {
  const f = await fixture(t);
  await setLongAgentInteractionProject({ chatHome: f.home, longAgentId: "friend", projectId: "a", expectedRevision: 0 });
  const input = { ...f.input("retry-association", "a"), interactionRevision: 1 };
  const first = await acceptLongAgentTurn(input);
  await setLongAgentInteractionProject({ chatHome: f.home, longAgentId: "friend", projectId: "b", expectedRevision: 1 });
  const retry = await acceptLongAgentTurn(input);
  assert.equal(retry.newAcceptance, false);
  assert.equal(retry.turnId, first.turnId);
  assert.equal(retry.contextProjectId, "a");
  await assert.rejects(acceptLongAgentTurn({ ...input, text: "different" }), /不同消息/);
});

test("LA6 A review: association updates wait for durable acceptance arbitration", async (t) => {
  const { withFileLock } = await import("../../src/persistence/versioned-file.ts");
  const f = await fixture(t);
  let release;
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const held = withFileLock(`${f.home}/runtime/friend-accept`, async () => { entered(); await gate; });
  await ready;
  let finished = false;
  const update = setLongAgentInteractionProject({ chatHome: f.home, longAgentId: "friend", projectId: "a", expectedRevision: 0 }).then(() => { finished = true; });
  try {
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(finished, false, "selection cannot commit while acceptance owns the arbitration lock");
  } finally { release(); await held; await update; }
});

test("LA6 A review: an unset association accepts and persists revision zero", async (t) => {
  const f = await fixture(t);
  const accepted = await acceptLongAgentTurn({ ...f.input("unset-revision"), interactionRevision: 0 });
  assert.equal(accepted.interactionRevision, 0);
  assert.equal(accepted.contextProjectId, null);
  const stored = (await readLongAgentState(f.home)).turns.find(turn => turn.turnId === accepted.turnId);
  assert.equal(stored.interactionRevision, 0);
  assert.equal(fs.existsSync(interactionFile(f.home, "friend")), false);
});

// --- Round-2 independent review probes (R2-P1-1, R2-P1-2) ---

import { createHash } from "node:crypto";
import { updateLongAgentState } from "../../src/long-agents/storage.ts";
import { isOwnerPrivateTurn } from "../../src/long-agents/interaction-project.ts";

test("LA6 A review: a channel turn cannot change the owner's private association through the Agent tool", async (t) => {
  const f = await fixture(t);
  const registry = await readLongAgentRegistry(f.home);
  await writeLongAgentRegistry({ ...registry, agents: registry.agents.map((agent) => ({
    ...agent, definition: { ...agent.definition, tools: { mode: "explicit", names: [], exclude: [], addresses: ["system:tool/collaboration_project"] } },
  })) }, f.home);
  await setLongAgentInteractionProject({ chatHome: f.home, longAgentId: "friend", projectId: "a", expectedRevision: 0 });
  let calls = 0;
  f.setHandler(() => ++calls === 1
    ? { tool_calls: [{ index: 0, id: "set-private", type: "function", function: { name: "collaboration_project", arguments: JSON.stringify({ operation: "set", projectId: "b", expectedRevision: 1 }) } }] }
    : { content: "done" });
  await executeLongAgentTurn({ ...f.input("channel-change"), source: "channel", channelType: "telegram", inboundEventId: "unverified-channel" });
  assert.equal((await readLongAgentInteractionProject(f.home, "friend")).effective.projectId, "a", "an unverified channel must not change the private association");
  assert.equal(calls, 3, "the model still continues; only the write is refused");
  assert.match(JSON.stringify(f.requests.at(-2)), /只有用户本人在私聊中/);
  // The authoritative record decides management authority, not the longAgentId.
  const channelTurnId = (await readLongAgentState(f.home)).turns.find((turn) => turn.requestId === "channel-change").turnId;
  assert.equal(await isOwnerPrivateTurn(f.home, "friend", channelTurnId), false);
  assert.equal(await isOwnerPrivateTurn(f.home, "friend", undefined), false);
});

test("LA6 A review: an owner private turn keeps the CAS and may change its own association", async (t) => {
  const f = await fixture(t);
  const registry = await readLongAgentRegistry(f.home);
  await writeLongAgentRegistry({ ...registry, agents: registry.agents.map((agent) => ({
    ...agent, definition: { ...agent.definition, tools: { mode: "explicit", names: [], exclude: [], addresses: ["system:tool/collaboration_project"] } },
  })) }, f.home);
  await setLongAgentInteractionProject({ chatHome: f.home, longAgentId: "friend", projectId: "a", expectedRevision: 0 });
  let calls = 0;
  f.setHandler(() => ++calls === 1
    ? { tool_calls: [{ index: 0, id: "set-own", type: "function", function: { name: "collaboration_project", arguments: JSON.stringify({ operation: "set", projectId: "b", expectedRevision: 1 }) } }] }
    : { content: "done" });
  await executeLongAgentTurn({ ...f.input("owner-private"), source: "chat-web" });
  assert.equal((await readLongAgentInteractionProject(f.home, "friend")).effective.projectId, "b");
  const turnId = (await readLongAgentState(f.home)).turns.find((turn) => turn.requestId === "owner-private").turnId;
  assert.equal(await isOwnerPrivateTurn(f.home, "friend", turnId), true);
});

test("LA6 A review: a pre-upgrade accepted request can still be retried unchanged", async (t) => {
  const f = await fixture(t);
  const input = f.input("pre-upgrade", "a");
  const first = await acceptLongAgentTurn(input);
  // The v2 (LA6-A first release) digest: no requested/frozen split.
  const legacyHash = createHash("sha256").update(JSON.stringify({
    text: input.text, images: [], contextProjectId: "a", longAgentId: "friend", source: "chat-web",
    summaryDraft: false, channelType: null, inboundEventId: null, interactionRevision: null,
  })).digest("hex");
  await updateLongAgentState(f.home, (state) => ({
    state: { ...state, turns: state.turns.map((turn) => turn.turnId === first.turnId ? { ...turn, payloadHash: legacyHash, payloadHashVersion: null } : turn) },
    result: undefined,
  }));
  const retry = await acceptLongAgentTurn(input);
  assert.equal(retry.newAcceptance, false, "an unchanged retry of a legacy record is still idempotent");
  assert.equal(retry.turnId, first.turnId);
  // A changed payload must still be refused under every digest version.
  await assert.rejects(acceptLongAgentTurn({ ...input, text: "changed" }), /不同消息或项目/);
  await assert.rejects(acceptLongAgentTurn({ ...input, contextProjectId: "b" }), /不同消息或项目/);
  await assert.rejects(acceptLongAgentTurn({ ...input, interactionRevision: 1 }), /不同消息或项目/);
});

test("LA6 A review: a v1 accepted request can still be retried unchanged", async (t) => {
  const f = await fixture(t);
  const input = f.input("pre-la6a", "a");
  const first = await acceptLongAgentTurn(input);
  const v1Hash = createHash("sha256").update(JSON.stringify({
    text: input.text, images: [], contextProjectId: "a", longAgentId: "friend", source: "chat-web",
    summaryDraft: false, channelType: null, inboundEventId: null,
  })).digest("hex");
  await updateLongAgentState(f.home, (state) => ({
    state: { ...state, turns: state.turns.map((turn) => turn.turnId === first.turnId ? { ...turn, payloadHash: v1Hash, payloadHashVersion: null } : turn) },
    result: undefined,
  }));
  assert.equal((await acceptLongAgentTurn(input)).newAcceptance, false);
});

const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
test('real v2 resolved association survives an omitted project retry',async t=>{
 const f=await fixture(t);
 await setLongAgentInteractionProject({chatHome:f.home,longAgentId:'friend',projectId:'a',expectedRevision:0});
 const input={...f.input('v2-resolved'),contextProjectId:undefined,interactionRevision:1};
 const first=await acceptLongAgentTurn(input);
 const hash=digest({text:input.text,images:[],contextProjectId:'a',longAgentId:'friend',source:'chat-web',summaryDraft:false,channelType:null,inboundEventId:null,interactionRevision:1});
 await updateLongAgentState(f.home,s=>({state:{...s,turns:s.turns.map(x=>x.turnId===first.turnId?{...x,payloadHash:hash,payloadHashVersion:null}:x)},result:undefined}));
 await setLongAgentInteractionProject({chatHome:f.home,longAgentId:'friend',projectId:'b',expectedRevision:1});
 assert.equal((await acceptLongAgentTurn(input)).newAcceptance,false);
 await assert.rejects(acceptLongAgentTurn({...input,contextProjectId:'b'}),/不同消息/);
});
test('v1 retry cannot add a different declared revision',async t=>{
 const f=await fixture(t), input=f.input('v1-revision','a');
 const first=await acceptLongAgentTurn(input);
 const hash=digest({text:input.text,images:[],contextProjectId:'a',longAgentId:'friend',source:'chat-web',summaryDraft:false,channelType:null,inboundEventId:null});
 await updateLongAgentState(f.home,s=>({state:{...s,turns:s.turns.map(x=>x.turnId===first.turnId?{...x,payloadHash:hash,payloadHashVersion:null}:x)},result:undefined}));
 await assert.rejects(acceptLongAgentTurn({...input,interactionRevision:999}),/不同消息/);
});
