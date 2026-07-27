import assert from "node:assert/strict";
import test from "node:test";

import {
  mergeValidationPlan,
  splitValidationPlan,
} from "../src/execution-draft-validation-plan.js";

test("frozen contract is extracted read-only while other keys stay editable", () => {
  const plan = {
    checks: ["structured intent"],
    evidence: "workflow trace",
    contract: {
      plan_revision_id: "rev-1",
      contract_hash: "ab".repeat(32),
      rules: [{ ordinal: 1, capability_key: "pytest-suite" }],
    },
  };
  const split = splitValidationPlan(plan);
  assert.deepEqual(split.editable, { checks: ["structured intent"], evidence: "workflow trace" });
  assert.equal(split.hasContractKey, true);
  assert.equal(split.contract?.plan_revision_id, "rev-1");
});

test("merge preserves the frozen contract byte-for-byte and rejects tampering paths", () => {
  const plan = {
    checks: ["a"],
    contract: { contract_hash: "cd".repeat(32) },
  };
  const merged = mergeValidationPlan(plan, { checks: ["a", "user note"] });
  assert.deepEqual(merged.checks, ["a", "user note"]);
  assert.deepEqual(merged.contract, { contract_hash: "cd".repeat(32) });
  // 用户编辑结果不可能新增或覆盖contract键。
  const injected = mergeValidationPlan(plan, {
    checks: ["a"],
    contract: { contract_hash: "00".repeat(32) },
  });
  assert.deepEqual(injected.contract, { contract_hash: "cd".repeat(32) });
});

test("null contract key is preserved; absent key is never invented", () => {
  const withNull = splitValidationPlan({ checks: [], contract: null });
  assert.equal(withNull.hasContractKey, true);
  assert.equal(withNull.contract, null);
  const mergedNull = mergeValidationPlan({ checks: [], contract: null }, { checks: ["x"] });
  assert.equal("contract" in mergedNull, true);
  assert.equal(mergedNull.contract, null);

  const without = splitValidationPlan({ checks: [] });
  assert.equal(without.hasContractKey, false);
  const mergedWithout = mergeValidationPlan({ checks: [] }, { checks: ["x"] });
  assert.equal("contract" in mergedWithout, false);
});

test("non-object validation_plan degrades to empty editable without contract", () => {
  assert.deepEqual(splitValidationPlan(null), {
    editable: {},
    contract: null,
    hasContractKey: false,
  });
  assert.deepEqual(splitValidationPlan(["checks"]), {
    editable: {},
    contract: null,
    hasContractKey: false,
  });
});
