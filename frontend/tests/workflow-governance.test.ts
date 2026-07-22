import assert from "node:assert/strict";
import test from "node:test";

import { governanceForNode } from "../src/workflow-run-view.js";
import type { RunGovernanceView } from "../src/workflow-api.js";

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

  assert.deepEqual(details.HumanDecisionRequests.map((value) => value.id), ["request-response"]);
});
