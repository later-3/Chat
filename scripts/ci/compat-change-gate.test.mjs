import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { shouldRunCompat } from "./compat-change-gate.mjs";

describe("compat change gate", () => {
  it("always runs on main push, nightly schedule, and manual dispatch", () => {
    for (const eventName of ["push", "schedule", "workflow_dispatch"]) {
      assert.equal(shouldRunCompat(eventName), true);
    }
  });

  it("runs for PR changes owned by historical contracts, stores, workflows, or the lane gate", () => {
    for (const path of [
      "packages/contracts/src/product-store.ts",
      "packages/product-store-json/src/json-product-store.ts",
      "packages/workflows/src/runtime-bindings.ts",
      "config/test-lanes.json",
      "scripts/ci/test-lanes.mjs",
    ]) {
      assert.equal(shouldRunCompat("pull_request", [path]), true, path);
    }
  });

  it("skips an unrelated PR and fails closed for unknown events", () => {
    assert.equal(shouldRunCompat("pull_request", ["docs/product/flywheel.md"]), false);
    assert.throws(() => shouldRunCompat("issue_comment", []), /不支持/u);
  });
});
