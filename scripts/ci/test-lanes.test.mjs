import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { auditTestLaneManifest, loadTestLaneManifest } from "./test-lanes.mjs";

describe("test lane manifest", () => {
  it("classifies every formal test and root test script exactly once", () => {
    const result = auditTestLaneManifest(loadTestLaneManifest());
    assert.ok(result.fileCount > 190);
    assert.ok(result.rootScriptCount >= 20);
  });

  it("fails for an unclassified or duplicate formal test", () => {
    const missing = structuredClone(loadTestLaneManifest());
    missing.files.shift();
    assert.throws(() => auditTestLaneManifest(missing), /正式测试未分类/u);

    const duplicate = structuredClone(loadTestLaneManifest());
    duplicate.files.push(structuredClone(duplicate.files[0]));
    assert.throws(() => auditTestLaneManifest(duplicate), /重复分类/u);
  });

  it("fails when a lane command drifts or references a missing source", () => {
    const commandDrift = structuredClone(loadTestLaneManifest());
    commandDrift.rootScripts.find((entry) => entry.name === "test:core").command =
      "node missing.mjs";
    assert.throws(() => auditTestLaneManifest(commandDrift), /lane命令与Manifest漂移/u);

    const missingSource = structuredClone(loadTestLaneManifest());
    missingSource.laneTasks.beta.push({
      name: "missing",
      source: "scripts/e2e/missing.mjs",
      command: ["node", "scripts/e2e/missing.mjs"],
    });
    assert.throws(() => auditTestLaneManifest(missingSource), /引用不存在/u);
  });

  it("keeps default lanes bounded and removes global heap overrides", () => {
    const manifest = loadTestLaneManifest();
    assert.deepEqual(manifest.deterministicLanes, ["core", "contract", "integration", "compat"]);
    assert.ok(manifest.batch.vitestFiles <= 6);
    const runner = readFileSync(new URL("./test-lanes.mjs", import.meta.url), "utf8");
    assert.doesNotMatch(runner, /8192|--max-old-space-size/u);
    assert.match(runner, /delete environment\.NODE_OPTIONS/u);
  });
});
