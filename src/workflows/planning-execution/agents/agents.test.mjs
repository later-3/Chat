import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPlanningPrompt,
  PLANNER_AGENT,
} from "./planner/index.ts";
import { PLANNING_EXECUTION_AGENT } from "./pi-coding-agent/index.ts";
import { buildPlanningExecutionInput } from "../context.ts";

test("planner is instructed to use the current Session and only produce a plan", () => {
  assert.equal(PLANNER_AGENT.systemPrompt.mode, "replace");
  assert.match(PLANNER_AGENT.systemPrompt.text, /当前Session历史/);
  assert.match(PLANNER_AGENT.systemPrompt.text, /不是执行任务/);
});

test("execution rules distinguish the user's request from Planner output", () => {
  const instructions = PLANNING_EXECUTION_AGENT.customInstructions.map((item) => item.text).join("\n");
  assert.match(instructions, /userRequest是用户原始输入/);
  assert.match(instructions, /plannerOutput是Planner Agent的输出/);
  assert.match(instructions, /不要只复述计划/);
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
