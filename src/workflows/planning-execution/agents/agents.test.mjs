import assert from "node:assert/strict";
import test from "node:test";
import { PLANNER_AGENT } from "./planner/index.ts";
import { PLANNING_EXECUTION_AGENT } from "./pi-coding-agent/index.ts";
import { buildPlanningExecutionTaskBrief } from "../context.ts";

test("planner has the context capabilities and policy needed to produce an executable review", () => {
  assert.equal(PLANNER_AGENT.systemPrompt.mode, "replace");
  assert.match(PLANNER_AGENT.systemPrompt.text, /当前Session和用户最新请求或审核意见/);
  assert.match(PLANNER_AGENT.systemPrompt.text, /不执行最终任务/);
  assert.match(PLANNER_AGENT.systemPrompt.text, /memory_search作为稳定历史事实的正常信息源/);
  assert.match(PLANNER_AGENT.systemPrompt.text, /长期背景、所在地、偏好、既有约束、历史决定或项目约定/);
  assert.match(PLANNER_AGENT.systemPrompt.text, /available_skills/);
  assert.match(PLANNER_AGENT.systemPrompt.text, /read完整读取该SKILL\.md/);
  assert.match(PLANNER_AGENT.systemPrompt.text, /天气、价格、库存、花期、政策、网页内容、当前代码行为/);
  assert.match(PLANNER_AGENT.systemPrompt.text, /只有实际收到ToolResult后/);
  assert.match(PLANNER_AGENT.systemPrompt.text, /背景与动机/);
  assert.match(PLANNER_AGENT.systemPrompt.text, /范围与非目标/);
  assert.match(PLANNER_AGENT.systemPrompt.text, /needs_clarification/);
  assert.match(PLANNER_AGENT.systemPrompt.text, /不能把“向用户确认”“等待用户选择”写成Executor/);
  assert.match(PLANNER_AGENT.systemPrompt.text, /审核摘要/);
  assert.match(PLANNER_AGENT.systemPrompt.text, /Executor任务书/);
  assert.match(PLANNER_AGENT.systemPrompt.text, /执行边界与授权点/);
  assert.match(PLANNER_AGENT.systemPrompt.text, /验收标准/);
  assert.deepEqual(PLANNER_AGENT.tools, {
    mode: "explicit",
    names: ["read"],
    exclude: [],
    addresses: ["system:tool/memory_search"],
  });
  assert.deepEqual(PLANNER_AGENT.resources, { mode: "inherit" });
  assert.equal(PLANNER_AGENT.tools.names.some((name) => ["bash", "edit", "write"].includes(name)), false);
});

test("execution rules and the versioned task brief preserve goal, plan, authority, and evidence", () => {
  const instructions = PLANNING_EXECUTION_AGENT.customInstructions.map((item) => item.text).join("\n");
  assert.match(instructions, /userRequest作为真实目标/);
  assert.match(instructions, /approvedPlan作为本轮已审核的执行任务书/);
  assert.match(instructions, /不要让用户重复提供/);
  assert.match(instructions, /另行授权点/);
  assert.match(instructions, /验证证据/);
  const input = buildPlanningExecutionTaskBrief({
    userRequest: "original request",
    approvedPlan: "one approved plan",
    approvedPlanRevision: 3,
  });
  assert.match(input, /<workflow_execution_task_brief>/);
  assert.match(input, /"userRequest": "original request"/);
  assert.match(input, /"approvedPlanRevision": 3/);
  assert.match(input, /"approvedPlan": "one approved plan"/);
  assert.match(input, /"authorityRule"/);
  assert.match(input, /"completionReport"/);
});
