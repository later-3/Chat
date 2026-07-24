import assert from "node:assert/strict";
import test from "node:test";
import { buildMindMapProjection } from "../src/features/workflow/workflow-mind-map-projection.js";
import {
  actualWorkflowPath,
  routeDecisionsFromTrace,
  unselectedBranchNodeIds,
} from "../src/features/workflow/workflow-route-projection.js";
import { deriveSystemJourney } from "../src/features/workflow/workflow-system-journey.js";
import type { ProductRun } from "../src/session-api.js";
import type { ProductTraceEvent, WorkflowDefinition } from "../src/workflow-api.js";

const node = (id: string, kind = "output") => ({
  id,
  label: id,
  description: id,
  kind,
  runtime_type: "executor" as const,
  parent_id: null,
  depth: 0,
});

const definition: WorkflowDefinition = {
  id: "continuous-collaboration",
  name: "持续协作主 Workflow",
  version: "1.2.0",
  description: "test",
  endpoint: "/api/workflows/continuous-collaboration/run",
  selectable: true,
  nodes: [
    node("input_acceptance", "input"),
    node("scenario_router", "decision"),
    node("project_catalog_query"),
    node("clarification"),
    node("planning_agent", "agent"),
    node("plan_acceptance", "approval"),
    node("execution_draft_compiler", "governance"),
    node("result_commit", "approval"),
    node("turn_summary_persist"),
    node("result_finalization"),
  ],
  edges: [
    { source: "input_acceptance", target: "scenario_router" },
    {
      source: "scenario_router",
      target: "project_catalog_query",
      condition: "intent.query_kind = project_catalog",
      branch_id: "project_catalog",
      label: "查询正式Project目录",
    },
    {
      source: "scenario_router",
      target: "clarification",
      condition: "state.scenario = clarify",
      branch_id: "clarification",
      label: "请求用户澄清",
    },
    {
      source: "scenario_router",
      target: "planning_agent",
      condition: "needs_plan(state) = true",
      branch_id: "planning",
      label: "先形成任务计划",
    },
    {
      source: "scenario_router",
      target: "execution_draft_compiler",
      condition: "Default",
      branch_id: "direct_response",
      label: "直接进入执行草稿",
    },
    { source: "project_catalog_query", target: "result_commit" },
    { source: "clarification", target: "turn_summary_persist" },
    { source: "planning_agent", target: "plan_acceptance" },
    { source: "plan_acceptance", target: "execution_draft_compiler" },
    { source: "execution_draft_compiler", target: "result_commit" },
    { source: "result_commit", target: "turn_summary_persist" },
    { source: "turn_summary_persist", target: "result_finalization" },
  ],
};

function trace(
  sequence: number,
  executorId: string,
  status: "in_progress" | "completed" | "failed" = "completed",
): ProductTraceEvent {
  return {
    id: `trace-${sequence}`,
    session_id: "session",
    run_id: "run",
    sequence,
    event_type: "workflow.node",
    payload: { workflow_id: definition.id, executor_id: executorId, status },
    created_at: `2026-07-23T00:00:${String(sequence).padStart(2, "0")}Z`,
  };
}

function routeContent(routeDecision?: Record<string, unknown>): ProductTraceEvent {
  return {
    id: "route-content",
    session_id: "session",
    run_id: "run",
    sequence: 3,
    event_type: "workflow.node.content",
    payload: {
      workflow_id: definition.id,
      executor_id: "scenario_router",
      actor: "deterministic_scenario_router",
      content_type: "scenario_route",
      public_input: {
        scenario: "simple_question",
        needs_plan: false,
      },
      public_output: {
        scenario: "simple_question",
        branch: "direct_response",
        ...(routeDecision ? { route_decision: routeDecision } : {}),
      },
    },
    created_at: "2026-07-23T00:00:03Z",
  };
}

test("读取持久路由求值并展示四个候选与选择原因", () => {
  const decision = routeDecisionsFromTrace(definition, [
    routeContent({
      decision_kind: "maf_switch_case",
      selection_mode: "first_match",
      selected_branch: "direct_response",
      selected_target: "execution_draft_compiler",
      selection_reason: "前三条Case均未命中，MAF执行Default分支。",
      facts: {
        "intent.query_kind": "未设置",
        "state.scenario": "simple_question",
        "needs_plan(state)": false,
      },
      options: definition.edges
        .filter((edge) => edge.source === "scenario_router")
        .map((edge) => ({
          branch_id: edge.branch_id,
          label: edge.label,
          target: edge.target,
          condition: edge.condition,
          actual: edge.branch_id === "direct_response",
          matched: edge.branch_id === "direct_response",
          selected: edge.branch_id === "direct_response",
          reason:
            edge.branch_id === "direct_response"
              ? "前三条Case均未命中，MAF执行Default分支。"
              : "本轮公开事实不满足该条件。",
        })),
    }),
  ])[0];

  assert.equal(decision.evidence, "persisted_evaluation");
  assert.equal(decision.selectedBranch, "direct_response");
  assert.equal(decision.options.length, 4);
  assert.equal(decision.options.filter((option) => option.selected).length, 1);
  assert.equal(decision.facts["state.scenario"], "simple_question");
});

test("旧Trace保留最终分支事实并明确标记兼容说明", () => {
  const [decision] = routeDecisionsFromTrace(definition, [routeContent()]);

  assert.equal(decision.evidence, "legacy_trace");
  assert.equal(decision.selectedTarget, "execution_draft_compiler");
  assert.equal(decision.options.find((option) => option.selected)?.label, "直接进入执行草稿");
  assert.match(decision.selectionReason, /旧版Trace/);
});

test("未选择分支只标记分支独占节点，不误伤后续汇合链", () => {
  const runTrace = [
    trace(1, "input_acceptance"),
    trace(2, "scenario_router"),
    routeContent(),
    trace(4, "execution_draft_compiler"),
    trace(5, "result_commit"),
    trace(6, "turn_summary_persist"),
    trace(7, "result_finalization"),
  ];
  const decisions = routeDecisionsFromTrace(definition, runTrace);
  const skipped = unselectedBranchNodeIds(definition, runTrace, decisions);

  assert.deepEqual(
    [...skipped].sort(),
    ["clarification", "plan_acceptance", "planning_agent", "project_catalog_query"].sort(),
  );
  assert.equal(skipped.has("execution_draft_compiler"), false);
  assert.equal(skipped.has("result_commit"), false);
  assert.equal(skipped.has("turn_summary_persist"), false);
});

test("实际路径严格按Trace sequence排序而不是目录顺序", () => {
  const path = actualWorkflowPath(definition, [
    trace(8, "result_finalization"),
    trace(2, "scenario_router"),
    trace(1, "input_acceptance"),
    trace(4, "execution_draft_compiler"),
  ]);

  assert.deepEqual(
    path.map((value) => value.id),
    ["input_acceptance", "scenario_router", "execution_draft_compiler", "result_finalization"],
  );
});

test("思维导图把选择前、真实选择节点和选中分支后续分开", () => {
  const runTrace = [
    trace(1, "input_acceptance"),
    trace(2, "scenario_router"),
    routeContent({
      decision_kind: "maf_switch_case",
      selection_mode: "first_match",
      selected_branch: "direct_response",
      selected_target: "execution_draft_compiler",
      selection_reason: "前三条Case均未命中，MAF执行Default分支。",
      facts: {
        "intent.query_kind": "未设置",
        "state.scenario": "simple_question",
        "needs_plan(state)": false,
      },
      options: definition.edges
        .filter((edge) => edge.source === "scenario_router")
        .map((edge) => ({
          branch_id: edge.branch_id,
          label: edge.label,
          target: edge.target,
          condition: edge.condition,
          actual: edge.branch_id === "direct_response",
          matched: edge.branch_id === "direct_response",
          selected: edge.branch_id === "direct_response",
          reason:
            edge.branch_id === "direct_response"
              ? "前三条Case均未命中，MAF执行Default分支。"
              : "本轮公开事实不满足该条件。",
        })),
    }),
    trace(4, "execution_draft_compiler"),
    trace(5, "result_commit"),
    trace(6, "turn_summary_persist"),
    trace(7, "result_finalization"),
  ];
  const projection = buildMindMapProjection(definition, runTrace);

  assert.equal(projection.decisionNode?.id, "scenario_router");
  assert.deepEqual(
    projection.beforeDecision.map((node) => node.id),
    ["input_acceptance"],
  );
  assert.deepEqual(
    projection.afterSelectedTarget.map((node) => node.id),
    ["result_commit", "turn_summary_persist", "result_finalization"],
  );
});

test("没有选择事件时思维导图退化为真实线性路径", () => {
  const projection = buildMindMapProjection(definition, [
    trace(1, "input_acceptance"),
    trace(2, "scenario_router"),
  ]);

  assert.equal(projection.decision, null);
  assert.deepEqual(
    projection.beforeDecision.map((node) => node.id),
    ["input_acceptance", "scenario_router"],
  );
  assert.deepEqual(projection.afterSelectedTarget, []);
});

test("系统执行链区分前端、产品、Worker、MAF和最终呈现", () => {
  const run: ProductRun = {
    id: "run",
    session_id: "session",
    interaction_id: "interaction",
    agui_run_id: "agui-run",
    status: "succeeded",
    current_user_message_id: "message-user",
    assistant_message_id: "message-assistant",
    model_provider_id: "provider",
    model: "model",
    retry_of_run_id: null,
    retry_mode: null,
    input_text: "测试",
    failure_code: null,
    failure_message: null,
    started_at: "2026-07-23T00:00:00Z",
    finished_at: "2026-07-23T00:00:08Z",
    attempts: [],
    runtime_job: {
      id: "job",
      product_run_id: "run",
      run_attempt_id: "attempt",
      endpoint_key: "continuous-collaboration",
      workflow_definition_id: definition.id,
      workflow_version: definition.version,
      status: "succeeded",
      recoverability: "terminal",
      checkpoint_id: null,
      lease_owner: null,
      lease_epoch: 1,
      lease_expires_at: null,
      heartbeat_at: null,
      last_event_sequence: 8,
      earliest_retained_sequence: 1,
      external_dispatch_state: "none",
      failure_code: null,
      failure_summary: null,
      cursor: "cursor",
    },
  };
  const journey = deriveSystemJourney(
    definition,
    [trace(1, "input_acceptance"), trace(8, "result_finalization")],
    run,
  );

  assert.deepEqual(
    journey.map((step) => step.id),
    [
      "frontend_submit",
      "product_acceptance",
      "runtime_worker",
      "maf_workflow",
      "product_commit",
      "frontend_projection",
    ],
  );
  assert.ok(journey.every((step) => step.status === "completed"));
});
