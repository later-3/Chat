import { hashCanonical } from "@chat/domain";

export function runtimeToolFixture(
  name: string,
  options: { readonly workspaceRootId?: string; readonly workspaceExtension?: boolean } = {},
) {
  const projectBootstrap = name === "project_bootstrap_prepare";
  const effect = ["read", "grep", "find", "ls"].includes(name)
    ? ("read" as const)
    : name === "bash"
      ? ("shell" as const)
      : name === "edit" || name === "write"
        ? ("local_write" as const)
        : ("external_write" as const);
  const sourceRef = projectBootstrap
    ? {
        sourceKind: "managed_extension" as const,
        repository: "later-3/Chat",
        revision: "1".repeat(40),
        artifactSha256: hashCanonical("test-managed-extension.v1", { name }),
        resourcePath: "packages/pi-runtime/src/direct-agent-executor.ts",
      }
    : options.workspaceExtension
      ? {
          sourceKind: "workspace_extension" as const,
          package: "workspace-test",
          resourcePath: `<WORKSPACE_ROOT>/.pi/extensions/${name}.ts`,
          contentSha256: hashCanonical("test-workspace-extension.v1", { name }),
        }
      : {
          sourceKind: "builtin" as const,
          package: "@fixture/pi-runtime",
          repository: "later-3/pi",
          revision: "1".repeat(40),
          resourcePath: `pi/packages/coding-agent/src/core/tools/${name}.ts`,
        };
  const capabilityId = projectBootstrap
    ? "pi_direct:tool:managed_extension:project_bootstrap:project_bootstrap_prepare"
    : options.workspaceExtension
      ? `pi_direct:tool:workspace_extension:test:${name}`
      : `pi_direct:tool:builtin:${name}`;
  const descriptorInput = {
    schemaVersion: "capability-descriptor.v1" as const,
    capabilityId,
    kind: projectBootstrap ? ("host_action" as const) : ("executable_tool" as const),
    runtimeOwner: "pi_direct" as const,
    localName: name,
    sourceRef,
    inputSchemaSha256: hashCanonical("test-tool-schema.v1", { name }),
    effect,
    scopePolicy: projectBootstrap ? ("provider_defined" as const) : ("workspace_required" as const),
    approvalPolicy:
      effect === "read" || projectBootstrap
        ? ("run_policy" as const)
        : ("product_decision_required" as const),
    evidencePolicy:
      effect === "read" || projectBootstrap
        ? ("runtime_journal" as const)
        : ("product_intent_result" as const),
    readiness: "available" as const,
  };
  const descriptorSha256 = hashCanonical("capability-descriptor.v1", descriptorInput);
  return {
    name,
    description: `${name} tool`,
    parametersJson: "{}",
    sourceRelativePath: sourceRef.resourcePath,
    capability: { ...descriptorInput, descriptorSha256 },
    ...(projectBootstrap || options.workspaceRootId !== undefined
      ? {
          resolvedRef: {
            capabilityId,
            descriptorSha256,
            inputSchemaSha256: descriptorInput.inputSchemaSha256,
            resolvedImplementationSha256: hashCanonical("test-tool-implementation.v1", sourceRef),
            scopeRef: projectBootstrap
              ? ({ kind: "provider", providerRef: "project_bootstrap:plane_ce" } as const)
              : ({ kind: "workspace", rootId: options.workspaceRootId! } as const),
          },
        }
      : {}),
  };
}
