import assert from "node:assert/strict";
import test from "node:test";

import type { Interrupt } from "@ag-ui/core";

import { governedReviewFromInterrupt, reviewCardFromInterrupt } from "../src/use-chat-agent.js";

function interrupt(data: Record<string, unknown>): Interrupt {
  return {
    id: String(data.approval_id ?? "interrupt"),
    value: "",
    metadata: { agent_framework: { data } },
  } as unknown as Interrupt;
}

test("Workflow可区分模型请求与pi内部Tool审批", () => {
  const tool = governedReviewFromInterrupt(
    interrupt({
      review_kind: "tool_execution",
      approval_id: "pi-tool-approval",
      tool_call_id: "call-1",
      tool_id: "pi_agent",
      tool_name: "read",
      arguments: { path: "README.md" },
      working_directory: "/workspace",
      risk: "只读",
      config_revision: 2,
      execution_context: {
        workflow_id: "governed-pi-agent",
        executor_id: "pi_agent.tool_gate",
        tool_id: "pi_agent",
        wait_reason: "pi_internal_tool_approval",
      },
    }),
  );

  assert.equal(tool?.review_kind, "tool_execution");
  if (tool?.review_kind !== "tool_execution") assert.fail("expected tool review");
  assert.deepEqual(tool.arguments, { path: "README.md" });
  assert.equal(
    reviewCardFromInterrupt(interrupt(tool as unknown as Record<string, unknown>)),
    null,
  );
});

test("缺少真实Tool身份或参数的中断不会进入审批UI", () => {
  assert.equal(
    governedReviewFromInterrupt(
      interrupt({
        review_kind: "tool_execution",
        approval_id: "bad",
        tool_call_id: "call",
        arguments: {},
      }),
    ),
    null,
  );
});

test("产品Decision Point中断保留请求版本、可编辑字段和允许动作", () => {
  const review = governedReviewFromInterrupt(
    interrupt({
      review_kind: "product_decision",
      approval_id: "decision-request-1",
      decision_request_id: "decision-request-1",
      decision_point_key: "intent_binding",
      title: "确认我对本轮意图的理解",
      reason_summary: "策略要求用户确认",
      request_hash: "request-hash",
      row_version: 1,
      subject_hash: "subject-hash",
      subject: { scenario: "clarify", goal: "继续昨天那个" },
      facts: { intent: { confidence: 0 } },
      policy: { final_action: "require_human", matched_rules: [], reason_codes: [] },
      allowed_actions: ["accept", "revise", "cancel"],
      editable_fields: [{ key: "goal", label: "本轮目标", type: "text", value: "继续昨天那个" }],
      execution_context: {
        workflow_id: "continuous-collaboration",
        workflow_version: "1.0.0",
        executor_id: "intent_binding",
        wait_reason: "product_decision",
      },
    }),
  );

  assert.equal(review?.review_kind, "product_decision");
  if (review?.review_kind !== "product_decision") assert.fail("expected product decision");
  assert.equal(review.decision_point_key, "intent_binding");
  assert.deepEqual(review.allowed_actions, ["accept", "revise", "cancel"]);
  assert.equal(review.editable_fields[0]?.key, "goal");
});

test("缺少Decision Request身份的产品中断不会进入审批UI", () => {
  assert.equal(
    governedReviewFromInterrupt(
      interrupt({
        review_kind: "product_decision",
        approval_id: "bad",
        decision_point_key: "intent_binding",
        allowed_actions: ["accept"],
        editable_fields: [],
      }),
    ),
    null,
  );
});
