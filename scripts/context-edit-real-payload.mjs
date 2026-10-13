/**
 * 真实 payload 验证（B5）：用会话记录里的真实请求体核对编辑层应用结果。
 * 用法：node --import ./scripts/typescript-test-loader.mjs --experimental-strip-types \
 *         scripts/context-edit-real-payload.mjs <payload.json.gz>
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { applyContextEdit, EMPTY_CONTEXT_EDIT, splitSystemSegments, tagBlockId, toolBlockId } from "../src/context-edit.ts";

const file = process.argv[2];
if (!file) { console.error("用法: <payload.json.gz>"); process.exit(1); }
const payload = JSON.parse(gunzipSync(readFileSync(file)).toString("utf8"));
const messages = Array.isArray(payload.messages) ? payload.messages : [];
const systemMessage = messages.find((message) => message?.role === "system");
const systemText = typeof systemMessage?.content === "string" ? systemMessage.content : "";
assert.ok(systemText.length > 0, "样本应含 system 文本");

const blocks = splitSystemSegments(systemText).filter((segment) => segment.kind === "block");
console.log(`真实 payload：system ${systemText.length} 字符，可编辑块 ${blocks.length}，tools ${(payload.tools ?? []).length}`);
for (const block of blocks) console.log(`  - tag:${block.tag}  ${block.text.length} 字符`);

const harnessBlock = blocks.find((block) => block.tag === "chat_interaction_harness");
assert.ok(harnessBlock, "样本应含 chat_interaction_harness");
const layer = {
  ...EMPTY_CONTEXT_EDIT,
  excluded: [tagBlockId("chat_interaction_harness"), toolBlockId("read")],
  revision: 1,
};
const result = applyContextEdit(payload, "openai-completions", layer);
const editedMessages = result.payload.messages;
const editedSystem = editedMessages.find((message) => message?.role === "system").content;

assert.equal(result.excludedCount, 2, "命中 harness 块 + read 工具");
assert.equal((result.payload.tools ?? []).length, (payload.tools ?? []).length - 1, "工具减少 1 个");
assert.equal(editedSystem.length, systemText.length - harnessBlock.raw.length, "system 长度 = 原长度 − harness 块长度");
assert.equal(editedSystem.includes("chat_interaction_harness"), false, "结果不含 harness 块");
assert.equal(editedSystem.includes("chat_identity"), systemText.includes("chat_identity"), "其他块保留状态不变");
assert.equal(payload.messages[0].content, systemText, "原始 payload 未被改写（原记录零改写）");
console.log(`✓ 排除 harness + read：system ${systemText.length} → ${editedSystem.length}（省 ${harnessBlock.raw.length}），tools ${(payload.tools ?? []).length} → ${(result.payload.tools ?? []).length}`);
