import assert from "node:assert/strict";
import test from "node:test";
import type { RunGovernanceView, StepInputProjection } from "../src/workflow-api.js";
import { governanceForNode, stepInputForNode } from "../src/workflow-run-view.js";

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
