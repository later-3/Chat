import { hashCanonical } from "./canonical-hash.js";

export function computeDirectAgentCandidateSha256(input: {
  readonly directAgentCandidateId: string;
  readonly productRunId: string;
  readonly directAgentAttemptId: string;
  readonly output: { readonly format: "markdown"; readonly text: string };
}): string {
  return hashCanonical("direct-agent-candidate.v1", input);
}

/**
 * Direct Agent授权只绑定Product Run、冻结RunSpec、源Message、只读能力与部署预算，
 * 不伪造Plan/Execution Contract。审核模式已经包含在冻结RunSpec Hash里，不在这里重复
 * 编码；Application与Store必须共同调用本函数，避免“能写入、不能重开”的漂移。
 */
export function computeDirectAgentInputManifestSha256(input: {
  readonly productRunId: string;
  readonly inputRunRevision: number;
  readonly workflowRunSpecId: string;
  readonly workflowRunSpecSha256: string;
  readonly sourceMessageId: string;
  readonly sourceMessageSha256: string;
  readonly promptAssemblySha256: string;
  readonly capabilityMode: "read_only";
  readonly promptTemplateVersion: string;
  readonly modelConfigVersion: string;
  readonly limits: {
    readonly maxProviderRequests: number;
    readonly activeTimeoutMs: number;
    readonly tokenBudget: number;
  };
}): string {
  return hashCanonical("direct-agent-input-manifest.v1", input);
}
