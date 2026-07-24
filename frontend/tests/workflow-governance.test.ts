import assert from "node:assert/strict";
import test from "node:test";
import type {
  GovernedToolExecution,
  RunGovernanceView,
  StepInputProjection,
} from "../src/workflow-api.js";
import {
  governanceForNode,
  internalActivityForNode,
  outputForNode,
  stepInputForNode,
} from "../src/workflow-run-view.js";

test("节点治理详情只展示属于当前 Agent 的模型调用请求", () => {
  const governance = {
    run_id: "run-1",
    execution_draft: null,
    run_spec: null,
    turn_summary: null,
    policy_evaluations: [
      {
        id: "evaluation-response",
        subject_id: "subject-response",
        subject_kind: "model_call_draft",
        workflow_node_id: "response_agent",
        decision_point_key: "model_call_authorization",
        applicability_status: "applicable",
        floor_action: "auto_continue",
        preference_action: "require_human",
        final_action: "require_human",
        result_status: "resolved",
        reason_codes: ["policy_resolved"],
        evaluated_at: "2026-07-22T00:00:00Z",
      },
    ],
    decision_requests: [
      {
        id: "request-intent",
        decision_point_key: "model_call_authorization",
        request_hash: "intent-hash",
        title: "确认意图模型调用",
        reason_summary: "需要确认",
        visible_evidence: { workflow_node_id: "intent_agent" },
        consequence: {},
        status: "resolved",
        row_version: 2,
        created_at: "2026-07-22T00:00:00Z",
      },
      {
        id: "request-response",
        decision_point_key: "model_call_authorization",
        request_hash: "response-hash",
        title: "确认响应模型调用",
        reason_summary: "需要确认",
        visible_evidence: { workflow_node_id: "response_agent" },
        consequence: {},
        status: "resolved",
        row_version: 2,
        created_at: "2026-07-22T00:00:01Z",
      },
    ],
    model_calls: [
      {
        id: "call-response",
        workflow_node_id: "response_agent",
        call_ordinal: 3,
        status: "reviewable",
        current_revision_id: "revision-response",
        revisions: [],
      },
    ],
  } satisfies RunGovernanceView;

  const details = governanceForNode("response_agent", governance) as {
    HumanDecisionRequests: Array<{ id: string }>;
  };

  assert.deepEqual(
    details.HumanDecisionRequests.map((value) => value.id),
    ["request-response"],
  );
});

test("节点详情只投影同一真实节点最新revision的运行时工作包", () => {
  const base = {
    id: "projection-1",
    run_id: "run-1",
    workflow_definition_id: "continuous-collaboration",
    workflow_version: "1.3.0",
    node_id: "response_agent",
    projection_revision: 1,
    agent_profile_key: "collaboration",
    context_package_id: "context-1",
    protocol_definition_id: "protocol-1",
    protocol_binding_id: "binding-1",
    run_spec_id: "spec-1",
    input: { goal: "旧目标" },
    capability_allowlist: [],
    budget: { max_model_calls: 1 },
    output_contract: { type: "assistant_message" },
    stop_conditions: ["需要新权限时停止"],
    projection_hash: "old-hash",
    created_at: "2026-07-24T00:00:00Z",
  } satisfies StepInputProjection;
  const values: StepInputProjection[] = [
    base,
    {
      ...base,
      id: "projection-2",
      projection_revision: 2,
      input: { goal: "当前目标" },
      projection_hash: "new-hash",
    },
    { ...base, id: "projection-other", node_id: "intent_agent", projection_hash: "other-hash" },
  ];

  const detail = stepInputForNode("response_agent", values) as {
    目标与背景: { goal: string };
    revision: number;
    hash: string;
  };

  assert.equal(detail.目标与背景.goal, "当前目标");
  assert.equal(detail.revision, 2);
  assert.equal(detail.hash, "new-hash");
  assert.equal(stepInputForNode("missing", values), undefined);
});

test("pi节点同时投影多次模型调用、内部Tool活动和Repository围栏", () => {
  const governance = {
    run_id: "run-pi",
    execution_draft: null,
    run_spec: null,
    turn_summary: null,
    policy_evaluations: [],
    decision_requests: [],
    model_calls: [
      {
        id: "call-1",
        workflow_node_id: "pi_readonly_dispatch",
        call_ordinal: 3,
        status: "completed",
        current_revision_id: "revision-1",
        revisions: [],
      },
      {
        id: "call-2",
        workflow_node_id: "pi_readonly_dispatch",
        call_ordinal: 4,
        status: "completed",
        current_revision_id: "revision-2",
        revisions: [],
      },
    ],
  } satisfies RunGovernanceView;
  const execution = {
    id: "execution-1",
    session_id: "session-1",
    run_id: "run-pi",
    run_attempt_id: "attempt-1",
    runtime_job_id: "job-1",
    run_spec_id: "spec-1",
    step_input_projection_id: "input-1",
    repository_binding_id: "binding-1",
    repository_snapshot_id: "snapshot-1",
    tool_id: "pi_agent",
    execution_ordinal: 1,
    mode: "readonly",
    config_revision: 2,
    status: "succeeded",
    process_dispatch_state: "finished",
    last_activity_sequence: 2,
    model_call_count: 2,
    internal_tool_call_count: 1,
    tokens: { input: 120, output: 36, cache_read: 0, cache_write: 0 },
    cost: 0.01,
    duration_ms: 1800,
    metrics: {
      activities: [
        {
          sequence: 1,
          stage: "process_started",
          status: "running",
          summary: "pi只读进程已启动",
          details: {},
        },
      ],
      tool_calls: [{ tool_name: "read", status: "completed" }],
    },
    result: { final_text: "README标题为Chat" },
    result_hash: "result-hash",
    failure_code: null,
    terminal_reason_code: "pi_completed",
    started_at: "2026-07-25T00:00:00Z",
    finished_at: "2026-07-25T00:00:02Z",
    row_version: 5,
  } satisfies GovernedToolExecution;

  const details = governanceForNode("pi_readonly_dispatch", governance, [execution]) as {
    ModelCallDrafts: unknown[];
    ToolExecution审计索引: Array<Record<string, unknown>>;
  };

  assert.equal(details.ModelCallDrafts.length, 2);
  assert.equal(details.ToolExecution审计索引.length, 1);
  assert.equal(details.ToolExecution审计索引[0].结果Hash, "result-hash");

  assert.deepEqual(outputForNode("pi_readonly_dispatch", undefined, [execution]), {
    final_text: "README标题为Chat",
  });
  assert.equal(outputForNode("response_agent", "普通节点结果", [execution]), "普通节点结果");

  const activity = internalActivityForNode("pi_readonly_dispatch", [execution]) as {
    Repository只读围栏: Record<string, unknown>;
    活动时间线: Array<Record<string, unknown>>;
  };
  assert.deepEqual(activity.Repository只读围栏, {
    Binding: "binding-1",
    Snapshot: "snapshot-1",
    模式: "readonly",
  });
  assert.deepEqual(activity.活动时间线, [
    {
      序号: 1,
      活动: "pi只读进程启动",
      状态: "running",
      说明: "pi只读进程已启动",
    },
  ]);
});

test("SD3节点展示隔离工作区、精确Diff、Attempt和对账事实", () => {
  const execution = {
    id: "execution-workspace",
    session_id: "session-1",
    run_id: "run-workspace",
    run_attempt_id: "attempt-1",
    runtime_job_id: "job-1",
    run_spec_id: "spec-1",
    step_input_projection_id: "input-1",
    repository_binding_id: "binding-1",
    repository_snapshot_id: "snapshot-1",
    tool_id: "pi_agent",
    execution_ordinal: 1,
    mode: "workspace_edit",
    config_revision: 3,
    status: "succeeded",
    process_dispatch_state: "finished",
    last_activity_sequence: 3,
    model_call_count: 2,
    internal_tool_call_count: 2,
    tokens: { input: 180, output: 52, cache_read: 0, cache_write: 0 },
    cost: 0.02,
    duration_ms: 2400,
    metrics: {
      activities: [
        {
          sequence: 1,
          stage: "process_started",
          status: "running",
          summary: "pi隔离工作区进程已启动",
          details: { workspace_id: "workspace-1" },
        },
      ],
    },
    result: { final_text: "已完成精确修改" },
    result_hash: "result-hash",
    failure_code: null,
    terminal_reason_code: "pi_completed",
    workspace: {
      id: "workspace-1",
      product_run_id: "run-workspace",
      run_attempt_id: "attempt-1",
      runtime_job_id: "job-1",
      tool_execution_id: "execution-workspace",
      repository_binding_id: "binding-1",
      repository_snapshot_id: "snapshot-1",
      workspace_kind: "managed_git_worktree",
      source: {
        root_key: "code",
        relative_path: "Chat",
        base_revision: "base-head",
      },
      observed_head_oid: "base-head",
      status: "retained",
      diff_hash: "diff-hash",
      changed_paths: ["README.md"],
      failure_code: null,
      row_version: 4,
      created_at: "2026-07-25T00:00:00Z",
      ready_at: "2026-07-25T00:00:01Z",
      retained_at: "2026-07-25T00:00:03Z",
      finished_at: "2026-07-25T00:00:03Z",
    },
    operations: [
      {
        id: "operation-1",
        authorization_consumption_id: "consumption-1",
        provider_tool_call_id: "tool-call-1",
        tool_name: "edit",
        operation_ordinal: 1,
        operation_kind: "exact_text_edit",
        side_effect_class: "workspace_write",
        arguments: {
          path: "README.md",
          old_text: "# Chat",
          new_text: "# Chat Workspace",
        },
        arguments_hash: "arguments-hash",
        operation_hash: "operation-hash",
        target_path: "README.md",
        expected_preimage_hash: "before-hash",
        expected_postimage_hash: "after-hash",
        diff_preview: "-# Chat\n+# Chat Workspace\n",
        status: "succeeded",
        dispatch_epoch: 1,
        observed_hash: "after-hash",
        result: { changed: true },
        result_hash: "operation-result-hash",
        failure_code: null,
        resolution_code: "dispatch_confirmed",
        attempts: [{ attempt_number: 1, status: "succeeded" }],
        reconciliations: [],
      },
    ],
    started_at: "2026-07-25T00:00:00Z",
    finished_at: "2026-07-25T00:00:03Z",
    row_version: 7,
  } satisfies GovernedToolExecution;

  assert.deepEqual(outputForNode("execution_workspace_prepare", undefined, [execution]), {
    ...execution.workspace,
  });
  assert.deepEqual(outputForNode("pi_workspace_result_assembly", undefined, [execution]), {
    final_text: "已完成精确修改",
  });

  const activity = internalActivityForNode("pi_workspace_dispatch", [execution]) as {
    Repository执行边界: Record<string, unknown>;
    隔离工作区: Record<string, unknown>;
    写操作: Array<Record<string, unknown>>;
  };
  assert.equal(activity.Repository执行边界.模式, "workspace_edit");
  assert.deepEqual(activity.隔离工作区.变更文件, ["README.md"]);
  assert.equal(activity.写操作[0].状态, "succeeded");
  assert.equal(activity.写操作[0].Diff, "-# Chat\n+# Chat Workspace\n");
  assert.deepEqual(activity.写操作[0].执行尝试, [{ attempt_number: 1, status: "succeeded" }]);
});
