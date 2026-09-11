import assert from "node:assert/strict";
import test from "node:test";
import {
  buildReplyFormatInstruction,
  DEFAULT_RESPONSE_TEMPLATE,
  localDate,
  renderResponseTemplate,
} from "../../src/long-agents/reply-template.ts";

const vars = { project: "Chat", agentName: "Nexus", date: "2026-09-11" };

test("the template is a prompt instruction, not a program-side wrapper", () => {
  assert.equal(DEFAULT_RESPONSE_TEMPLATE, "project：{{project}}");
  // 变量被替换成当前值，Agent 只需照抄这一行。
  assert.equal(renderResponseTemplate(undefined, vars), "project：Chat");
  assert.equal(renderResponseTemplate("{{agentName}} @ {{date}}", vars), "Nexus @ 2026-09-11");
  // 空模板 → 不注入任何格式要求。
  assert.equal(buildReplyFormatInstruction("", vars), null);
  assert.equal(buildReplyFormatInstruction(undefined, vars), [
    "回复格式要求：每条回复的最后另起一行，原样输出下面这段内容（不要改写、不要省略）：",
    "project：Chat",
  ].join("\n"));
});

test("localDate stays a stable local date string", () => {
  assert.equal(localDate(new Date("2026-09-11T13:00:00Z")).length, 10);
});
