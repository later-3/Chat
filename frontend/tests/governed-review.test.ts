import assert from "node:assert/strict";
import test from "node:test";

import type { Interrupt } from "@ag-ui/core";

import {
  governedReviewFromInterrupt,
  reviewCardFromInterrupt,
} from "../src/use-chat-agent.js";


function interrupt(data: Record<string, unknown>): Interrupt {
  return {
    id: String(data.approval_id ?? "interrupt"),
    value: "",
    metadata: { agent_framework: { data } },
  } as unknown as Interrupt;
}


test("Workflow可区分模型请求与pi内部Tool审批", () => {
  const tool = governedReviewFromInterrupt(interrupt({
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
  }));

  assert.equal(tool?.review_kind, "tool_execution");
  if (tool?.review_kind !== "tool_execution") assert.fail("expected tool review");
  assert.deepEqual(tool.arguments, { path: "README.md" });
  assert.equal(reviewCardFromInterrupt(interrupt(tool as unknown as Record<string, unknown>)), null);
});


test("缺少真实Tool身份或参数的中断不会进入审批UI", () => {
  assert.equal(governedReviewFromInterrupt(interrupt({
    review_kind: "tool_execution",
    approval_id: "bad",
    tool_call_id: "call",
    arguments: {},
  })), null);
});
