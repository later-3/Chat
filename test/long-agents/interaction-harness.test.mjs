import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture } from "./daily-fixture.mjs";
import { readLongAgentRegistry } from "../../src/long-agents/storage.ts";
import { hasInteractionHarness, interactionHarnessInstruction, readInteractionHarness } from "../../src/long-agents/interaction-harness.ts";
import { prepareLongAgentAssembly } from "../../src/long-agents/assembly.ts";

function writeHarness(home, relative, text) {
  const file = path.join(home, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

test("交互 harness 读取：通用规范 + 该 Long Agent 在该 project 下的专属规范", async (t) => {
  const f = await fixture(t);
  // Chat Home 里没有 harness 时不注入任何内容（既有环境不受影响）
  const empty = await readInteractionHarness({ chatHome: f.home, longAgentId: "friend", projectId: "a" });
  assert.equal(hasInteractionHarness(empty), false);

  writeHarness(f.home, "interaction-harness/standards/需求规范.md", "# 需求规范\n\nR1 以业务目标为核心。");
  writeHarness(f.home, "interaction-harness/standards/前端规范.md", "# 前端规范\n\n先梳理信息关系。");
  writeHarness(f.home, "long-agents/friend/projects/a/project-guidance.md", "# 专属规范\n\n只在该项目生效。");

  const sections = await readInteractionHarness({ chatHome: f.home, longAgentId: "friend", projectId: "a" });
  assert.deepEqual(sections.common.map((item) => item.name), ["需求规范.md", "前端规范.md"]);
  assert.equal(sections.project?.name, "project-guidance.md");

  const instruction = interactionHarnessInstruction(sections);
  assert.match(instruction, /<chat_interaction_harness revision="sha256:[0-9a-f]{64}">/);
  assert.match(instruction, /R1 以业务目标为核心/);
  assert.match(instruction, /只在该项目生效/);

  // 专属规范按 (Long Agent × project) 隔离：其他项目读不到
  const other = await readInteractionHarness({ chatHome: f.home, longAgentId: "friend", projectId: "b" });
  assert.equal(other.project, undefined);
  assert.equal(other.common.length, 2, "通用规范对所有项目生效");
});

test("装配把交互 harness 作为规则注入 Agent 的指令", async (t) => {
  const f = await fixture(t);
  const agent = (await readLongAgentRegistry(f.home)).agents[0];
  writeHarness(f.home, "interaction-harness/standards/需求规范.md", "# 需求规范\n\n先对齐场景与交互。");
  const prepared = await prepareLongAgentAssembly({ agent, chatHome: f.home, projectId: "a", turnId: "harness-turn" });
  const instructions = prepared.agent.customInstructions.map((instruction) => instruction.text).join("\n");
  assert.match(instructions, /<chat_interaction_harness revision="sha256:/);
  assert.match(instructions, /先对齐场景与交互/);
});
