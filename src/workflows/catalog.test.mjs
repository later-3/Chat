import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAT_WORKFLOW_MANIFESTS,
  listAgentCallableWorkflowTargets,
} from "./catalog.ts";

test("Workflow declaration catalog is the single target-discovery source", () => {
  assert.deepEqual(CHAT_WORKFLOW_MANIFESTS.map((workflow) => workflow.id), [
    "minimal-pi-coding-agent",
    "planning-execution",
    "planner-orchestrator",
    "memory",
    "rule-management",
  ]);
  assert.deepEqual(
    listAgentCallableWorkflowTargets(),
    [
      {
        id: "minimal-pi-coding-agent",
        name: "直接执行",
        description: "使用一个Pi Coding Agent直接处理当前用户请求。",
        agentIds: ["pi-coding-agent"],
      },
      {
        id: "planning-execution",
        name: "规划执行",
        description: "Planner先补齐任务理解；阻塞信息在审核Task中澄清，完整计划批准后由Pi Coding Agent按任务书执行。",
        agentIds: ["planner", "pi-coding-agent"],
      },
      {
        id: "planner-orchestrator",
        name: "规划协调",
        description: "Planner形成可审核计划；批准后Coordinator按工作包调用多个执行Workflow并汇总结果。",
        agentIds: ["planner", "coordinator"],
      },
      {
        id: "memory",
        name: "长期记忆",
        description: "由Memory Agent按用户的明确指令管理长期记忆。",
        agentIds: ["memory-agent"],
      },
    ],
  );
});
