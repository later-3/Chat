import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPlanningExecutionInput,
  buildPlanningPrompt,
  PLANNING_EXECUTION_SYSTEM_PROMPT,
  PLANNING_SYSTEM_PROMPT,
} from "./workflows/planning-execution-prompts.ts";

test("planner is instructed to use the current Session and only produce a plan", () => {
  assert.match(PLANNING_SYSTEM_PROMPT, /当前Session历史/);
  assert.match(PLANNING_SYSTEM_PROMPT, /不是执行任务/);
});

test("execution rules distinguish the user's request from Planner output", () => {
  assert.match(PLANNING_EXECUTION_SYSTEM_PROMPT, /userRequest是用户原始输入/);
  assert.match(PLANNING_EXECUTION_SYSTEM_PROMPT, /plannerOutput是Planner Agent的输出/);
  assert.match(PLANNING_EXECUTION_SYSTEM_PROMPT, /不要只复述计划/);
  const input = buildPlanningExecutionInput("original request", "one plan");
  assert.match(input, /"userRequest": "original request"/);
  assert.match(input, /"plannerOutput": "one plan"/);
});

test("planner request separates the user's prompt from planning instructions", () => {
  assert.equal(
    buildPlanningPrompt("change the code"),
    [
      "请为下面的用户请求制定计划。只输出计划，不要直接回答用户：",
      "<user_request>",
      "change the code",
      "</user_request>",
    ].join("\n"),
  );
});
