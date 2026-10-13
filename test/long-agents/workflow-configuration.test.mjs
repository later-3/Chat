import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fixture } from "./daily-fixture.mjs";
import { readLongAgentRegistry } from "../../src/long-agents/storage.ts";
import { acceptLongAgentTurn } from "../../src/long-agents/turn-queue.ts";
import { readAssemblySnapshot } from "../../src/agents/assembly-context.ts";

function acceptedSnapshot(turn) {
  const manager = SessionManager.inMemory("/tmp");
  for (const entry of turn.seed) manager.appendCustomEntry(entry.customType, entry.data);
  return { manager, snapshot: readAssemblySnapshot(manager, turn.turnId) };
}

test("Web, IM and schedule share one admission path and freeze the Long Agent itself", async t => {
  const f = await fixture(t);
  const accepted = [];
  for (const source of ["chat-web", "channel", "scheduled"]) {
    accepted.push(await acceptLongAgentTurn({ ...f.input(source), source }));
  }
  for (const turn of accepted) {
    const { snapshot } = acceptedSnapshot(turn);
    // P3：默认工作流（chat-direct）**不定义 Agent**——冻结的执行主体就是 Long Agent 本身，
    // 不再有任何工作流内置角色。
    assert.equal(snapshot.agent.id, "friend");
    assert.deepEqual(snapshot.agent.model, { provider: "p3-local", modelId: "daily-model" });
    assert.match(JSON.stringify(snapshot.agent.customInstructions), /Stable Friend/);
  }
});

test("inspection reads the same Long Agent definition as execution (no second source)", async t => {
  const f = await fixture(t);
  const definition = (await readLongAgentRegistry(f.home)).agents[0].definition;
  assert.equal(definition.id, "friend");
  assert.equal(definition.name, "Friend");
  assert.equal(definition.description, "Stable");
});
