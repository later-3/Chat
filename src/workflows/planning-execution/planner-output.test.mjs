import assert from "node:assert/strict";
import test from "node:test";
import { parsePlannerOutput } from "./planner-output.ts";

test("parses a ready review document without exposing the machine metadata", () => {
  const output = parsePlannerOutput([
    '<!-- chat-planner-output {"schemaVersion":1,"readiness":"ready_for_review","blockingQuestions":[]} -->',
    "# 执行计划",
    "## 任务理解",
    "完成已明确的任务。",
  ].join("\n"));
  assert.equal(output.readiness, "ready_for_review");
  assert.deepEqual(output.blockingQuestions, []);
  assert.equal(output.document, "# 执行计划\n## 任务理解\n完成已明确的任务。");
});

test("parses blocking clarification questions and rejects inconsistent readiness", () => {
  const output = parsePlannerOutput([
    '<!-- chat-planner-output {"schemaVersion":1,"readiness":"needs_clarification","blockingQuestions":["预算上限是多少？","使用哪种冲煮方式？"]} -->',
    "# 任务澄清",
    "请补充两个会改变候选范围的信息。",
  ].join("\n"));
  assert.equal(output.readiness, "needs_clarification");
  assert.deepEqual(output.blockingQuestions, ["预算上限是多少？", "使用哪种冲煮方式？"]);
  assert.throws(() => parsePlannerOutput("# 没有协议的计划"), /缺少.*元数据/);
  assert.throws(() => parsePlannerOutput([
    '<!-- chat-planner-output {"schemaVersion":1,"readiness":"ready_for_review","blockingQuestions":["仍缺信息"]} -->',
    "# 错误计划",
  ].join("\n")), /不能包含阻塞问题/);
  assert.throws(() => parsePlannerOutput([
    '<!-- chat-planner-output {"schemaVersion":1,"readiness":"needs_clarification","blockingQuestions":[]} -->',
    "# 错误澄清",
  ].join("\n")), /至少一个阻塞问题/);
});
