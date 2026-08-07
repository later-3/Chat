import { hashCanonical } from "./canonical-hash.js";

export interface ExecutionInputManifest {
  readonly executionContractId: string;
  readonly approvedPlanSha256: string;
  readonly stepId: string;
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
  return hashCanonical("execution-input-manifest.v1", input);
}
