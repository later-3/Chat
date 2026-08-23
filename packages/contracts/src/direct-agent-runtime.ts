import { z } from "zod";
import { directAgentCandidateOutputSchema } from "./direct-agent.js";
import { sha256Schema } from "./hash.js";
import {
  commandIdSchema,
  directAgentCandidateIdSchema,
  memoryBackendIdSchema,
  messageIdSchema,
  productRunIdSchema,
  promptReviewDecisionIdSchema,
  promptReviewRequestIdSchema,
  promptAssemblyIdSchema,
  runAttemptIdSchema,
  workflowMemoryContextIdSchema,
  workflowMemorySnapshotIdSchema,
  workflowRunSpecIdSchema,
} from "./ids.js";
import { workflowMemoryCategorySchema } from "./workflow-memory.js";
import {
  promptReviewCanonicalPayloadJsonSchema,
  promptReviewDecisionKindSchema,
  promptReviewEndpointHostSchema,
  promptReviewModelIdSchema,
  promptReviewProviderIdSchema,
  promptReviewRequestKindSchema,
  promptReviewRequestStatusSchema,
} from "./prompt-review.js";
import {
  DIRECT_AGENT_ACTIVE_TIMEOUT_MS,
  DIRECT_AGENT_MAX_PROVIDER_REQUESTS,
  DIRECT_AGENT_TOKEN_BUDGET,
} from "./versions.js";
import { promptWorkspaceRootIdSchema } from "./prompt-fragment.js";
import {
  promptAssemblyBudgetSchema,
  promptEnvelopeMessageSchema,
  promptEnvelopeRequestOptionsSchema,
  promptEnvelopeToolsSchema,
  piSystemPromptResolutionSchema,
} from "./prompt-assembly.js";
import {
  planeCeWorkspaceSlugSchema,
  projectBootstrapCandidateSchema,
  projectBootstrapProposalSchema,
} from "./project-bootstrap.js";

/**
 * Direct Agent私有Runtime合同。它只挂在loopback Runtime Router，不进入public导出：
 * Workflow与Pi只能携带产品ID、revision和Hash，不能自行构造审核决定或绕过一次性permit。
 */
export const DIRECT_AGENT_INTERNAL_RUNTIME_SCHEMA_VERSION = "chat-internal-runtime.v1";

/** 相对于`/internal/runtime/v1`的固定路径，API与Executor Client共同消费。 */
export const DIRECT_AGENT_RUNTIME_PATHS = {
  beginAttempt: "/begin-direct-agent-attempt",
  authorizeOperation: "/authorize-direct-agent-operation",
  publishPromptReview: "/publish-prompt-review",
  loadPromptReviewDecision: "/load-prompt-review-decision",
  consumePromptReviewDecision: "/consume-prompt-review-decision",
  commitPromptReviewDispatchOutcome: "/commit-prompt-review-dispatch-outcome",
  persistCandidate: "/persist-direct-agent-candidate",
  prepareProjectBootstrap: "/prepare-project-bootstrap",
  commitResult: "/commit-direct-agent-result",
} as const;

const versioned = {
  schemaVersion: z.literal(DIRECT_AGENT_INTERNAL_RUNTIME_SCHEMA_VERSION),
};

const directAgentPromptReviewRequestRefFields = {
  promptReviewRequestId: promptReviewRequestIdSchema,
  productRunId: productRunIdSchema,
  requestRevision: z.number().int().positive(),
  requestIndex: z.number().int().positive().max(DIRECT_AGENT_MAX_PROVIDER_REQUESTS),
  payloadSha256: sha256Schema,
  reviewSha256: sha256Schema,
};

/** ---------- Begin / Authorize：先落Attempt，再以冻结Manifest授权Executor ---------- */

export const beginDirectAgentAttemptRuntimeRequestSchema = z
  .object({
    ...versioned,
    commandId: commandIdSchema,
    productRunId: productRunIdSchema,
    workflowAttemptId: runAttemptIdSchema,
  })
  .strict();

export const beginDirectAgentAttemptRuntimeResponseSchema = z
  .object({
    ...versioned,
    directAgentAttemptId: runAttemptIdSchema,
    inputManifestSha256: sha256Schema,
    runRevision: z.number().int().positive(),
  })
  .strict();

export const authorizeDirectAgentOperationRuntimeRequestSchema = z
  .object({
    ...versioned,
    productRunId: productRunIdSchema,
    directAgentAttemptId: runAttemptIdSchema,
    workflowRunSpecId: workflowRunSpecIdSchema,
    workflowRunSpecSha256: sha256Schema,
    inputManifestSha256: sha256Schema,
  })
  .strict();

export const authorizeDirectAgentOperationRuntimeResponseSchema = z
  .object({
    ...versioned,
    productRunId: productRunIdSchema,
    directAgentAttemptId: runAttemptIdSchema,
    runRevision: z.number().int().positive(),
    sourceMessage: z
      .object({
        messageId: messageIdSchema,
        text: z.string().min(1).max(100_000),
        /** 与Input Manifest中同一冻结Message Hash一致。 */
        sha256: sha256Schema,
      })
      .strict(),
    promptAssembly: z.union([
      z
        .object({
          schemaVersion: z.literal("prompt-assembly.v1"),
          promptAssemblyId: promptAssemblyIdSchema,
          sha256: sha256Schema,
          systemPromptAppend: z.string().max(512_000),
          userPrompt: z.string().min(1).max(1_000_000),
          workspaceRootId: promptWorkspaceRootIdSchema.optional(),
        })
        .strict(),
      z
        .object({
          schemaVersion: z.literal("prompt-assembly.v2"),
          promptAssemblyId: promptAssemblyIdSchema,
          sha256: sha256Schema,
          systemPromptAppend: z.string().max(512_000),
          piSystemPrompt: piSystemPromptResolutionSchema.optional(),
          messages: z.array(promptEnvelopeMessageSchema).min(1).max(1_000),
          tools: promptEnvelopeToolsSchema,
          requestOptions: promptEnvelopeRequestOptionsSchema,
          budget: promptAssemblyBudgetSchema,
          workspaceRootId: promptWorkspaceRootIdSchema.optional(),
        })
        .strict(),
    ]),
    memoryContext: z
      .object({
        workflowMemoryContextId: workflowMemoryContextIdSchema,
        revision: z.literal(1),
        sha256: sha256Schema,
        items: z
          .array(
            z
              .object({
                workflowMemorySnapshotId: workflowMemorySnapshotIdSchema,
                providerId: memoryBackendIdSchema,
                title: z.string().min(1).max(200),
                category: workflowMemoryCategorySchema,
                content: z.string().min(1).max(50_000),
                labels: z.array(z.string().min(1).max(64)).max(50),
                revision: z.literal(1),
                sha256: sha256Schema,
              })
              .strict(),
          )
          .max(100),
      })
      .strict()
      .optional(),
    capabilityMode: z.enum(["pi_cli_default", "custom", "read_only", "project_bootstrap"]),
    projectBootstrapContext: z
      .object({
        providerKind: z.literal("plane_ce"),
        providerVersion: z.string().min(1).max(40),
        planeWorkspaceSlugs: z.array(planeCeWorkspaceSlugSchema).min(1).max(20),
        creationRoots: z
          .array(
            z
              .object({
                rootId: promptWorkspaceRootIdSchema,
                displayName: z.string().min(1).max(160),
              })
              .strict(),
          )
          .min(1)
          .max(20),
      })
      .strict()
      .optional(),
    promptReviewMode: z.enum(["manual", "off"]),
    limits: z
      .object({
        maxProviderRequests: z.literal(DIRECT_AGENT_MAX_PROVIDER_REQUESTS),
        activeTimeoutMs: z.literal(DIRECT_AGENT_ACTIVE_TIMEOUT_MS),
        tokenBudget: z.literal(DIRECT_AGENT_TOKEN_BUDGET),
      })
      .strict(),
  })
  .strict();

/** ---------- Project Bootstrap Tool：只准备候选，不直接创建外部资源 ---------- */

export const prepareProjectBootstrapRuntimeRequestSchema = z
  .object({
    ...versioned,
    commandId: commandIdSchema,
    productRunId: productRunIdSchema,
    proposal: projectBootstrapProposalSchema,
  })
  .strict();

export const prepareProjectBootstrapRuntimeResponseSchema = z
  .object({
    ...versioned,
    candidate: projectBootstrapCandidateSchema,
  })
  .strict();

/** ---------- Prompt Review：发布事实、消费一次性Provider dispatch permit ---------- */

export const publishPromptReviewRuntimeRequestSchema = z
  .object({
    ...versioned,
    commandId: commandIdSchema,
    productRunId: productRunIdSchema,
    directAgentAttemptId: runAttemptIdSchema,
    expectedRunRevision: z.number().int().positive(),
    requestIndex: z.number().int().positive().max(DIRECT_AGENT_MAX_PROVIDER_REQUESTS),
    requestKind: promptReviewRequestKindSchema,
    providerId: promptReviewProviderIdSchema,
    modelId: promptReviewModelIdSchema,
    endpointHost: promptReviewEndpointHostSchema,
    canonicalPayloadJson: promptReviewCanonicalPayloadJsonSchema,
    /** Executor可提交预计算Hash；Application必须独立重算并拒绝漂移。 */
    payloadSha256: sha256Schema,
  })
  .strict();

export const publishPromptReviewRuntimeResponseSchema = z
  .object({
    ...versioned,
    ...directAgentPromptReviewRequestRefFields,
    /** 幂等重放可能发生在用户已经决定之后；引用仍必须返回同一Request。 */
    status: promptReviewRequestStatusSchema,
    /** 产品实体revision；Decision仍只绑定不会随状态变化的requestRevision。 */
    revision: z.number().int().positive(),
    runRevision: z.number().int().positive(),
  })
  .strict();

export const directAgentPromptReviewDecisionRefSchema = z
  .object({
    promptReviewDecisionId: promptReviewDecisionIdSchema,
    promptReviewRequestId: promptReviewRequestIdSchema,
    productRunId: productRunIdSchema,
    requestRevision: z.number().int().positive(),
    reviewSha256: sha256Schema,
    payloadSha256: sha256Schema,
    kind: promptReviewDecisionKindSchema,
    revision: z.literal(1),
    /** 对完整Decision事实的确定性Hash；正文、Principal与Command不复制到Pi Journal。 */
    decisionSha256: sha256Schema,
  })
  .strict();

/** Workflow恢复Hook只读加载Decision引用；本路由不消费permit，也绝不返回Provider正文。 */
export const loadPromptReviewDecisionRuntimeRequestSchema = z
  .object({
    ...versioned,
    productRunId: productRunIdSchema,
    promptReviewRequestId: promptReviewRequestIdSchema,
    promptReviewDecisionId: promptReviewDecisionIdSchema,
    requestRevision: z.number().int().positive(),
    reviewSha256: sha256Schema,
    payloadSha256: sha256Schema,
  })
  .strict();

export const loadPromptReviewDecisionRuntimeResponseSchema = z
  .object({
    ...versioned,
    decision: directAgentPromptReviewDecisionRefSchema,
  })
  .strict();

/**
 * Executor恢复审核时只调用这一条路由。API先读取并校验已提交Decision；approve再原子
 * 消费dispatch permit。幂等重放只能得到`already_claimed`，不能再次取得Provider正文。
 */
export const consumePromptReviewDecisionRuntimeRequestSchema = z
  .object({
    ...versioned,
    commandId: commandIdSchema,
    productRunId: productRunIdSchema,
    directAgentAttemptId: runAttemptIdSchema,
    promptReviewRequestId: promptReviewRequestIdSchema,
    promptReviewDecisionId: promptReviewDecisionIdSchema,
    requestRevision: z.number().int().positive(),
    reviewSha256: sha256Schema,
    payloadSha256: sha256Schema,
  })
  .strict();

const consumedPromptReviewBaseFields = {
  ...versioned,
  decision: directAgentPromptReviewDecisionRefSchema,
  /** Decision提交后的权威Run CAS，供下一轮Publish直接使用。 */
  runRevision: z.number().int().positive(),
};

export const consumePromptReviewDecisionRuntimeResponseSchema = z.discriminatedUnion("status", [
  z
    .object({
      ...consumedPromptReviewBaseFields,
      status: z.literal("authorized"),
      canonicalPayloadJson: promptReviewCanonicalPayloadJsonSchema,
      payloadSha256: sha256Schema,
      reviewSha256: sha256Schema,
      requestIndex: z.number().int().positive().max(DIRECT_AGENT_MAX_PROVIDER_REQUESTS),
      requestKind: promptReviewRequestKindSchema,
      providerId: promptReviewProviderIdSchema,
      modelId: promptReviewModelIdSchema,
      endpointHost: promptReviewEndpointHostSchema,
    })
    .strict(),
  z
    .object({
      ...consumedPromptReviewBaseFields,
      status: z.literal("rejected"),
    })
    .strict(),
  z
    .object({
      ...consumedPromptReviewBaseFields,
      status: z.literal("already_claimed"),
    })
    .strict(),
]);

const stableDirectRuntimeErrorCodeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/u)
  .max(80);

export const commitPromptReviewDispatchOutcomeRuntimeRequestSchema = z.discriminatedUnion(
  "outcome",
  [
    z
      .object({
        ...versioned,
        commandId: commandIdSchema,
        productRunId: productRunIdSchema,
        directAgentAttemptId: runAttemptIdSchema,
        promptReviewRequestId: promptReviewRequestIdSchema,
        outcome: z.literal("dispatched"),
      })
      .strict(),
    z
      .object({
        ...versioned,
        commandId: commandIdSchema,
        productRunId: productRunIdSchema,
        directAgentAttemptId: runAttemptIdSchema,
        promptReviewRequestId: promptReviewRequestIdSchema,
        outcome: z.literal("outcome_unknown"),
        errorCode: stableDirectRuntimeErrorCodeSchema.optional(),
      })
      .strict(),
  ],
);

export const commitPromptReviewDispatchOutcomeRuntimeResponseSchema = z
  .object({
    ...versioned,
    promptReviewRequestId: promptReviewRequestIdSchema,
    productRunId: productRunIdSchema,
    status: z.enum(["dispatched", "outcome_unknown"]),
    revision: z.number().int().positive(),
  })
  .strict();

/** ---------- Candidate / Product Commit：模型输出与正式Message分成两个事务 ---------- */

export const persistDirectAgentCandidateRuntimeRequestSchema = z
  .object({
    ...versioned,
    commandId: commandIdSchema,
    productRunId: productRunIdSchema,
    directAgentAttemptId: runAttemptIdSchema,
    output: directAgentCandidateOutputSchema,
  })
  .strict();

export const persistDirectAgentCandidateRuntimeResponseSchema = z
  .object({
    ...versioned,
    directAgentCandidateId: directAgentCandidateIdSchema,
    productRunId: productRunIdSchema,
    sha256: sha256Schema,
  })
  .strict();

export const commitDirectAgentResultRuntimeRequestSchema = z
  .object({
    ...versioned,
    commandId: commandIdSchema,
    productRunId: productRunIdSchema,
    directAgentAttemptId: runAttemptIdSchema,
    directAgentCandidateId: directAgentCandidateIdSchema,
    candidateSha256: sha256Schema,
  })
  .strict();

export const commitDirectAgentResultRuntimeResponseSchema = z
  .object({
    ...versioned,
    directAgentCandidateId: directAgentCandidateIdSchema,
    messageId: messageIdSchema,
    productRunId: productRunIdSchema,
  })
  .strict();

export type BeginDirectAgentAttemptRuntimeRequest = z.infer<
  typeof beginDirectAgentAttemptRuntimeRequestSchema
>;
export type BeginDirectAgentAttemptRuntimeResponse = z.infer<
  typeof beginDirectAgentAttemptRuntimeResponseSchema
>;
export type AuthorizeDirectAgentOperationRuntimeRequest = z.infer<
  typeof authorizeDirectAgentOperationRuntimeRequestSchema
>;
export type AuthorizeDirectAgentOperationRuntimeResponse = z.infer<
  typeof authorizeDirectAgentOperationRuntimeResponseSchema
>;
export type PrepareProjectBootstrapRuntimeRequest = z.infer<
  typeof prepareProjectBootstrapRuntimeRequestSchema
>;
export type PrepareProjectBootstrapRuntimeResponse = z.infer<
  typeof prepareProjectBootstrapRuntimeResponseSchema
>;
export type PublishPromptReviewRuntimeRequest = z.infer<
  typeof publishPromptReviewRuntimeRequestSchema
>;
export type PublishPromptReviewRuntimeResponse = z.infer<
  typeof publishPromptReviewRuntimeResponseSchema
>;
export type DirectAgentPromptReviewDecisionRef = z.infer<
  typeof directAgentPromptReviewDecisionRefSchema
>;
export type LoadPromptReviewDecisionRuntimeRequest = z.infer<
  typeof loadPromptReviewDecisionRuntimeRequestSchema
>;
export type LoadPromptReviewDecisionRuntimeResponse = z.infer<
  typeof loadPromptReviewDecisionRuntimeResponseSchema
>;
export type ConsumePromptReviewDecisionRuntimeRequest = z.infer<
  typeof consumePromptReviewDecisionRuntimeRequestSchema
>;
export type ConsumePromptReviewDecisionRuntimeResponse = z.infer<
  typeof consumePromptReviewDecisionRuntimeResponseSchema
>;
export type CommitPromptReviewDispatchOutcomeRuntimeRequest = z.infer<
  typeof commitPromptReviewDispatchOutcomeRuntimeRequestSchema
>;
export type CommitPromptReviewDispatchOutcomeRuntimeResponse = z.infer<
  typeof commitPromptReviewDispatchOutcomeRuntimeResponseSchema
>;
export type PersistDirectAgentCandidateRuntimeRequest = z.infer<
  typeof persistDirectAgentCandidateRuntimeRequestSchema
>;
export type PersistDirectAgentCandidateRuntimeResponse = z.infer<
  typeof persistDirectAgentCandidateRuntimeResponseSchema
>;
export type CommitDirectAgentResultRuntimeRequest = z.infer<
  typeof commitDirectAgentResultRuntimeRequestSchema
>;
export type CommitDirectAgentResultRuntimeResponse = z.infer<
  typeof commitDirectAgentResultRuntimeResponseSchema
>;
