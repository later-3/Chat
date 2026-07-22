import assert from "node:assert/strict";
import test from "node:test";

import type { ProductRun } from "../src/session-api.js";
import type { ProductTraceEvent } from "../src/workflow-api.js";
import {
  deriveWorkflowRunProjection,
  WORKFLOW_STAGES,
} from "../src/workflow-run-projection.js";

function run(status: string, failureCode: string | null = null): ProductRun {
  return {
    id: `run-${status}`,
    session_id: "session-1",
    interaction_id: "interaction-1",
    agui_run_id: `agui-${status}`,
    status,
    current_user_message_id: "message-1",
    assistant_message_id: null,
    model_provider_id: "provider",
    model: "model",
    retry_of_run_id: null,
    retry_mode: null,
    input_text: "验证工作流",
    failure_code: failureCode,
    failure_message: null,
    started_at: "2026-07-22T00:00:00Z",
    finished_at: null,
    attempts: [],
  };
}

function stageStatus(
  projection: ReturnType<typeof deriveWorkflowRunProjection>,
  stageId: string,
) {
  return projection.stages.find((stage) => stage.id === stageId)?.status;
}

test("设计者执行链固定展示真实代码边界且只有三个阶段属于MAF Executor内部", () => {
  const projection = deriveWorkflowRunProjection("running", false, null);

  assert.equal(projection.stages.length, 12);
  assert.equal(WORKFLOW_STAGES.filter((stage) => stage.mafExecutorChild).length, 3);
  assert.equal(stageStatus(projection, "request.compile"), "in_progress");
  assert.equal(stageStatus(projection, "provider.dispatch"), "not_started");
});

test("模型请求中断后准确停在发送前审批阶段", () => {
  const projection = deriveWorkflowRunProjection("awaiting_approval", true, run("waiting_approval"));

  assert.equal(projection.status, "waiting_approval");
  assert.equal(stageStatus(projection, "request.compile"), "completed");
  assert.equal(stageStatus(projection, "approval.wait"), "waiting_approval");
  assert.equal(stageStatus(projection, "approval.claim"), "not_started");
  assert.equal(stageStatus(projection, "provider.dispatch"), "not_started");
});

test("用户放弃后Provider和Product提交阶段明确显示已跳过", () => {
  const projection = deriveWorkflowRunProjection("idle", false, run("abandoned"));

  assert.equal(projection.status, "abandoned");
  assert.equal(stageStatus(projection, "approval.wait"), "abandoned");
  assert.equal(stageStatus(projection, "provider.dispatch"), "skipped");
  assert.equal(stageStatus(projection, "provider.receive"), "skipped");
  assert.equal(stageStatus(projection, "provider.decode"), "skipped");
  assert.equal(stageStatus(projection, "product.commit"), "skipped");
  assert.equal(stageStatus(projection, "agui.terminal"), "completed");
});

test("Provider结果未知不会显示为完成且产品提交保持跳过", () => {
  const projection = deriveWorkflowRunProjection("idle", false, run("outcome_unknown", "provider_timeout"));

  assert.equal(projection.status, "failed");
  assert.equal(projection.statusLabel, "结果未知，需要确认");
  assert.equal(stageStatus(projection, "provider.dispatch"), "failed");
  assert.equal(stageStatus(projection, "product.commit"), "skipped");
});

test("Product提交门失败只把提交阶段标记为失败", () => {
  const projection = deriveWorkflowRunProjection("idle", false, run("failed", "product_commit_failed"));

  assert.equal(stageStatus(projection, "provider.dispatch"), "completed");
  assert.equal(stageStatus(projection, "provider.decode"), "completed");
  assert.equal(stageStatus(projection, "agui.project"), "completed");
  assert.equal(stageStatus(projection, "product.commit"), "failed");
});

test("持久Trace覆盖粗粒度Run推断并保留公开详情和时间", () => {
  const trace: ProductTraceEvent[] = [
    {
      id: "trace-1",
      session_id: "session-1",
      run_id: "run-running",
      sequence: 9,
      event_type: "workflow.stage",
      payload: {
        stage_id: "provider.receive",
        status: "in_progress",
        details: { transport: "sse" },
      },
      created_at: "2026-07-22T00:00:09Z",
    },
  ];
  const projection = deriveWorkflowRunProjection("running", false, run("running"), trace);
  const receive = projection.stages.find((stage) => stage.id === "provider.receive");

  assert.equal(receive?.status, "in_progress");
  assert.deepEqual(receive?.details, { transport: "sse" });
  assert.equal(receive?.occurredAt, "2026-07-22T00:00:09Z");
});

test("已完成历史Run恢复为十二个代码阶段完成", () => {
  const projection = deriveWorkflowRunProjection("idle", false, run("succeeded"));

  assert.equal(projection.status, "completed");
  assert.ok(projection.stages.every((stage) => stage.status === "completed"));
});
