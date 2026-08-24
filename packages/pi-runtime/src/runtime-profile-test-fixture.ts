import { hashCanonical } from "@chat/domain";

export function readRuntimeToolFixture() {
  const descriptorInput = {
    schemaVersion: "capability-descriptor.v1" as const,
    capabilityId: "pi_direct:tool:builtin:read",
    kind: "executable_tool" as const,
    runtimeOwner: "pi_direct" as const,
    localName: "read",
    sourceRef: {
      sourceKind: "builtin" as const,
      package: "@earendil-works/pi-coding-agent",
      repository: "later-3/pi",
      revision: "1".repeat(40),
      resourcePath: "pi/packages/coding-agent/src/core/tools/read.ts",
    },
    inputSchemaSha256: hashCanonical("test-tool-schema.v1", { name: "read" }),
    effect: "read" as const,
    scopePolicy: "workspace_required" as const,
    approvalPolicy: "run_policy" as const,
    evidencePolicy: "runtime_journal" as const,
    readiness: "available" as const,
  };
  const descriptorSha256 = hashCanonical("capability-descriptor.v1", descriptorInput);
  return {
    name: "read",
    description: "Read a file",
    parametersJson: "{}",
    sourceRelativePath: descriptorInput.sourceRef.resourcePath,
    capability: { ...descriptorInput, descriptorSha256 },
    resolvedRef: {
      capabilityId: descriptorInput.capabilityId,
      descriptorSha256,
      inputSchemaSha256: descriptorInput.inputSchemaSha256,
      resolvedImplementationSha256: hashCanonical(
        "test-tool-implementation.v1",
        descriptorInput.sourceRef,
      ),
      scopeRef: { kind: "global" as const },
    },
  };
}
