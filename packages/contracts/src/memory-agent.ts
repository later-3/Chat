import { z } from "zod";
import { sha256Schema } from "./hash.js";
import {
  commandIdSchema,
  directAgentCandidateIdSchema,
  memoryAgentWriteCandidateIdSchema,
  memoryAgentWriteDecisionIdSchema,
  memoryAgentOperationIdSchema,
  memoryBackendIdSchema,
  memoryWriteIntentIdSchema,
  messageIdSchema,
  principalIdSchema,
  productRunIdSchema,
  productSessionIdSchema,
  workflowRunSpecIdSchema,
} from "./ids.js";
import { workflowMemoryCategorySchema } from "./workflow-memory.js";
import { definitionNodeIdSchema } from "./workflow-run.js";

const isoDateTimeSchema = z.iso.datetime();
const safeLabelSchema = z.string().trim().min(1).max(64);

export const MEMORY_RETRIEVAL_AGENT_PROMPT_VERSION = "memory-retrieval-agent.v1";
export const MEMORY_WRITE_AGENT_PROMPT_VERSION = "memory-write-agent.v1";

/**
 * Memory Agent节点合同。
 *
 * 检索Agent只提交Provider结果下标，Application/Workflow据此采用原始快照，模型不能
 * 伪造Memory正文。写入Agent可以提出整理后的正文，但它只能形成待审核候选；只有用户
 * Decision才能创建真正的Memory Write Intent。
 */
export const memoryRetrievalAgentSelectionSchema = z
  .object({
    selectedIndexes: z.array(z.number().int().nonnegative().max(99)).max(20),
  })
  .strict()
  .refine((value) => new Set(value.selectedIndexes).size === value.selectedIndexes.length, {
    message: "Memory检索候选不能重复选择同一结果",
    path: ["selectedIndexes"],
  });

export const memoryWriteAgentProposalItemSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    category: workflowMemoryCategorySchema,
    content: z.string().trim().min(1).max(10_000),
    labels: z.array(safeLabelSchema).max(12),
    /** Runtime只接受输入清单的下标，持久化前转换为Hash绑定的产品引用。 */
    evidenceIndexes: z.array(z.number().int().nonnegative().max(99)).min(1).max(12),
  })
  .strict()
  .refine((value) => new Set(value.labels).size === value.labels.length, {
    message: "Memory写入候选标签不能重复",
    path: ["labels"],
  })
  .refine((value) => new Set(value.evidenceIndexes).size === value.evidenceIndexes.length, {
    message: "Memory写入候选证据不能重复",
    path: ["evidenceIndexes"],
  });

export const memoryWriteAgentProposalSchema = z
  .object({ items: z.array(memoryWriteAgentProposalItemSchema).max(8) })
  .strict()
  .refine(
    (value) =>
      new Set(value.items.map((item) => `${item.category}\u0000${item.content.trim()}`)).size ===
      value.items.length,
    { message: "Memory写入候选不能包含重复正文", path: ["items"] },
  );

export const memoryAgentSearchSectionSchema = z
  .object({
    externalObjectIds: z.array(z.string().min(1).max(200)).min(1).max(50),
    title: z.string().trim().min(1).max(200),
    category: workflowMemoryCategorySchema,
    content: z.string().min(1).max(50_000),
    labels: z.array(safeLabelSchema).max(50),
    score: z.number().finite().optional(),
    sourceUpdatedAt: isoDateTimeSchema.optional(),
  })
  .strict();

export const memoryAgentOperationResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("retrieval"),
      externalQueryId: z.string().min(1).max(200),
      hitCount: z.number().int().nonnegative(),
      sections: z.array(memoryAgentSearchSectionSchema).max(20),
    })
    .strict(),
  z.object({ kind: z.literal("write"), proposal: memoryWriteAgentProposalSchema }).strict(),
]);

const memoryAgentOperationUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  })
  .strict();
const memoryAgentOperationErrorCodeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/u)
  .max(96);
const memoryAgentOperationBase = {
  schemaVersion: z.literal("memory-agent-operation.v1"),
  memoryAgentOperationId: memoryAgentOperationIdSchema,
  operationKind: z.enum(["retrieval", "write"]),
  productRunId: productRunIdSchema,
  workflowRunSpecId: workflowRunSpecIdSchema,
  definitionNodeId: definitionNodeIdSchema,
  inputSha256: sha256Schema,
  sourceSha256: sha256Schema,
  startedAt: isoDateTimeSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
};

export const dispatchingMemoryAgentOperationSchema = z
  .object({
    ...memoryAgentOperationBase,
    status: z.literal("dispatching"),
    providerRequestCount: z.literal(0),
    revision: z.literal(1),
  })
  .strict();

export const succeededMemoryAgentOperationSchema = z
  .object({
    ...memoryAgentOperationBase,
    status: z.literal("succeeded"),
    result: memoryAgentOperationResultSchema,
    resultSha256: sha256Schema,
    providerRequestCount: z.number().int().min(1).max(4),
    usage: memoryAgentOperationUsageSchema.optional(),
    completedAt: isoDateTimeSchema,
    revision: z.literal(2),
  })
  .strict();

export const failedMemoryAgentOperationSchema = z
  .object({
    ...memoryAgentOperationBase,
    status: z.literal("failed"),
    errorCode: memoryAgentOperationErrorCodeSchema,
    providerRequestCount: z.number().int().nonnegative().max(4),
    usage: memoryAgentOperationUsageSchema.optional(),
    completedAt: isoDateTimeSchema,
    revision: z.literal(2),
  })
  .strict();

export const outcomeUnknownMemoryAgentOperationSchema = z
  .object({
    ...memoryAgentOperationBase,
    status: z.literal("outcome_unknown"),
    errorCode: memoryAgentOperationErrorCodeSchema,
    providerRequestCount: z.number().int().nonnegative().max(4),
    completedAt: isoDateTimeSchema,
    revision: z.literal(2),
  })
  .strict();

export const memoryAgentOperationSchema = z.discriminatedUnion("status", [
  dispatchingMemoryAgentOperationSchema,
  succeededMemoryAgentOperationSchema,
  failedMemoryAgentOperationSchema,
  outcomeUnknownMemoryAgentOperationSchema,
]);

export const memoryAgentRetrieveNodeConfigSchema = z
  .object({
    providerId: memoryBackendIdSchema,
    required: z.boolean().default(true),
    maxResults: z.number().int().min(1).max(20).default(8),
    maxContextCharacters: z.number().int().min(128).max(50_000).default(8_000),
  })
  .strict();

export const memoryAgentWriteNodeConfigSchema = z
  .object({
    providerId: memoryBackendIdSchema,
    required: z.boolean().default(false),
    maxSourceMessages: z.number().int().min(2).max(50).default(20),
    maxItems: z.number().int().min(1).max(8).default(6),
    /** v1只允许人工采用；未来自动策略必须以新的冻结合同版本引入。 */
    reviewMode: z.literal("manual").default("manual"),
  })
  .strict();

export const memoryAgentEvidenceRefSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("message"),
      messageId: messageIdSchema,
      messageSha256: sha256Schema,
      role: z.enum(["user", "assistant"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("direct_agent_candidate"),
      directAgentCandidateId: directAgentCandidateIdSchema,
      candidateSha256: sha256Schema,
    })
    .strict(),
]);

export const memoryAgentWriteCandidateItemSchema = z
  .object({
    itemKey: z.string().regex(/^item-[1-8]$/u),
    title: z.string().trim().min(1).max(200),
    category: workflowMemoryCategorySchema,
    content: z.string().trim().min(1).max(10_000),
    labels: z.array(safeLabelSchema).max(12),
    evidenceRefs: z.array(memoryAgentEvidenceRefSchema).min(1).max(12),
    sha256: sha256Schema,
  })
  .strict();

const memoryAgentWriteCandidateBase = {
  schemaVersion: z.literal("memory-agent-write-candidate.v1"),
  memoryAgentWriteCandidateId: memoryAgentWriteCandidateIdSchema,
  memoryAgentOperationId: memoryAgentOperationIdSchema,
  operationResultSha256: sha256Schema,
  productRunId: productRunIdSchema,
  productSessionId: productSessionIdSchema,
  providerId: memoryBackendIdSchema,
  evidenceSha256: sha256Schema,
  evidenceManifest: z.array(memoryAgentEvidenceRefSchema).min(1).max(51),
  items: z.array(memoryAgentWriteCandidateItemSchema).min(1).max(8),
  sha256: sha256Schema,
  revision: z.number().int().positive(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
};

export const memoryAgentWriteCandidateSchema = z.discriminatedUnion("status", [
  z.object({ ...memoryAgentWriteCandidateBase, status: z.literal("pending_review") }).strict(),
  z
    .object({
      ...memoryAgentWriteCandidateBase,
      status: z.literal("approved"),
      decisionId: memoryAgentWriteDecisionIdSchema,
      memoryWriteIntentIds: z.array(memoryWriteIntentIdSchema).min(1).max(8),
    })
    .strict(),
  z
    .object({
      ...memoryAgentWriteCandidateBase,
      status: z.literal("rejected"),
      decisionId: memoryAgentWriteDecisionIdSchema,
    })
    .strict(),
]);

export const memoryAgentWriteDecisionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      schemaVersion: z.literal("memory-agent-write-decision.v1"),
      memoryAgentWriteDecisionId: memoryAgentWriteDecisionIdSchema,
      memoryAgentWriteCandidateId: memoryAgentWriteCandidateIdSchema,
      candidateRevision: z.number().int().positive(),
      candidateSha256: sha256Schema,
      kind: z.literal("approve"),
      principalId: principalIdSchema,
      commandId: commandIdSchema,
      revision: z.literal(1),
      createdAt: isoDateTimeSchema,
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal("memory-agent-write-decision.v1"),
      memoryAgentWriteDecisionId: memoryAgentWriteDecisionIdSchema,
      memoryAgentWriteCandidateId: memoryAgentWriteCandidateIdSchema,
      candidateRevision: z.number().int().positive(),
      candidateSha256: sha256Schema,
      kind: z.literal("reject"),
      reason: z.string().trim().min(1).max(2_000).optional(),
      principalId: principalIdSchema,
      commandId: commandIdSchema,
      revision: z.literal(1),
      createdAt: isoDateTimeSchema,
    })
    .strict(),
]);

export const decideMemoryAgentWriteCandidatePayloadSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("approve"),
      expectedCandidateRevision: z.number().int().positive(),
      expectedCandidateSha256: sha256Schema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("reject"),
      expectedCandidateRevision: z.number().int().positive(),
      expectedCandidateSha256: sha256Schema,
      reason: z.string().trim().min(1).max(2_000).optional(),
    })
    .strict(),
]);

export const memoryAgentWriteCandidateResponseSchema = z
  .object({ candidate: memoryAgentWriteCandidateSchema })
  .strict();

export const listMemoryAgentWriteCandidatesQuerySchema = z
  .object({
    status: z.enum(["pending_review", "approved", "rejected"]).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export const listMemoryAgentWriteCandidatesResponseSchema = z
  .object({ candidates: z.array(memoryAgentWriteCandidateSchema).max(100) })
  .strict();

export const memoryAgentWriteDecisionResponseSchema = z
  .object({
    candidate: memoryAgentWriteCandidateSchema,
    decision: memoryAgentWriteDecisionSchema,
  })
  .strict();

export type MemoryRetrievalAgentSelection = z.infer<typeof memoryRetrievalAgentSelectionSchema>;
export type MemoryWriteAgentProposal = z.infer<typeof memoryWriteAgentProposalSchema>;
export type MemoryAgentEvidenceRef = z.infer<typeof memoryAgentEvidenceRefSchema>;
export type MemoryAgentWriteCandidateItem = z.infer<typeof memoryAgentWriteCandidateItemSchema>;
export type MemoryAgentWriteCandidate = z.infer<typeof memoryAgentWriteCandidateSchema>;
export type MemoryAgentWriteDecision = z.infer<typeof memoryAgentWriteDecisionSchema>;
export type MemoryAgentOperation = z.infer<typeof memoryAgentOperationSchema>;
export type MemoryAgentOperationResult = z.infer<typeof memoryAgentOperationResultSchema>;
export type DecideMemoryAgentWriteCandidatePayload = z.infer<
  typeof decideMemoryAgentWriteCandidatePayloadSchema
>;
