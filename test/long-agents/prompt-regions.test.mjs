import assert from "node:assert/strict";
import test from "node:test";
import { summarizePromptRegions } from "../../src/long-agents/prompt-regions.ts";

test("prompt 区域构成：提取区域名、revision 与字符数", () => {
  const regions = summarizePromptRegions([
    '<chat_identity source="chat">\n身份内容\n</chat_identity>',
    '<chat_interaction_harness revision="sha256:abc">\n规范\n</chat_interaction_harness>',
    '<chat_long_term_memory source="nanoclaw">\n记忆\n</chat_long_term_memory>',
  ]);
  assert.deepEqual(regions.map((region) => region.name),
    ["chat_identity", "chat_interaction_harness", "chat_long_term_memory"]);
  assert.equal(regions[0].revision, null, "没有 revision 属性时为 null");
  assert.equal(regions[1].revision, "sha256:abc");
  assert.equal(regions[1].characters > 0, true);
});

test("prompt 区域构成：空段与无标签段不崩", () => {
  const regions = summarizePromptRegions(["", "   ", "纯文本没有标签"]);
  assert.deepEqual(regions, [{ name: "(unnamed)", revision: null, characters: "纯文本没有标签".length }]);
});
