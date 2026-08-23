import { hashCanonical } from "./canonical-hash.js";

export interface MemoryAgentEvidenceRefShape {
  readonly kind: "message" | "direct_agent_candidate";
  readonly messageId?: string | undefined;
  readonly messageSha256?: string | undefined;
  readonly role?: "user" | "assistant" | undefined;
  readonly directAgentCandidateId?: string | undefined;
  readonly candidateSha256?: string | undefined;
}

export interface MemoryAgentWriteCandidateItemShape {
  readonly itemKey: string;
  readonly title: string;
  readonly category: "episode" | "fact" | "preference" | "procedure" | "skill" | "other";
  readonly content: string;
  readonly labels: readonly string[];
  readonly evidenceRefs: readonly MemoryAgentEvidenceRefShape[];
  readonly sha256: string;
}

export interface MemoryAgentWriteCandidateShape {
  readonly memoryAgentWriteCandidateId: string;
  readonly memoryAgentOperationId: string;
  readonly operationResultSha256: string;
  readonly productRunId: string;
  readonly productSessionId: string;
  readonly providerId: string;
  readonly evidenceSha256: string;
  readonly evidenceManifest: readonly MemoryAgentEvidenceRefShape[];
  readonly items: readonly MemoryAgentWriteCandidateItemShape[];
  readonly sha256: string;
}

export function deriveMemoryAgentOperationId(input: {
  readonly productRunId: string;
  readonly definitionNodeId: string;
  readonly operationKind: "retrieval" | "write";
}): string {
  return `mao_${hashCanonical("id.memory-agent-operation.v1", {
    productRunId: input.productRunId,
    definitionNodeId: input.definitionNodeId,
    operationKind: input.operationKind,
  }).slice(0, 32)}`;
}

export function deriveMemoryAgentWriteCandidateId(productRunId: string): string {
  return `mwc_${hashCanonical("id.memory-agent-write-candidate.v1", { productRunId }).slice(0, 32)}`;
}

export function computeMemoryAgentWriteCandidateItemSha256(
  input: Omit<MemoryAgentWriteCandidateItemShape, "sha256">,
): string {
  return hashCanonical("memory-agent-write-candidate-item.v1", input);
}

export function computeMemoryAgentWriteCandidateSha256(input: {
  readonly memoryAgentWriteCandidateId: string;
  readonly memoryAgentOperationId: string;
  readonly operationResultSha256: string;
  readonly productRunId: string;
  readonly productSessionId: string;
  readonly providerId: string;
  readonly evidenceSha256: string;
  readonly evidenceManifest: readonly MemoryAgentEvidenceRefShape[];
  readonly items: readonly MemoryAgentWriteCandidateItemShape[];
}): string {
  return hashCanonical("memory-agent-write-candidate.v1", input);
}

export function assertMemoryAgentWriteCandidateIntegrity(
  candidate: MemoryAgentWriteCandidateShape,
): void {
  for (const item of candidate.items) {
    const { sha256, ...content } = item;
    if (computeMemoryAgentWriteCandidateItemSha256(content) !== sha256) {
      throw new Error("memory_agent.write_candidate.item_hash_mismatch");
    }
  }
  if (
    computeMemoryAgentWriteCandidateSha256({
      memoryAgentWriteCandidateId: candidate.memoryAgentWriteCandidateId,
      memoryAgentOperationId: candidate.memoryAgentOperationId,
      operationResultSha256: candidate.operationResultSha256,
      productRunId: candidate.productRunId,
      productSessionId: candidate.productSessionId,
      providerId: candidate.providerId,
      evidenceSha256: candidate.evidenceSha256,
      evidenceManifest: candidate.evidenceManifest,
      items: candidate.items,
    }) !== candidate.sha256
  ) {
    throw new Error("memory_agent.write_candidate.hash_mismatch");
  }
}

export function computeMemoryWriteAgentEvidenceSha256(input: {
  readonly productRunId: string;
  readonly workflowRunSpecId: string;
  readonly directAgentCandidateId: string;
  readonly candidateSha256: string;
  readonly evidence: readonly {
    readonly ref: MemoryAgentEvidenceRefShape;
    readonly label: string;
    readonly role: "user" | "assistant";
    readonly content: string;
  }[];
}): string {
  return hashCanonical("memory-write-agent-evidence.v1", input);
}

export function computeMemoryAgentEvidenceManifestSha256(
  evidenceManifest: readonly MemoryAgentEvidenceRefShape[],
): string {
  return hashCanonical("memory-agent-evidence-manifest.v1", evidenceManifest);
}

export function computeMemoryAgentOperationInputSha256(input: {
  readonly operationKind: "retrieval" | "write";
  readonly productRunId: string;
  readonly workflowRunSpecId: string;
  readonly definitionNodeId: string;
  readonly sourceSha256: string;
}): string {
  return hashCanonical("memory-agent-operation-input.v1", input);
}

export function computeMemoryRetrievalAgentSourceSha256(input: {
  readonly workflowMemoryQueryId: string;
  readonly workflowRunSpecSha256: string;
  readonly sourceMessageSha256: string;
  readonly querySha256: string;
  readonly providerDescriptorSha256: string;
  readonly requirement: "required" | "optional";
  readonly maxResults: number;
  readonly maxContextCharacters: number;
}): string {
  return hashCanonical("memory-retrieval-agent-source.v1", input);
}

export function computeMemoryAgentOperationResultSha256(input: unknown): string {
  return hashCanonical("memory-agent-operation-result.v1", input);
}

/** Provider只接收一个确定性、可独立理解的文本；候选结构仍由Product Store拥有。 */
export function renderMemoryAgentWriteCandidateItem(
  item: Pick<MemoryAgentWriteCandidateItemShape, "title" | "category" | "labels" | "content">,
): string {
  return [
    `标题：${item.title}`,
    `类型：${item.category}`,
    `标签：${item.labels.join("、") || "无"}`,
    "内容：",
    item.content,
  ].join("\n");
}
