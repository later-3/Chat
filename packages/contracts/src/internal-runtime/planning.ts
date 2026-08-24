/**
 * 内部Runtime合同 planning 族。对外经../internal-runtime.js barrel。
 */
import { z } from "zod";
import {
  commandIdSchema,
  messageIdSchema,
  planIdSchema,
  principalIdSchema,
  productRunIdSchema,
  runAttemptIdSchema,
  contextPackageIdSchema,
  contextRequestIdSchema,
  memoryBackendIdSchema,
  memoryQueryIdSchema,
  memoryResultSnapshotIdSchema,
  productSessionIdSchema,
  workflowRunSpecIdSchema,
  projectIdSchema,
  ruleIdSchema,
  ruleRevisionIdSchema,
  workflowMemoryQueryIdSchema,
  workflowMemorySnapshotIdSchema,
  directAgentCandidateIdSchema,
  memoryAgentWriteCandidateIdSchema,
  memoryAgentOperationIdSchema,
} from "../ids.js";
import { planContentSchema } from "../product.js";
import { sha256Schema } from "../hash.js";
import {
  memoryBackendDescriptorSchema,
  memoryLayerSchema,
  memoryRequirementSchema,
  workspaceInstructionsSnapshotSchema,
} from "../context.js";
import { workflowExecutionPathSegmentSchema } from "../workflow-run.js";
import { planningProjectSnapshotSchema } from "../planning-project-context.js";
import { ruleSelectionSourceSchema } from "../rules.js";
import {
  memoryProviderDescriptorSchema,
  workflowMemoryCategorySchema,
} from "../workflow-memory.js";
import {
  dispatchingMemoryAgentOperationSchema,
  failedMemoryAgentOperationSchema,
  memoryAgentEvidenceRefSchema,
  memoryAgentOperationResultSchema,
  memoryAgentOperationSchema,
  memoryWriteAgentProposalSchema,
  outcomeUnknownMemoryAgentOperationSchema,
  succeededMemoryAgentOperationSchema,
} from "../memory-agent.js";
import {
  versioned,
  internalContextPackageRefSchema,
  internalPlanningProjectContextRefSchema,
  internalPlanningMemorySelectionRefSchema,
  internalWorkspaceInstructionsRefSchema,
  internalRuleSelectionRefSchema,
  internalWorkflowMemoryContextRefSchema,
  workflowNodePromptRuntimeSchema,
} from "./shared.js";

export const compilePlanningInputRequestSchema = z
  .object({
    ...versioned,
    commandId: commandIdSchema,
    productRunId: productRunIdSchema,
    planRevision: z.number().int().positive(),
    contextPackageRef: internalContextPackageRefSchema.optional(),
    planningMemorySelectionRef: internalPlanningMemorySelectionRefSchema.optional(),
    workflowMemoryContextRef: internalWorkflowMemoryContextRefSchema.optional(),
    planningProjectContextRef: internalPlanningProjectContextRefSchema.optional(),
    ruleSelectionRef: internalRuleSelectionRefSchema.optional(),
  })
  .strict();

/** 版本证据：Prompt模板与模型配置版本随Planning Input下发并进入Trace。 */
export const planningInputDtoSchema = z
  .object({
    ...versioned,
    productRunId: productRunIdSchema,
    attemptId: runAttemptIdSchema,
    inputRunRevision: z.number().int().positive(),
    inputManifestSha256: sha256Schema,
    sourceMessageRef: z.object({ messageId: messageIdSchema, sha256: sha256Schema }).strict(),
    sourceMessageText: z.string().min(1),
    nodePrompt: workflowNodePromptRuntimeSchema.optional(),
    workspaceInstructions: z
      .object({
        ref: internalWorkspaceInstructionsRefSchema,
        snapshot: workspaceInstructionsSnapshotSchema,
      })
      .strict()
      .optional(),
    priorPlan: z
      .object({
        planId: planIdSchema,
        planRevision: z.number().int().positive(),
        sha256: sha256Schema,
        content: planContentSchema,
      })
      .strict()
      .optional(),
    revisionInstruction: z.string().min(1).optional(),
    memorySelection: z
      .object({
        ref: internalPlanningMemorySelectionRefSchema,
        items: z
          .array(
            z
              .object({
                refId: memoryResultSnapshotIdSchema,
                revision: z.literal(1),
                sha256: sha256Schema,
                title: z.string().min(1).max(200),
                kind: z.enum(["trace", "span", "policy", "world_model", "skill"]),
                memoryLayer: z.enum(["L1", "L2", "L3", "Skill"]),
                content: z.string().min(1).max(50_000),
                tags: z.array(z.string().min(1).max(64)).max(50),
              })
              .strict(),
          )
          .min(1)
          .max(20),
      })
      .strict()
      .optional(),
    workflowMemory: z
      .object({
        ref: internalWorkflowMemoryContextRefSchema,
        items: z
          .array(
            z
              .object({
                refId: workflowMemorySnapshotIdSchema,
                revision: z.literal(1),
                sha256: sha256Schema,
                providerId: memoryBackendIdSchema,
                title: z.string().min(1).max(200),
                category: workflowMemoryCategorySchema,
                content: z.string().min(1).max(50_000),
                labels: z.array(z.string().min(1).max(64)).max(50),
              })
              .strict(),
          )
          .max(100),
        optionalFailures: z
          .array(
            z
              .object({
                providerId: memoryBackendIdSchema,
                errorCode: z.string().min(1).max(96),
              })
              .strict(),
          )
          .max(16),
        totalContentCharacters: z.number().int().nonnegative().max(200_000),
      })
      .strict()
      .optional(),
    contextPackage: z
      .object({
        ref: z
          .object({
            contextPackageId: contextPackageIdSchema,
            revision: z.number().int().positive(),
            sha256: sha256Schema,
          })
          .strict(),
        memory: z
          .object({
            backendId: z.string().min(1).max(100),
            items: z
              .array(
                z
                  .object({
                    refId: z.string().min(1).max(120),
                    revision: z.number().int().positive(),
                    sha256: sha256Schema,
                    title: z.string().min(1).max(200),
                    kind: z.enum(["trace", "span", "policy", "world_model", "skill"]),
                    memoryLayer: z.enum(["L1", "L2", "L3", "Skill"]),
                    content: z.string().min(1).max(50_000),
                    tags: z.array(z.string().min(1).max(64)).max(50),
                  })
                  .strict(),
              )
              .max(20),
            exclusions: z
              .array(
                z
                  .object({
                    backendId: z.string().min(1).max(100),
                    reasonCode: z.string().min(1).max(64),
                  })
                  .strict(),
              )
              .max(20),
          })
          .strict(),
      })
      .strict()
      .optional(),
    projectContext: z
      .object({
        ref: internalPlanningProjectContextRefSchema,
        projectId: projectIdSchema,
        projectRevision: z.number().int().positive(),
        projectSha256: sha256Schema,
        snapshot: planningProjectSnapshotSchema,
      })
      .strict()
      .optional(),
    rulesContext: z
      .object({
        ref: internalRuleSelectionRefSchema,
        rules: z
          .array(
            z
              .object({
                ruleId: ruleIdSchema,
                ruleRevisionId: ruleRevisionIdSchema,
                revision: z.number().int().positive(),
                sha256: sha256Schema,
                body: z.string().trim().min(1).max(8_000),
                source: ruleSelectionSourceSchema,
                priority: z.number().int().min(0).max(1_000),
              })
              .strict(),
          )
          .max(100),
        totalContentCharacters: z.number().int().nonnegative().max(200_000),
      })
      .strict()
      .optional(),
    planRevision: z.number().int().positive(),
    limits: z
      .object({
        maxTurns: z.number().int().positive(),
        timeoutMs: z.number().int().positive(),
        tokenBudget: z.number().int().positive().optional(),
      })
      .strict(),
    promptTemplateVersion: z.string().min(1),
    modelConfigVersion: z.string().min(1),
  })
  .strict();

/* ---------- preparePlanningContext：intent → durable query → persist ---------- */

export const preparePlanningContextRequestSchema = z
  .object({
    ...versioned,
    commandId: commandIdSchema,
    productRunId: productRunIdSchema,
    attemptId: runAttemptIdSchema,
    planRevision: z.number().int().positive(),
  })
  .strict();

export const memoryQueryDispatchDtoSchema = z
  .object({
    memoryQueryId: memoryQueryIdSchema,
    contextRequestId: contextRequestIdSchema,
    productRunId: productRunIdSchema,
    productSessionId: productSessionIdSchema,
    backendId: memoryBackendIdSchema,
    backendDescriptor: memoryBackendDescriptorSchema,
    backendDescriptorSha256: sha256Schema,
    requirement: memoryRequirementSchema,
    sourceMessageSha256: sha256Schema,
    queryText: z.string().min(1).max(4_000),
    tags: z.array(z.string().min(1).max(64)).max(20),
    layers: z.array(memoryLayerSchema).min(1).max(4),
    limit: z.number().int().min(1).max(20),
    contextBudget: z.number().int().min(128).max(8_192),
  })
  .strict();

export const beginPlanningContextResponseSchema = z.discriminatedUnion("status", [
  z.object({ ...versioned, status: z.literal("none") }).strict(),
  z
    .object({
      ...versioned,
      status: z.literal("dispatch_required"),
      query: memoryQueryDispatchDtoSchema,
    })
    .strict(),
  z
    .object({
      ...versioned,
      status: z.enum(["ready", "optional_failed"]),
      contextPackageRef: internalContextPackageRefSchema,
    })
    .strict(),
  z.object({ ...versioned, status: z.literal("required_failed") }).strict(),
]);

export const memoryQuerySectionResultSchema = z
  .object({
    externalObjectIds: z.array(z.string().min(1).max(200)).min(1).max(50),
    title: z.string().min(1).max(200),
    kind: z.enum(["trace", "span", "policy", "world_model", "skill"]),
    memoryLayer: memoryLayerSchema,
    content: z.string().min(1).max(50_000),
    tags: z.array(z.string().min(1).max(64)).max(50),
    score: z.number().finite().optional(),
    tokenEstimate: z.number().int().nonnegative(),
    sourceUpdatedAt: z.iso.datetime().optional(),
  })
  .strict();

export const memoryQueryExecutionResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("success"),
      externalQueryId: z.string().min(1).max(200),
      hitCount: z.number().int().nonnegative(),
      tokenEstimate: z.number().int().nonnegative(),
      resultSetSha256: sha256Schema,
      sections: z.array(memoryQuerySectionResultSchema).max(20),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("failure"),
      errorCode: z
        .string()
        .regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/)
        .max(64),
    })
    .strict(),
]);

export const persistPlanningContextResultRequestSchema = z
  .object({
    ...versioned,
    commandId: commandIdSchema,
    productRunId: productRunIdSchema,
    attemptId: runAttemptIdSchema,
    memoryQueryId: memoryQueryIdSchema,
    result: memoryQueryExecutionResultSchema,
  })
  .strict();

export const preparePlanningContextResponseSchema = z.discriminatedUnion("status", [
  z.object({ ...versioned, status: z.literal("none") }).strict(),
  z
    .object({
      ...versioned,
      status: z.enum(["ready", "optional_failed"]),
      contextPackageRef: internalContextPackageRefSchema,
    })
    .strict(),
  z.object({ ...versioned, status: z.literal("required_failed") }).strict(),
]);

/* ---------- Workflow Memory：可组合query节点与聚合Context ---------- */

export const workflowMemoryNodeIdentityFields = {
  productRunId: productRunIdSchema,
  workflowRunSpecId: workflowRunSpecIdSchema,
  definitionNodeId: z.string().min(1).max(100),
  executionPath: z.array(workflowExecutionPathSegmentSchema).max(8),
  attemptNumber: z.number().int().positive().max(100),
};

export const beginWorkflowMemoryQueryRequestSchema = z
  .object({ ...versioned, commandId: commandIdSchema, ...workflowMemoryNodeIdentityFields })
  .strict();

export const workflowMemoryQueryDispatchDtoSchema = z
  .object({
    workflowMemoryQueryId: workflowMemoryQueryIdSchema,
    operationId: workflowMemoryQueryIdSchema,
    productRunId: productRunIdSchema,
    productSessionId: productSessionIdSchema,
    principalId: principalIdSchema,
    workflowRunSpecId: workflowRunSpecIdSchema,
    workflowRunSpecSha256: sha256Schema,
    definitionNodeId: z.string().min(1).max(100),
    providerId: memoryBackendIdSchema,
    providerDescriptor: memoryProviderDescriptorSchema,
    providerDescriptorSha256: sha256Schema,
    requirement: z.enum(["required", "optional"]),
    sourceMessageId: messageIdSchema,
    sourceMessageSha256: sha256Schema,
    querySha256: sha256Schema,
    queryText: z.string().min(1).max(50_000),
    maxResults: z.number().int().min(1).max(20),
    maxContextCharacters: z.number().int().min(128).max(50_000),
  })
  .strict();

export const workflowMemoryQuerySectionResultSchema = z
  .object({
    externalObjectIds: z.array(z.string().min(1).max(200)).min(1).max(50),
    title: z.string().trim().min(1).max(200),
    category: workflowMemoryCategorySchema,
    content: z.string().min(1).max(50_000),
    labels: z.array(z.string().trim().min(1).max(64)).max(50),
    score: z.number().finite().optional(),
    sourceUpdatedAt: z.iso.datetime().optional(),
  })
  .strict();

export const workflowMemoryQueryExecutionResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("success"),
      externalQueryId: z.string().min(1).max(200),
      hitCount: z.number().int().nonnegative(),
      resultSetSha256: sha256Schema,
      sections: z.array(workflowMemoryQuerySectionResultSchema).max(20),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("failure"),
      errorCode: z
        .string()
        .regex(/^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$/u)
        .max(96),
    })
    .strict(),
]);

export const workflowMemoryQueryTerminalFields = {
  workflowMemoryQueryId: workflowMemoryQueryIdSchema,
  productRunId: productRunIdSchema,
  workflowRunSpecId: workflowRunSpecIdSchema,
};

export const beginWorkflowMemoryQueryResponseSchema = z.discriminatedUnion("status", [
  z
    .object({
      ...versioned,
      ...workflowMemoryQueryTerminalFields,
      status: z.literal("dispatch_required"),
      query: workflowMemoryQueryDispatchDtoSchema,
    })
    .strict(),
  z
    .object({
      ...versioned,
      ...workflowMemoryQueryTerminalFields,
      status: z.enum(["completed", "optional_failed", "required_failed"]),
    })
    .strict(),
]);

export const persistWorkflowMemoryQueryResultRequestSchema = z
  .object({
    ...versioned,
    commandId: commandIdSchema,
    ...workflowMemoryNodeIdentityFields,
    workflowMemoryQueryId: workflowMemoryQueryIdSchema,
    result: workflowMemoryQueryExecutionResultSchema,
  })
  .strict();

export const persistWorkflowMemoryQueryResultResponseSchema = z
  .object({
    ...versioned,
    ...workflowMemoryQueryTerminalFields,
    status: z.enum(["completed", "optional_failed", "required_failed"]),
    snapshotCount: z.number().int().nonnegative().max(20),
  })
  .strict();

export const freezeWorkflowMemoryContextRequestSchema = z
  .object({
    ...versioned,
    commandId: commandIdSchema,
    productRunId: productRunIdSchema,
    workflowRunSpecId: workflowRunSpecIdSchema,
  })
  .strict();

export const freezeWorkflowMemoryContextResponseSchema = z.discriminatedUnion("status", [
  z
    .object({
      ...versioned,
      productRunId: productRunIdSchema,
      workflowRunSpecId: workflowRunSpecIdSchema,
      status: z.literal("none"),
    })
    .strict(),
  z
    .object({
      ...versioned,
      productRunId: productRunIdSchema,
      workflowRunSpecId: workflowRunSpecIdSchema,
      status: z.literal("ready"),
      contextRef: internalWorkflowMemoryContextRefSchema,
    })
    .strict(),
]);

/* ---------- Memory Agent：写入候选准备与持久化 ---------- */

export const prepareMemoryWriteAgentInputRequestSchema = z
  .object({
    ...versioned,
    productRunId: productRunIdSchema,
    workflowRunSpecId: workflowRunSpecIdSchema,
    directAgentCandidateId: directAgentCandidateIdSchema,
    candidateSha256: sha256Schema,
  })
  .strict();

export const memoryWriteAgentEvidenceInputSchema = z
  .object({
    ref: memoryAgentEvidenceRefSchema,
    label: z.string().min(1).max(200),
    role: z.enum(["user", "assistant"]),
    content: z.string().min(1).max(100_000),
  })
  .strict();

export const prepareMemoryWriteAgentInputResponseSchema = z
  .object({
    ...versioned,
    productRunId: productRunIdSchema,
    workflowRunSpecId: workflowRunSpecIdSchema,
    providerId: memoryBackendIdSchema,
    required: z.boolean(),
    maxItems: z.number().int().min(1).max(8),
    evidenceSha256: sha256Schema,
    evidence: z.array(memoryWriteAgentEvidenceInputSchema).min(1).max(51),
  })
  .strict();

export const persistMemoryWriteAgentCandidateRequestSchema = z
  .object({
    ...versioned,
    commandId: commandIdSchema,
    productRunId: productRunIdSchema,
    workflowRunSpecId: workflowRunSpecIdSchema,
    directAgentCandidateId: directAgentCandidateIdSchema,
    candidateSha256: sha256Schema,
    expectedEvidenceSha256: sha256Schema,
    memoryAgentOperationId: memoryAgentOperationIdSchema,
    operationResultSha256: sha256Schema,
    proposal: memoryWriteAgentProposalSchema,
  })
  .strict();

export const persistMemoryWriteAgentCandidateResponseSchema = z.discriminatedUnion("status", [
  z
    .object({
      ...versioned,
      productRunId: productRunIdSchema,
      status: z.literal("candidate_ready"),
      memoryAgentWriteCandidateId: memoryAgentWriteCandidateIdSchema,
      candidateSha256: sha256Schema,
    })
    .strict(),
  z
    .object({
      ...versioned,
      productRunId: productRunIdSchema,
      status: z.literal("nothing_useful"),
    })
    .strict(),
]);

/* ---------- Memory Agent：耐久模型调用操作 ---------- */

export const beginMemoryAgentOperationRequestSchema = z
  .object({
    ...versioned,
    commandId: commandIdSchema,
    productRunId: productRunIdSchema,
    workflowRunSpecId: workflowRunSpecIdSchema,
    definitionNodeId: z.string().min(1).max(128),
    operationKind: z.enum(["retrieval", "write"]),
    inputSha256: sha256Schema,
    sourceSha256: sha256Schema,
  })
  .strict();

export const beginMemoryAgentOperationResponseSchema = z.discriminatedUnion("status", [
  z
    .object({
      ...versioned,
      status: z.literal("dispatch_required"),
      operation: dispatchingMemoryAgentOperationSchema,
    })
    .strict(),
  z
    .object({
      ...versioned,
      status: z.literal("recovery_required"),
      operation: dispatchingMemoryAgentOperationSchema,
    })
    .strict(),
  z
    .object({
      ...versioned,
      status: z.literal("succeeded"),
      operation: succeededMemoryAgentOperationSchema,
    })
    .strict(),
  z
    .object({
      ...versioned,
      status: z.literal("failed"),
      operation: failedMemoryAgentOperationSchema,
    })
    .strict(),
  z
    .object({
      ...versioned,
      status: z.literal("outcome_unknown"),
      operation: outcomeUnknownMemoryAgentOperationSchema,
    })
    .strict(),
]);

export const completeMemoryAgentOperationRequestSchema = z
  .object({
    ...versioned,
    commandId: commandIdSchema,
    memoryAgentOperationId: memoryAgentOperationIdSchema,
    expectedRevision: z.literal(1),
    inputSha256: sha256Schema,
    outcome: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("succeeded"),
          result: memoryAgentOperationResultSchema,
          providerRequestCount: z.number().int().min(1).max(4),
          usage: z
            .object({
              inputTokens: z.number().int().nonnegative(),
              outputTokens: z.number().int().nonnegative(),
            })
            .strict()
            .optional(),
        })
        .strict(),
      z
        .object({
          kind: z.literal("failed"),
          errorCode: z
            .string()
            .regex(/^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/u)
            .max(96),
          providerRequestCount: z.number().int().nonnegative().max(4),
          usage: z
            .object({
              inputTokens: z.number().int().nonnegative(),
              outputTokens: z.number().int().nonnegative(),
            })
            .strict()
            .optional(),
        })
        .strict(),
    ]),
  })
  .strict();

export const markMemoryAgentOperationOutcomeUnknownRequestSchema = z
  .object({
    ...versioned,
    commandId: commandIdSchema,
    memoryAgentOperationId: memoryAgentOperationIdSchema,
    expectedRevision: z.literal(1),
    inputSha256: sha256Schema,
    errorCode: z
      .string()
      .regex(/^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/u)
      .max(96),
    providerRequestCount: z.number().int().nonnegative().max(4),
  })
  .strict();

export const memoryAgentOperationResponseSchema = z
  .object({ operation: memoryAgentOperationSchema })
  .strict();

/* ---------- publishPlanReview ---------- */
