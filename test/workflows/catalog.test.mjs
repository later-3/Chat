import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAT_WORKFLOW_MANIFESTS,
  listAgentCallableWorkflowTargets,
} from "../../src/workflows/catalog.ts";

test("Workflow declaration catalog is the single target-discovery source", () => {
  assert.deepEqual(CHAT_WORKFLOW_MANIFESTS.map((workflow) => workflow.id), [
    "minimal-pi-coding-agent",
    "planning-execution",
    "planner-orchestrator",
    "memory",
    "rule-management",
    "session-memory",
    "problem-diagnosis",
    "topic-session-create",
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
      {
        id: "session-memory",
        name: "会话记忆",
        description: "在一个节点会话里跑完一轮工作（work），随后由会话记忆写入 agent 记录本轮（remember）。既有记忆按需读取，不注入上下文。",
        agentIds: ["session-memory-worker"],
      },
      {
        id: "problem-diagnosis",
        name: "问题定位",
        description: "对一个线上或代码问题做结构化定位：先列已确认现场事实，再给互斥根因假设与各自的最小验证路径，最后给出结论边界与仍待确认的信息。",
        agentIds: ["problem-diagnoser"],
      },
      {
        id: "topic-session-create",
        name: "主题会话创建",
        description: "整理 Agent 收集上下文形成草稿，用户审核（可多轮修改）批准后由创建 Agent 调用受控动作创建真实主题节点会话。",
        agentIds: ["topic-collector", "topic-creator"],
      },
    ],
  );
});
