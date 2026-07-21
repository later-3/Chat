import assert from "node:assert/strict";
import test from "node:test";

import type { ProductTraceEvent, WorkflowDefinition } from "../src/workflow-api.js";
import {
  applyExecutorActivity,
  emptyWorkflowProgress,
  progressFromTrace,
} from "../src/workflow-progress.js";


const definition: WorkflowDefinition = {
  id: "nested",
  name: "嵌套测试",
  version: "1",
  description: "test",
  endpoint: "/workflow",
  nodes: [
    {
      id: "parent",
      label: "父流程",
      description: "parent",
      kind: "workflow",
      runtime_type: "workflow",
      parent_id: null,
      depth: 0,
    },
    {
      id: "parent.child",
      label: "子节点",
      description: "child",
      kind: "decision",
      runtime_type: "executor",
      parent_id: "parent",
      depth: 1,
    },
  ],
  edges: [{ source: "parent", target: "parent.child" }],
};


function trace(
  sequence: number,
  executorId: string,
  status: "in_progress" | "completed" | "failed",
): ProductTraceEvent {
  return {
    id: `trace-${sequence}`,
    session_id: "session",
    run_id: "run",
    sequence,
    event_type: "workflow.node",
    payload: { workflow_id: "nested", executor_id: executorId, status },
    created_at: "2026-07-21T00:00:00Z",
  };
}


test("同一executor_id按事件原位更新且不重建无关节点", () => {
  const initial = emptyWorkflowProgress(definition);
  const childBefore = initial["parent.child"];
  const running = applyExecutorActivity(
    initial,
    { executor_id: "parent", status: "in_progress" },
    1,
  );

  assert.equal(running.parent.status, "in_progress");
  assert.equal(running["parent.child"], childBefore);
  assert.equal(Object.keys(running).length, 2);
});


test("刷新后用Product Trace恢复两层节点终态", () => {
  const progress = progressFromTrace(definition, [
    trace(4, "parent", "in_progress"),
    trace(5, "parent.child", "in_progress"),
    trace(6, "parent.child", "completed"),
    trace(7, "parent", "completed"),
  ]);

  assert.equal(progress.parent.status, "completed");
  assert.equal(progress.parent.sequence, 7);
  assert.equal(progress["parent.child"].status, "completed");
  assert.equal(progress["parent.child"].sequence, 6);
});


test("旧序号和未知节点不能覆盖当前Workflow投影", () => {
  const completed = progressFromTrace(definition, [trace(10, "parent.child", "completed")]);
  const stale = applyExecutorActivity(
    completed,
    { executor_id: "parent.child", status: "in_progress" },
    9,
  );
  const unknown = applyExecutorActivity(
    stale,
    { executor_id: "invented-node", status: "completed" },
    11,
  );

  assert.equal(stale, completed);
  assert.equal(unknown, completed);
  assert.equal(unknown["parent.child"].status, "completed");
});
