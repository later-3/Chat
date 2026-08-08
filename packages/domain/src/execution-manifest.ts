import { hashCanonical } from "./canonical-hash.js";

export interface ExecutionInputManifest {
  readonly executionContractId: string;
  readonly approvedPlanSha256: string;
  readonly stepId: string;
  /** 当前Approved Step明确引用的冻结上下文；Snapshot Hash覆盖正文。 */
  readonly inputRefs: readonly {
    readonly refId: string;
    readonly revision: number;
    readonly sha256: string;
  }[];
  readonly dependencyRefs: readonly {
    readonly stepId: string;
    readonly executionAttemptId: string;
    readonly sha256: string;
  }[];
  readonly promptTemplateVersion: string;
  readonly modelConfigVersion: string;
}

/** Execution输入证据的唯一Hash实现，Workflow、Application与Store完整性检查共用。 */
export function computeExecutionInputManifestSha256(input: ExecutionInputManifest): string {
  const common = {
    executionContractId: input.executionContractId,
    approvedPlanSha256: input.approvedPlanSha256,
    stepId: input.stepId,
    dependencyRefs: input.dependencyRefs,
    promptTemplateVersion: input.promptTemplateVersion,
    modelConfigVersion: input.modelConfigVersion,
  };
  // 保留B2无上下文步骤的旧Hash；只有Memory引用时进入v2证据域。
  return input.inputRefs.length === 0
    ? hashCanonical("execution-input-manifest.v1", common)
    : hashCanonical("execution-input-manifest.v2", { ...common, inputRefs: input.inputRefs });
}
