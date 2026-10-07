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
  assert.deepEqual(sections.projects.map((item) => item.name), ["project-guidance.md"]);

  const instruction = interactionHarnessInstruction(sections);
  assert.match(instruction, /<chat_interaction_harness revision="sha256:[0-9a-f]{64}">/);
  assert.match(instruction, /R1 以业务目标为核心/);
  assert.match(instruction, /只在该项目生效/);

  // 专属规范按 (Long Agent × project) 隔离：其他项目读不到
  // 案例（正例/反例）必须全文注入：每次交互前都要先读，否则飞轮无法持续升级。
  writeHarness(f.home, "interaction-harness/AGENTS.md", "# 交互 harness 本层指引\n\n动手前先读案例。");
  writeHarness(f.home, "interaction-harness/cases.md", "## C9（反例）示例\n\n内容");
  writeHarness(f.home, "interaction-harness/flywheel.md", "# 飞轮\n\n为什么这么做");
  writeHarness(f.home, "interaction-harness/concept-space.md", "# 概念空间\n\n## 元规则\n\n怎样建立共同语言");
  writeHarness(f.home, "interaction-harness/concept-space/00-索引.md", "# 概念索引\n\n| 概念 | 正文 |");
  writeHarness(f.home, "interaction-harness/concept-space/harness/00-索引.md", "# harness 作用域索引");
  writeHarness(f.home, "interaction-harness/standards/task规范.md", "# 任务规范");
  const withAssets = await readInteractionHarness({ chatHome: f.home, longAgentId: "friend", projectId: "a" });
  assert.equal(withAssets.assets.some((item) => item.name === "AGENTS.md"), true, "本层指引必须注入");
  assert.equal(withAssets.assets.some((item) => item.name === "cases.md"), true, "案例必须注入");
  assert.equal(withAssets.assets.some((item) => item.name === "flywheel.md"), true, "飞轮必须注入");
  assert.equal(withAssets.assets.some((item) => item.name === "concept-space.md"), true, "概念空间元规则全文注入");
  assert.equal(withAssets.assets.some((item) => item.name === "concept-space/00-索引.md"), true, "概念索引全文注入");
  assert.equal(withAssets.common.some((item) => item.name === "task规范.md"), true, "任务规范属于通用规范");
  const assetInstruction = interactionHarnessInstruction(withAssets);
  assert.match(assetInstruction, /C9（反例）示例/, "注入内容包含案例正文");
  assert.match(assetInstruction, /先读反例与正例/, "注入内容提示先读案例");
  assert.match(assetInstruction, /怎样建立共同语言/, "元规则全文进注入");
  assert.match(assetInstruction, /概念索引/, "概念索引全文进注入");

  const other = await readInteractionHarness({ chatHome: f.home, longAgentId: "friend", projectId: "b" });
  assert.deepEqual(other.projects, []);
  assert.deepEqual(
    other.common.map((item) => item.name),
    ["需求规范.md", "前端规范.md", "task规范.md"],
    "通用规范对所有项目生效（含任务规范）",
  );
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

test("身份以 Chat 定义为主；NanoClaw 只作覆盖；两个开关独立生效", async (t) => {
  const f = await fixture(t);
  writeHarness(f.home, "interaction-harness/standards/需求规范.md", "# 需求规范\n\n先对齐场景与交互。");
  const agent = (await readLongAgentRegistry(f.home)).agents[0];
  const instructionsOf = async (candidate) => {
    const prepared = await prepareLongAgentAssembly({ agent: candidate, chatHome: f.home, projectId: "a", turnId: `identity-${candidate.name}` });
    return prepared.agent.customInstructions.map((instruction) => instruction.text).join("\n");
  };

  // A. NanoClaw 可用：基础身份来自 Chat 定义，NanoClaw 作为覆盖片段；长期记忆注入
  const live = await instructionsOf(agent);
  assert.match(live, /<chat_identity source="chat">/);
  assert.match(live, new RegExp(`<runtime_identity_name>${agent.name}</runtime_identity_name>`));
  assert.match(live, /<nanoclaw_identity source="nanoclaw"/, "NanoClaw 作为身份覆盖来源");
  assert.match(live, /<chat_long_term_memory source="nanoclaw"/);
  assert.match(live, /<chat_interaction_harness revision="sha256:/, "交互 harness 缺省开启");

  // B. 关闭长期记忆：身份与覆盖不受影响，只少记忆区
  const memoryOff = await instructionsOf({ ...agent, agentMemory: "off" });
  assert.doesNotMatch(memoryOff, /<chat_long_term_memory/);
  assert.match(memoryOff, /<chat_identity source="chat">/);
  assert.match(memoryOff, /<nanoclaw_identity source="nanoclaw"/);

  // C. 关闭交互 harness：只影响规范注入
  const harnessOff = await instructionsOf({ ...agent, interactionHarness: "off" });
  assert.doesNotMatch(harnessOff, /<chat_interaction_harness/);
  assert.match(harnessOff, /<chat_identity source="chat">/);

  // D. NanoClaw 不可用：身份依然完整（Chat 定义），只是没有覆盖与记忆
  fs.rmSync(path.join(f.home, "runtime/long-agents/friend/agent-group-snapshot.json"));
  const noNano = await instructionsOf(agent);
  assert.match(noNano, /<chat_identity source="chat">/);
  assert.match(noNano, new RegExp(`<runtime_identity_name>${agent.name}</runtime_identity_name>`));
  assert.doesNotMatch(noNano, /<nanoclaw_identity/);
  assert.doesNotMatch(noNano, /<chat_long_term_memory/);
});
