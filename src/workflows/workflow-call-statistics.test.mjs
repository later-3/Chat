import assert from "node:assert/strict";
import test from "node:test";
import { MAX_ACTIVE_CHAT_WORKFLOW_CALLS_PER_PARENT } from "./workflow-call-capacity.ts";
import { projectChatWorkflowCallTree, summarizeChatWorkflowCallTree } from "./workflow-call-statistics.ts";

function call(callId, parentSessionId, childSessionId, status, durationMs) {
  const startedAt = "2026-09-03T00:00:00.000Z";
  return {
    schemaVersion: 1,
    callId,
    toolCallId: `tool-${callId}`,
    parent: {
      sessionId: parentSessionId,
      workflowId: "minimal-pi-coding-agent",
      workflowInvocationId: `parent-${callId}`,
      stageId: "execute",
      agentId: "pi-coding-agent",
    },
    child: {
      sessionId: childSessionId,
      workflowId: "minimal-pi-coding-agent",
      workflowInvocationId: `child-${callId}`,
      runId: `run-${callId}`,
    },
    status,
    startedAt,
    updatedAt: startedAt,
    ...(durationMs === undefined ? {} : { finishedAt: startedAt, durationMs }),
  };
}

test("Workflow call statistics separate direct capacity from the reachable call tree", () => {
  const callsBySessionId = new Map([
    ["root", [
      call("one", "root", "child-1", "completed", 100),
      call("two", "root", "child-2", "running"),
    ]],
    ["child-1", [call("three", "child-1", "grandchild", "failed", 50)]],
    ["grandchild", [call("four", "grandchild", "great-grandchild", "cancelled", 25)]],
  ]);

  assert.deepEqual(summarizeChatWorkflowCallTree("root", callsBySessionId), {
    capacity: { active: 1, limit: MAX_ACTIVE_CHAT_WORKFLOW_CALLS_PER_PARENT },
    direct: {
      total: 2,
      active: 1,
      starting: 0,
      running: 1,
      completed: 1,
      failed: 0,
      cancelled: 0,
      totalDurationMs: 100,
    },
    tree: {
      total: 4,
      active: 1,
      starting: 0,
      running: 1,
      completed: 1,
      failed: 1,
      cancelled: 1,
      totalDurationMs: 175,
      subsessionCount: 4,
      maxDepth: 3,
    },
  });
});

test("Workflow call statistics terminate safely if persisted edges contain a cycle", () => {
  const callsBySessionId = new Map([
    ["root", [call("one", "root", "child", "completed", 10)]],
    ["child", [call("two", "child", "root", "completed", 20)]],
  ]);
  const summary = summarizeChatWorkflowCallTree("root", callsBySessionId);
  assert.equal(summary.tree.total, 2);
  assert.equal(summary.tree.subsessionCount, 1);
  assert.equal(summary.tree.maxDepth, 2);
});

test("Workflow call projection keeps pre-order depth and parent call ownership", () => {
  const callsBySessionId = new Map([
    ["root", [
      call("one", "root", "child-1", "completed", 100),
      call("two", "root", "child-2", "running"),
    ]],
    ["child-1", [call("three", "child-1", "grandchild", "completed", 50)]],
    ["grandchild", [call("four", "grandchild", "great-grandchild", "running")]],
  ]);

  const projection = projectChatWorkflowCallTree("root", callsBySessionId);
  assert.deepEqual(projection.workflowCallTree.map((node) => ({
    callId: node.call.callId,
    depth: node.depth,
    parentCallId: node.parentCallId,
  })), [
    { callId: "one", depth: 1, parentCallId: undefined },
    { callId: "three", depth: 2, parentCallId: "one" },
    { callId: "four", depth: 3, parentCallId: "three" },
    { callId: "two", depth: 1, parentCallId: undefined },
  ]);
});
