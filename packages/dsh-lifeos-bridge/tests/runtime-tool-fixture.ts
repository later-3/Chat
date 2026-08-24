export function readRuntimeToolFixture() {
  return {
    name: "read",
    description: "读取文件",
    parametersJson: "{}",
    sourceRelativePath: "pi/packages/coding-agent/src/core/tools/read.ts",
    capability: {
      schemaVersion: "capability-descriptor.v1" as const,
      capabilityId: "pi_direct:tool:builtin:read",
      kind: "executable_tool" as const,
      runtimeOwner: "pi_direct" as const,
      localName: "read",
      sourceRef: {
        sourceKind: "builtin" as const,
        package: "@earendil-works/pi-coding-agent",
        repository: "later-3/pi",
        revision: "a".repeat(40),
        resourcePath: "pi/packages/coding-agent/src/core/tools/read.ts",
      },
      inputSchemaSha256: "1".repeat(64),
      effect: "read" as const,
      scopePolicy: "workspace_required" as const,
      approvalPolicy: "run_policy" as const,
      evidencePolicy: "runtime_journal" as const,
      readiness: "available" as const,
      descriptorSha256: "2".repeat(64),
    },
    resolvedRef: {
      capabilityId: "pi_direct:tool:builtin:read",
      descriptorSha256: "2".repeat(64),
      inputSchemaSha256: "1".repeat(64),
      resolvedImplementationSha256: "3".repeat(64),
      scopeRef: { kind: "global" as const },
    },
  };
}
