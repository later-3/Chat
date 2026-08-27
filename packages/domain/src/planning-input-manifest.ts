import { hashCanonical } from "./canonical-hash.js";

export interface PlanningInputManifestRef {
  readonly id: string;
  readonly revision: number;
  readonly sha256: string;
}

export interface PlanningInputManifestInput {
  readonly productRunId: string;
  readonly planRevision: number;
  readonly sourceMessageRef: {
    readonly messageId: string;
    readonly sha256: string;
  };
  readonly priorPlanRef?: {
    readonly planRevisionId: string;
    readonly planId: string;
    readonly planRevision: number;
    readonly sha256: string;
  };
  readonly revisionInputRef?: { readonly revisionInputId: string };
  readonly workspaceInstructionsRef?: {
    readonly contextRequestId: string;
    readonly revision: 1;
    readonly sha256: string;
  };
  readonly contextPackageRef?: {
    readonly contextPackageId: string;
    readonly revision: number;
    readonly sha256: string;
  };
  readonly planningMemorySelectionRef?: {
    readonly planningMemorySelectionId: string;
    readonly revision: number;
    readonly sha256: string;
  };
  readonly workflowMemoryContextRef?: {
    readonly workflowMemoryContextId: string;
    readonly revision: number;
    readonly sha256: string;
  };
  readonly ruleSelectionRef?: {
    readonly ruleSelectionId: string;
    readonly revision: number;
    readonly sha256: string;
  };
  readonly promptAssemblyRef?: {
    readonly promptAssemblyId: string;
    readonly sha256: string;
    readonly definitionNodeId: string;
    readonly nodeAssemblySha256: string;
  };
  readonly promptTemplateVersion: string;
  readonly modelConfigVersion: string;
}

/**
 * Planning Input Manifest是模型调用的完整版本证据，不含任何正文。
 * v1仅Message/Plan，v2加入查询Memory，v3加入Rules，v4加入显式Memory选择，
 * v5加入Workflow Memory，v6加入Workspace指令，v7绑定节点Prompt Assembly；
 * 旧Attempt继续按原Hash域验证。
 */
export function computePlanningInputManifestSha256(input: PlanningInputManifestInput): string {
  const hasVersion3Context = input.ruleSelectionRef !== undefined;
  const hashDomain =
    input.promptAssemblyRef !== undefined
      ? "planning-input-manifest.v7"
      : input.workspaceInstructionsRef !== undefined
        ? "planning-input-manifest.v6"
        : input.workflowMemoryContextRef !== undefined
          ? "planning-input-manifest.v5"
          : input.planningMemorySelectionRef !== undefined
            ? "planning-input-manifest.v4"
            : hasVersion3Context
              ? "planning-input-manifest.v3"
              : input.contextPackageRef === undefined
                ? "planning-input-manifest.v1"
                : "planning-input-manifest.v2";
  return hashCanonical(hashDomain, {
    productRunId: input.productRunId,
    planRevision: input.planRevision,
    sourceMessageRef: input.sourceMessageRef,
    ...(input.priorPlanRef !== undefined ? { priorPlanRef: input.priorPlanRef } : {}),
    ...(input.revisionInputRef !== undefined ? { revisionInputRef: input.revisionInputRef } : {}),
    ...(input.workspaceInstructionsRef !== undefined
      ? { workspaceInstructionsRef: input.workspaceInstructionsRef }
      : {}),
    ...(input.contextPackageRef !== undefined
      ? { contextPackageRef: input.contextPackageRef }
      : {}),
    ...(input.planningMemorySelectionRef !== undefined
      ? { planningMemorySelectionRef: input.planningMemorySelectionRef }
      : {}),
    ...(input.workflowMemoryContextRef !== undefined
      ? { workflowMemoryContextRef: input.workflowMemoryContextRef }
      : {}),
    ...(input.ruleSelectionRef !== undefined ? { ruleSelectionRef: input.ruleSelectionRef } : {}),
    ...(input.promptAssemblyRef !== undefined
      ? { promptAssemblyRef: input.promptAssemblyRef }
      : {}),
    promptTemplateVersion: input.promptTemplateVersion,
    modelConfigVersion: input.modelConfigVersion,
  });
}
