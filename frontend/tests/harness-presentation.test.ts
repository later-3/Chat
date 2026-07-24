import assert from "node:assert/strict";
import test from "node:test";

import { collaborationMethodPresentation } from "../src/features/harness/harness-presentation.js";

test("多目标方法同时展示基础协议与本轮有效组合策略", () => {
  const value = collaborationMethodPresentation(
    {
      protocol_name: "直接回答",
      protocol_revision: 1,
      selection_reason: "命中系统默认的简单询问方法",
      base_execution_policy: {
        planner: "disabled",
        allowed_roles: ["responder"],
      },
      effective_execution_policy: {
        planner: "required_for_intent_set",
        allowed_roles: ["responder", "planner"],
      },
      composition_overlay: {
        kind: "intent_set",
        reason: "Intent Set含多个目标，必须先形成组合计划",
        intent_count: 2,
      },
    },
    7,
  );

  assert.equal(value.protocolName, "直接回答");
  assert.equal(value.revision, "1");
  assert.equal(value.hasCompositionOverlay, true);
  assert.equal(value.compositionTitle, "先形成组合计划");
  assert.equal(value.intentCount, 2);
  assert.equal(value.basePlannerLabel, "不需要规划");
  assert.equal(value.effectivePlannerLabel, "必须形成组合计划");
});

test("单目标保持基础方法，不从卡片数量猜测运行时覆盖策略", () => {
  const value = collaborationMethodPresentation(
    {
      protocol_name: "持续项目推进",
      selection_reason: "命中Project级绑定",
      base_execution_policy: { planner: "enabled" },
      effective_execution_policy: { planner: "enabled" },
    },
    3,
  );

  assert.equal(value.revision, "3");
  assert.equal(value.hasCompositionOverlay, false);
  assert.equal(value.basePlannerLabel, "允许按需规划");
  assert.equal(value.effectivePlannerLabel, "允许按需规划");
});
