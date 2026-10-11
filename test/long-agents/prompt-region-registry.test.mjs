import assert from "node:assert/strict";
import test from "node:test";
import {
  PROMPT_REGION_REGISTRY,
  captureSectionTags,
  regionById,
  topLevelTags,
} from "../../src/long-agents/prompt-region-registry.ts";

test("registry 覆盖 9 个实测区域且 id 唯一", () => {
  const ids = PROMPT_REGION_REGISTRY.map((region) => region.id);
  assert.equal(ids.length, 9);
  assert.equal(new Set(ids).size, ids.length);
  for (const expected of [
    "pi-base",
    "chat_agent_custom_instructions",
    "chat_runtime_capability_contract",
    "chat_identity",
    "chat_long_term_memory",
    "chat_interaction_harness",
    "chat_project_collaboration",
    "chat_current_project",
    "chat_context",
  ]) assert.ok(regionById(expected), `缺少区域 ${expected}`);
});

test("嵌套 parent 与 audit §11 字节级结论一致", () => {
  assert.equal(regionById("chat_runtime_capability_contract")?.parent, "chat_agent_custom_instructions");
  assert.equal(regionById("chat_current_project")?.parent, "chat_project_collaboration");
  assert.equal(regionById("chat_identity")?.parent, null);
});

test("topLevelTags 等于原 CHAT_TOP_LEVEL_TAGS 集合（回归锁定）", () => {
  const expected = ["<chat_project_collaboration", "<chat_interaction_harness", "<chat_identity", "<chat_long_term_memory", "<chat_current_project"].sort();
  assert.deepEqual([...topLevelTags()].sort(), expected);
});

test("captureSectionTags 等于原 CHAT_SECTION_TAGS（顺序与内容）", () => {
  const tags = captureSectionTags();
  assert.deepEqual(tags.map((entry) => entry.tag), [
    "chat_current_project",
    "chat_project_collaboration",
    "chat_agent_custom_instructions",
    "chat_interaction_harness",
    "chat_identity",
    "chat_long_term_memory",
  ]);
  assert.equal(tags[0]?.kind, "chat-project");
  assert.equal(tags[3]?.kind, "chat-interaction-harness");
});

test("D8 缺口回归：rcc 与 chat_context 未入捕获白名单、未登记概念空间", () => {
  for (const id of ["chat_runtime_capability_contract", "chat_context"]) {
    const region = regionById(id);
    assert.ok(region);
    assert.equal(region.capture, false, `${id} 不应在捕获白名单`);
    assert.equal(region.documented, false, `${id} 不应在概念空间清单（P1-U2 同步后翻转）`);
  }
});

test("capture 成员全部已登记、已进白名单（除 D8 两项外无暗缺口）", () => {
  for (const region of PROMPT_REGION_REGISTRY) {
    if (region.id === "pi-base") continue; // pi-base 是白名单兜底，非成员
    if (region.capture) assert.equal(region.documented, true, `${region.id} 在白名单却未登记概念空间`);
  }
});
