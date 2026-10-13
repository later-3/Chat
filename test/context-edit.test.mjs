import assert from "node:assert/strict";
import test from "node:test";
import {
  EMPTY_CONTEXT_EDIT,
  applyContextEdit,
  entryBlockId,
  isContextEditEmpty,
  readContextEditFromEntries,
  splitSubEntries,
  splitSystemSegments,
  tagBlockId,
  tagSubEntryBlockId,
  toolBlockId,
} from "../src/context-edit.ts";

test("splitSystemSegments：重组逐字等于原文（含文本间隔与未闭合标签）", () => {
  const samples = [
    "",
    "纯文本没有标签",
    '<chat_identity source="chat">我是 Coder</chat_identity>',
    'head text\n<chat_identity>身份</chat_identity>\n中间文本\n<chat_interaction_harness revision="3">规范</chat_interaction_harness>\n尾巴',
    '<chat_identity>身份</chat_identity>',
    "开头文本<chat_a>x</chat_a>中间<chat_b>y</chat_b>结尾",
    "<chat_unclosed>没有闭合",
    "<chat_a>前</chat_a><chat_unclosed>坏",
    '属性带引号 <chat_identity source="a>b">含>内容</chat_identity>',
  ];
  for (const sample of samples) {
    const segments = splitSystemSegments(sample);
    assert.equal(segments.map((segment) => segment.raw).join(""), sample, `重组应逐字等于原文：${JSON.stringify(sample)}`);
  }
});

test("splitSystemSegments：识别 chat_ 区块与内部文本", () => {
  const segments = splitSystemSegments('pre<chat_identity source="chat">身份</chat_identity>post');
  assert.deepEqual(segments.map((segment) => segment.kind), ["text", "block", "text"]);
  assert.equal(segments[1].tag, "chat_identity");
  assert.equal(segments[1].text, "身份");
});

test("splitSystemSegments：只切 chat_ 区块，Pi 自身标签（agent/name/skill…）留在文本片段", () => {
  const sample = 'a<agent><name>coder</name><skill>p</skill></agent>b<chat_identity>身份</chat_identity>c';
  const segments = splitSystemSegments(sample);
  assert.equal(segments.map((segment) => segment.raw).join(""), sample);
  assert.deepEqual(segments.filter((segment) => segment.kind === "block").map((segment) => segment.tag), ["chat_identity"]);
});

test("applyContextEdit：空层或非对象 payload 原样返回（快速路径）", () => {
  const payload = { messages: [{ role: "system", content: "x" }] };
  assert.equal(applyContextEdit(payload, "openai-completions", EMPTY_CONTEXT_EDIT).payload, payload);
  assert.equal(applyContextEdit(null, "openai-completions", EMPTY_CONTEXT_EDIT).payload, null);
});

test("applyContextEdit：排除 system 区块 → 该块删除、其余逐字保留、计数正确（用户场景①）", () => {
  const systemText = '头<chat_identity source="chat">我是 Coder</chat_identity>中<chat_interaction_harness revision="3">规范</chat_interaction_harness>尾';
  const payload = { model: "m", messages: [{ role: "system", content: systemText }, { role: "user", content: "你好" }] };
  const layer = { ...EMPTY_CONTEXT_EDIT, excluded: [tagBlockId("chat_identity")], revision: 1 };
  const result = applyContextEdit(payload, "openai-completions", layer);
  const edited = result.payload;
  assert.equal(edited.messages[0].content, '头中<chat_interaction_harness revision="3">规范</chat_interaction_harness>尾');
  assert.equal(result.excludedCount, 1);
  // 原始 payload 不被改写（原记录零改写）
  assert.equal(payload.messages[0].content, systemText);
});

test("applyContextEdit：排除工具与消息条目的计数（用户场景②）", () => {
  const payload = {
    messages: [{ role: "system", content: "<chat_identity>x</chat_identity>" }],
    tools: [{ type: "function", function: { name: "read" } }, { type: "function", function: { name: "write" } }],
  };
  const layer = { ...EMPTY_CONTEXT_EDIT, excluded: [toolBlockId("read"), entryBlockId("e-9")], revision: 1 };
  const result = applyContextEdit(payload, "openai-completions", layer);
  assert.deepEqual(result.payload.tools.map((tool) => tool.function.name), ["write"]);
  assert.equal(result.excludedCount, 2);
});

test("applyContextEdit：anthropic 形态（payload.system 字符串与 text parts）", () => {
  const layer = { ...EMPTY_CONTEXT_EDIT, excluded: [tagBlockId("chat_current_project")], revision: 1 };
  const stringForm = applyContextEdit(
    { system: "a<chat_current_project>项目</chat_current_project>b", messages: [] },
    "anthropic-messages",
    layer,
  );
  assert.equal(stringForm.payload.system, "ab");
  const partsForm = applyContextEdit(
    { system: [{ type: "text", text: "a<chat_current_project>项目</chat_current_project>b" }], messages: [] },
    "anthropic-messages",
    layer,
  );
  assert.deepEqual(partsForm.payload.system, [{ type: "text", text: "ab" }]);
});

test("applyContextEdit：没有命中时不改写 payload（避免无谓复制）", () => {
  const payload = { messages: [{ role: "system", content: "<chat_identity>x</chat_identity>" }] };
  const layer = { ...EMPTY_CONTEXT_EDIT, excluded: [tagBlockId("chat_不存在")], revision: 1 };
  const result = applyContextEdit(payload, "openai-completions", layer);
  assert.equal(result.payload, payload);
  assert.equal(result.excludedCount, 0);
});

test("readContextEditFromEntries：最后一条即有效集，revision 单调（覆盖式快照）", () => {
  const entries = [
    { type: "custom", customType: "chat.context-edit", data: { excluded: ["tag:a"], revision: 1 } },
    { type: "message", data: {} },
    { type: "custom", customType: "chat.context-edit", data: { excluded: ["tag:b", "tag:b", ""], modified: { "tag:c": "改后" }, added: { g: ["新条"] } } },
  ];
  const layer = readContextEditFromEntries(entries);
  assert.equal(layer.revision, 2);
  assert.deepEqual(layer.excluded, ["tag:b"]);
  assert.equal(layer.modified["tag:c"], "改后");
  assert.deepEqual(layer.added.g, ["新条"]);
});

test("readContextEditFromEntries：无条目 = 空层；isContextEditEmpty 判定", () => {
  assert.deepEqual(readContextEditFromEntries([]), EMPTY_CONTEXT_EDIT);
  assert.equal(isContextEditEmpty(EMPTY_CONTEXT_EDIT), true);
  assert.equal(isContextEditEmpty({ ...EMPTY_CONTEXT_EDIT, excluded: ["tag:a"] }), false);
  assert.equal(isContextEditEmpty({ ...EMPTY_CONTEXT_EDIT, added: { g: ["x"] }, revision: 3 }), false);
});

test("readContextEditFromEntries：非法数据被丢弃（严格归一化）", () => {
  const layer = readContextEditFromEntries([
    { type: "custom", customType: "chat.context-edit", data: { excluded: "不是数组", modified: [1, 2], added: { g: "字符串" } } },
  ]);
  assert.deepEqual(layer.excluded, []);
  assert.deepEqual(layer.modified, {});
  assert.deepEqual(layer.added, {});
});

test("splitSubEntries：harness 按四类文件条目切、记忆按一级小节切、identity 不切", () => {
  const harness = "前言\n## 纯规则 · protocol/a.md\n\n规则A\n\n---\n\n## 通用规范 · 需求规范.md\n\n规范B\n";
  const subs = splitSubEntries("chat_interaction_harness", harness);
  assert.deepEqual(subs.map((entry) => entry.id), ["protocol/a.md", "需求规范.md"]);
  assert.equal(subs[0].raw, "## 纯规则 · protocol/a.md\n\n规则A\n\n---\n");
  assert.equal(subs[0].title, "protocol/a.md");
  const memory = "## Core Memory\n事实\n## Open Knowledge Format\n格式\n";
  assert.deepEqual(splitSubEntries("chat_long_term_memory", memory).map((entry) => entry.id), ["Core Memory", "Open Knowledge Format"]);
  assert.deepEqual(splitSubEntries("chat_identity", "没有小节"), []);
});

test("applyContextEdit：子条目级排除只删该条目，块与其他条目逐字保留（用户场景③）", () => {
  const systemText = '<chat_interaction_harness revision="1">前言\n## 纯规则 · protocol/a.md\n\n规则A\n\n---\n\n## 通用规范 · 需求规范.md\n\n规范B\n</chat_interaction_harness><chat_identity source="chat">身份</chat_identity>';
  const payload = { messages: [{ role: "system", content: systemText }] };
  const layer = { ...EMPTY_CONTEXT_EDIT, excluded: [tagSubEntryBlockId("chat_interaction_harness", "protocol/a.md")], revision: 1 };
  const result = applyContextEdit(payload, "openai-completions", layer);
  const out = result.payload.messages[0].content;
  assert.equal(out.includes("规则A"), false, "被排除条目内容消失");
  assert.equal(out.includes("规范B"), true, "其他条目保留");
  assert.equal(out.includes("<chat_interaction_harness"), true, "块本身保留");
  assert.equal(out.includes('<chat_identity source="chat">身份</chat_identity>'), true, "其他块逐字保留");
  assert.equal(out.includes("前言"), true, "块前言保留");
  assert.equal(result.excludedCount, 1);
  assert.equal(result.excludedIds[0], "tag:chat_interaction_harness#protocol/a.md");
  assert.equal(payload.messages[0].content, systemText, "原 payload 不改写");
});
