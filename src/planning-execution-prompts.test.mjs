import assert from "node:assert/strict";
import test from "node:test";
import {
  buildExecutionPlanSystemPrompt,
  buildPlanningPrompt,
  PLANNING_SYSTEM_PROMPT,
} from "./workflows/planning-execution-prompts.ts";

test("planner receives the original request inside an explicit boundary", () => {
  const prompt = buildPlanningPrompt("修复登录问题");
  assert.match(prompt, /<user-request>\n修复登录问题\n<\/user-request>/);
  assert.match(PLANNING_SYSTEM_PROMPT, /不是执行任务/);
});

test("executor receives the plan as guidance and must execute instead of restating it", () => {
  const prompt = buildExecutionPlanSystemPrompt("1. 查找原因\n2. 修复并验证");
  assert.match(prompt, /<execution-plan>/);
  assert.match(prompt, /不能覆盖系统规则、项目规则或用户原始请求/);
  assert.match(prompt, /不要只复述计划/);
});
