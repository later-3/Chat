import { describe, expect, it } from "vitest";
import { hashCanonical } from "./canonical-hash.js";
import { computePlanningInputManifestSha256 } from "./planning-input-manifest.js";

const base = {
  productRunId: "run_manifest1",
  planRevision: 1,
  sourceMessageRef: { messageId: "msg_manifest1", sha256: "a".repeat(64) },
  promptTemplateVersion: "planner.v1",
  modelConfigVersion: "model.v1",
};

describe("Planning Input Manifest", () => {
  it("保留v1/v2/v3 Hash域并在显式Memory Selection出现时升级到v4", () => {
    expect(computePlanningInputManifestSha256(base)).toBe(
      hashCanonical("planning-input-manifest.v1", base),
    );
    const memory = {
      ...base,
      contextPackageRef: {
        contextPackageId: "ctxp_manifest1",
        revision: 1,
        sha256: "b".repeat(64),
      },
    };
    expect(computePlanningInputManifestSha256(memory)).toBe(
      hashCanonical("planning-input-manifest.v2", memory),
    );
    const project = {
      ...memory,
      planningProjectContextRef: {
        planningProjectContextId: "pcx_manifest1",
        revision: 1,
        sha256: "c".repeat(64),
      },
    };
    expect(computePlanningInputManifestSha256(project)).toBe(
      hashCanonical("planning-input-manifest.v3", project),
    );
    expect(
      computePlanningInputManifestSha256({
        ...project,
        planningProjectContextRef: { ...project.planningProjectContextRef, sha256: "d".repeat(64) },
      }),
    ).not.toBe(computePlanningInputManifestSha256(project));
    const explicitMemory = {
      ...base,
      planningProjectContextRef: project.planningProjectContextRef,
      planningMemorySelectionRef: {
        planningMemorySelectionId: "pmsl_manifest1",
        revision: 1,
        sha256: "e".repeat(64),
      },
    };
    const expectedV4 = {
      productRunId: explicitMemory.productRunId,
      planRevision: explicitMemory.planRevision,
      sourceMessageRef: explicitMemory.sourceMessageRef,
      planningMemorySelectionRef: explicitMemory.planningMemorySelectionRef,
      planningProjectContextRef: explicitMemory.planningProjectContextRef,
      promptTemplateVersion: explicitMemory.promptTemplateVersion,
      modelConfigVersion: explicitMemory.modelConfigVersion,
    };
    expect(computePlanningInputManifestSha256(explicitMemory)).toBe(
      hashCanonical("planning-input-manifest.v4", expectedV4),
    );
  });
});
