import {
  approvalDtoSchema,
  approvalRequestIdSchema,
  decisionDtoSchema,
  workflowExecutionTraceDtoSchema,
  messageDtoSchema,
  messageResponseSchema,
  noteCandidateIdSchema,
  noteCandidateReviewDtoSchema,
  noteDecisionDtoSchema,
  promptReviewDecisionDtoSchema,
  promptReviewRequestDtoSchema,
  promptReviewRequestIdSchema,
  promptConfigurationPreviewDtoSchema,
  publicConfigFieldSchema,
  promptTurnSelectionInputSchema,
  workflowRunConfigurationSchema,
  workspaceInstructionsInputSchema,
  planIdSchema,
  planDtoSchema,
  productRunIdSchema,
  productSessionIdSchema,
  runDtoSchema,
  sessionDtoSchema,
  sha256Schema,
  workflowDefinitionRevisionIdSchema,
  executionTracePageSchema,
  cursorPageSchema,
  projectBootstrapSessionProjectionSchema,
  projectBootstrapCandidateIdSchema,
  projectBootstrapConfigurationSchema,
  type ApprovalDto,
  type DecisionDto,
  type MessageDto,
  type NoteCandidateReviewDto,
  type NoteDecisionDto,
  type PromptReviewDecisionDto,
  type PromptReviewRequestDto,
  type PromptTurnSelectionInput,
  type PlanDto,
  type RunDto,
  type SessionDto,
} from "@chat/contracts/public";
import { z } from "zod";

export const BRIDGE_SCHEMA_VERSION = "chat-dsh-lifeos-bridge.v3" as const;
export const DSH_CONTEXT_INJECTION_SCHEMA_VERSION = "chat-dsh-context-injections.v1" as const;
export const DSH_BRIDGE_SEND_PREVIEW_SCHEMA_VERSION = "chat-dsh-bridge-send-preview.v2" as const;
export const MAX_DSH_CONTEXT_INJECTION_ITEMS = 64;
export const MAX_DSH_CONTEXT_INJECTION_TEXT_CHARS = 50_000;
export const MAX_DSH_ADAPTER_REQUEST_JSON_CHARS = 4_000_000;
export const MAX_DSH_CONTEXT_SOURCE_DETAILS = 32;
export const dshSessionIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/)
  .refine((value) => !["__proto__", "prototype", "constructor"].includes(value));
export const dshMessageIdSchema = z.string().min(1).max(256);

// Aliases keep the adapter vocabulary concise while the runtime authority stays
// in @chat/contracts/public and is inlined into the deployable bridge bundle.
export const sessionSchema = sessionDtoSchema;
export const messageSchema = messageDtoSchema;
export const planSchema = planDtoSchema;
export const approvalSchema = approvalDtoSchema;
export const runSchema = runDtoSchema;
export const decisionKindSchema = decisionDtoSchema.shape.kind;

export const problemSchema = z
  .object({
    type: z.string().optional(),
    title: z.string().optional(),
    status: z.number().int().optional(),
    code: z.string().optional(),
    detail: z.string().optional(),
    requestId: z.string().optional(),
    retryable: z.boolean().optional(),
    recoveryAction: z.string().optional(),
  })
  .loose();

export const createSessionResponseSchema = z.object({ session: sessionDtoSchema }).strict();
export const submitMessageResponseSchema = z
  .object({ message: messageDtoSchema, run: runDtoSchema })
  .strict();
export const runResponseSchema = z.object({ run: runDtoSchema }).strict();
export const executionTraceResponseSchema = executionTracePageSchema;
export const plansResponseSchema = z.object({ items: z.array(planDtoSchema) }).strict();
export const approvalResponseSchema = z.object({ approval: approvalDtoSchema.nullable() }).strict();
export const exactMessageResponseSchema = messageResponseSchema;
export const messagesPageResponseSchema = cursorPageSchema(messageDtoSchema);
export const decisionResponseSchema = z
  .object({ decision: decisionDtoSchema, run: runDtoSchema })
  .strict();
export const noteCandidateResponseSchema = noteCandidateReviewDtoSchema;
export const noteDecisionResponseSchema = z
  .object({ decision: noteDecisionDtoSchema, candidate: noteCandidateReviewDtoSchema })
  .strict();
export const currentPromptReviewResponseSchema = z
  .object({ promptReview: promptReviewRequestDtoSchema.nullable() })
  .strict();
export const promptReviewDecisionResponseSchema = z
  .object({ decision: promptReviewDecisionDtoSchema, run: runDtoSchema })
  .strict();

/** Browser-to-bridge command. Product binding fields are resolved Host-side. */
export const decisionRequestSchema = z
  .object({
    kind: decisionKindSchema,
    explanation: z.string().trim().min(1).max(2_000).optional(),
    binding: z
      .object({
        productRunId: productRunIdSchema,
        runRevision: z.number().int().positive(),
        approvalRequestId: approvalRequestIdSchema,
        planId: planIdSchema,
        planRevision: z.number().int().positive(),
        planSha256: sha256Schema,
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.kind === "request_revision" && value.explanation === undefined) {
      ctx.addIssue({ code: "custom", path: ["explanation"], message: "修订请求必须填写说明" });
    }
    if (value.kind === "approve" && value.explanation !== undefined) {
      ctx.addIssue({ code: "custom", path: ["explanation"], message: "批准不接受额外说明" });
    }
  });

export type ChatSession = SessionDto;
export type ChatMessage = MessageDto;
export type ChatPlan = PlanDto;
export type ChatApproval = ApprovalDto;
export type ChatRun = RunDto;
export type ChatDecision = DecisionDto;
export type ChatNoteCandidate = NoteCandidateReviewDto;
export type ChatNoteDecision = NoteDecisionDto;
export type ChatPromptReview = PromptReviewRequestDto;
export type ChatPromptReviewDecision = PromptReviewDecisionDto;
export type DecisionKind = z.infer<typeof decisionKindSchema>;
export type DecisionRequest = z.infer<typeof decisionRequestSchema>;

/** Browser-to-bridge Note审核命令；产品身份全部绑定到浏览器刚观察到的候选版本。 */
export const noteDecisionRequestSchema = z
  .object({
    kind: z.enum(["confirm", "request_revision", "reject"]),
    explanation: z.string().trim().min(1).max(2_000).optional(),
    binding: z
      .object({
        productRunId: productRunIdSchema,
        runRevision: z.number().int().positive(),
        noteCandidateId: noteCandidateIdSchema,
        candidateRevision: z.number().int().positive(),
        candidateSha256: sha256Schema,
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.kind === "request_revision" && value.explanation === undefined) {
      ctx.addIssue({ code: "custom", path: ["explanation"], message: "修订请求必须填写说明" });
    }
    if (value.kind === "confirm" && value.explanation !== undefined) {
      ctx.addIssue({ code: "custom", path: ["explanation"], message: "确认不接受额外说明" });
    }
  });

export type NoteDecisionRequest = z.infer<typeof noteDecisionRequestSchema>;

/** Browser-to-bridge Prompt审核命令；绑定用户刚看到的完整请求版本与正文Hash。 */
export const promptReviewDecisionRequestSchema = z
  .object({
    kind: z.enum(["approve", "reject"]),
    explanation: z.string().trim().min(1).max(2_000).optional(),
    binding: z
      .object({
        productRunId: productRunIdSchema,
        runRevision: z.number().int().positive(),
        promptReviewRequestId: promptReviewRequestIdSchema,
        requestRevision: z.number().int().positive(),
        reviewSha256: sha256Schema,
        payloadSha256: sha256Schema,
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.kind === "approve" && value.explanation !== undefined) {
      ctx.addIssue({ code: "custom", path: ["explanation"], message: "批准不接受额外说明" });
    }
  });

export type PromptReviewDecisionRequest = z.infer<typeof promptReviewDecisionRequestSchema>;

/**
 * 选择表面可见的已发布Workflow投影。只暴露选择所需的字段；
 * 节点图、Executor与Runtime身份不进入浏览器。
 */
export const lifeosWorkflowOptionSchema = z
  .object({
    workflowDefinitionRevisionId: workflowDefinitionRevisionIdSchema,
    definitionSha256: sha256Schema,
    title: z.string().min(1).max(160),
    description: z.string().min(1).max(1000),
    blueprintKey: z.enum(["planning", "note", "direct"]),
    ownerKind: z.enum(["system", "principal"]),
    isDefault: z.boolean(),
    configurableNodes: z
      .array(
        z
          .object({
            definitionNodeId: z.string().min(1).max(80),
            title: z.string().min(1).max(120),
            fields: z.array(publicConfigFieldSchema).min(1).max(16),
          })
          .strict(),
      )
      .max(64)
      .default([]),
  })
  .strict();

export const workflowListResponseSchema = z
  .object({ items: z.array(lifeosWorkflowOptionSchema).max(100) })
  .strict();

/**
 * 会话级Workflow选择草稿。revisionId+definitionSha256是提交给Chat的
 * 唯一权威内容；title只是选择表面的标签缓存，服务端提交时仍会重新校验
 * published/active/所有权，草稿过期只会得到可重试的definition_stale失败。
 */
export const workflowSelectionSchema = z
  .object({
    workflowDefinitionRevisionId: workflowDefinitionRevisionIdSchema,
    definitionSha256: sha256Schema,
    title: z.string().min(1).max(160),
    /** Bridge-local发送策略；不会进入Chat WorkflowSelection产品合同。 */
    blueprintKey: z.enum(["planning", "note", "direct"]).optional(),
    /** 会话级发送草稿；Chat命令边界仍会按Definition和Blueprint重新校验。 */
    runConfiguration: workflowRunConfigurationSchema.default({
      schemaVersion: "workflow-run-configuration.v1",
      overrides: [],
    }),
  })
  .strict();

/** Browser-to-bridge command：null表示恢复系统默认规划工作流。 */
export const workflowSelectionRequestSchema = z
  .object({ workflowSelection: workflowSelectionSchema.nullable() })
  .strict();

export type LifeosWorkflowOption = z.infer<typeof lifeosWorkflowOptionSchema>;
export type WorkflowSelection = z.infer<typeof workflowSelectionSchema>;

export const PROMPT_SELECTION_SCHEMA_VERSION = "chat-dsh-prompt-selection.v1" as const;

/**
 * Browser可以修改Region选择，但Workspace身份只能由Host依据DSH Session归属解析。
 * PUT仍携带完整草稿，便于客户端做CAS式回显；Host会拒绝伪造或过期的rootId。
 */
export const promptSelectionRequestSchema = z
  .object({ promptSelection: promptTurnSelectionInputSchema })
  .strict();

export const promptSelectionProjectionSchema = z
  .object({
    schemaVersion: z.literal(PROMPT_SELECTION_SCHEMA_VERSION),
    workspace: z
      .object({
        rootId: z.string().regex(/^root_[A-Za-z0-9]+$/u),
        title: z.string().min(1).max(160),
      })
      .strict()
      .nullable(),
    promptSelection: promptTurnSelectionInputSchema,
  })
  .strict();

export type PromptSelectionRequest = z.infer<typeof promptSelectionRequestSchema>;
export type PromptSelectionProjection = z.infer<typeof promptSelectionProjectionSchema>;
export type PromptSelection = PromptTurnSelectionInput;

/**
 * 一次Product Run的公开执行轨迹及其真实DSH触发消息。消息ID只负责把外部
 * Workflow投影锚定到原生Trajectory；它不是产品身份，也不会写回DSH日志。
 */
export const lifeosExecutionTraceSchema = z
  .object({
    dshMessageId: dshMessageIdSchema,
    trace: workflowExecutionTraceDtoSchema,
  })
  .strict();

export type LifeosExecutionTrace = z.infer<typeof lifeosExecutionTraceSchema>;

export const SESSION_RECORDS_SCHEMA_VERSION = "chat-dsh-session-records.v1" as const;

/** DSH持久化Header的公开子集；cwd只用于向当前用户解释Workspace归属。 */
export const dshSessionHeaderSchema = z
  .object({
    version: z.number().int().nonnegative(),
    id: dshSessionIdSchema,
    createdAt: z.number().int().nonnegative(),
    cwd: z.string().min(1).optional(),
    parentSession: dshSessionIdSchema.optional(),
    seedLength: z.number().int().nonnegative().optional(),
    origin: z.literal("subagent").optional(),
    delegationDepth: z.number().int().nonnegative().optional(),
    agentPreset: z.string().min(1).optional(),
  })
  .strict();

/**
 * 完整DSH原始事件。只对事件数分页；data、surfaceOp和来源关系不做字符串裁剪。
 * z.json()同时阻止undefined、NaN等非JSON值跨越Browser边界。
 */
export const dshSessionEventSchema = z
  .object({
    type: z.string().min(1),
    seq: z.number().int().nonnegative(),
    time: z.number().int().nonnegative(),
    data: z.json(),
    ignorable: z.literal(true).optional(),
    surfaceOp: z.json().optional(),
    sourceEventSeqs: z.array(z.number().int().nonnegative()).optional(),
  })
  .strict();

export const sessionRecordsOverviewSchema = z
  .object({
    schemaVersion: z.literal(SESSION_RECORDS_SCHEMA_VERSION),
    dsh: z
      .object({
        header: dshSessionHeaderSchema,
        title: z.string().min(1).optional(),
        live: z.boolean(),
        persisted: z.boolean(),
        archived: z.boolean(),
        eventCount: z.number().int().nonnegative(),
        lastEventSeq: z.number().int().nonnegative().nullable(),
        lastEventAt: z.number().int().nonnegative().nullable(),
      })
      .strict(),
    chat: sessionDtoSchema.nullable(),
    binding: z
      .object({
        status: z.enum(["draft", "bound"]),
        productSessionId: productSessionIdSchema.nullable(),
        requestCount: z.number().int().nonnegative(),
        linkedUserMessageCount: z.number().int().nonnegative(),
        linkedAssistantMessageCount: z.number().int().nonnegative(),
        currentProductRunId: productRunIdSchema.nullable(),
      })
      .strict(),
    capabilities: z
      .object({
        continueConversation: z.boolean(),
        archiveKeepsData: z.literal(true),
        permanentDelete: z.literal(false),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.binding.status === "draft" && value.binding.productSessionId !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["binding", "productSessionId"],
        message: "draft binding cannot carry a Product Session",
      });
    }
    if (value.binding.status === "bound" && value.binding.productSessionId === null) {
      ctx.addIssue({
        code: "custom",
        path: ["binding", "productSessionId"],
        message: "bound binding requires a Product Session",
      });
    }
    if (value.binding.status === "draft" && value.chat !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["chat"],
        message: "draft binding cannot resolve a Product Session",
      });
    }
    if (
      value.binding.status === "bound" &&
      (value.chat === null || value.chat.sessionId !== value.binding.productSessionId)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["chat"],
        message: "bound Product Session must match the binding",
      });
    }
    if (
      value.binding.linkedUserMessageCount > value.binding.requestCount ||
      value.binding.linkedAssistantMessageCount > value.binding.requestCount
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["binding"],
        message: "linked Message counts cannot exceed request count",
      });
    }
  });

export const sessionRecordsMessageItemSchema = z
  .object({
    message: messageDtoSchema,
    link: z
      .object({
        dshMessageId: dshMessageIdSchema.optional(),
        productRunId: productRunIdSchema.optional(),
      })
      .strict(),
  })
  .strict();

export const sessionRecordsChatPageSchema = z
  .object({
    schemaVersion: z.literal(SESSION_RECORDS_SCHEMA_VERSION),
    dshSessionId: dshSessionIdSchema,
    productSessionId: productSessionIdSchema.nullable(),
    messages: cursorPageSchema(sessionRecordsMessageItemSchema),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.productSessionId === null &&
      (value.messages.items.length > 0 || value.messages.nextCursor !== undefined)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["messages"],
        message: "unbound DSH Session cannot expose Product Messages",
      });
    }
    if (
      value.productSessionId !== null &&
      value.messages.items.some((item) => item.message.sessionId !== value.productSessionId)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["messages", "items"],
        message: "Product Message belongs to another Session",
      });
    }
  });

export const sessionRecordsDshPageSchema = z
  .object({
    schemaVersion: z.literal(SESSION_RECORDS_SCHEMA_VERSION),
    dshSessionId: dshSessionIdSchema,
    header: dshSessionHeaderSchema,
    items: z.array(dshSessionEventSchema).max(100),
    hasMore: z.boolean(),
    nextAfterSeq: z.number().int().nonnegative().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.header.id !== value.dshSessionId) {
      ctx.addIssue({
        code: "custom",
        path: ["header", "id"],
        message: "DSH Session header identity mismatch",
      });
    }
    if (
      (value.hasMore && (value.nextAfterSeq === undefined || value.items.length === 0)) ||
      (!value.hasMore && value.nextAfterSeq !== undefined)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["nextAfterSeq"],
        message: "DSH pagination continuation is inconsistent",
      });
    }
    const last = value.items.at(-1);
    if (value.nextAfterSeq !== undefined && last?.seq !== value.nextAfterSeq) {
      ctx.addIssue({
        code: "custom",
        path: ["nextAfterSeq"],
        message: "DSH pagination continuation must name the last event",
      });
    }
  });

export type SessionRecordsOverview = z.infer<typeof sessionRecordsOverviewSchema>;
export type SessionRecordsMessageItem = z.infer<typeof sessionRecordsMessageItemSchema>;
export type SessionRecordsChatPage = z.infer<typeof sessionRecordsChatPageSchema>;
export type SessionRecordsDshPage = z.infer<typeof sessionRecordsDshPageSchema>;

export const publicRunSchema = runDtoSchema.pick({
  productRunId: true,
  status: true,
  phase: true,
  failure: true,
  allowedActions: true,
  revision: true,
  updatedAt: true,
});

/**
 * DSH 当前模型输入中的单条生产者上下文。这里保留模型实际看到的文本，
 * 但只投影有界、可展示的来源元数据；任意插件私有 source payload 不穿透到浏览器。
 */
export const dshContextInjectionItemSchema = z
  .object({
    messageId: z.string().min(1).max(256),
    sourceKind: z.string().min(1).max(160),
    sourceName: z.string().min(1).max(512).nullable(),
    form: z.enum(["instructions", "catalog", "snapshot", "notice", "relay", "recall"]).nullable(),
    sourceDetails: z.array(z.string().min(1).max(512)).max(MAX_DSH_CONTEXT_SOURCE_DETAILS),
    sourceDetailsTruncated: z.boolean(),
    text: z.string().max(MAX_DSH_CONTEXT_INJECTION_TEXT_CHARS),
    contentCharacters: z.number().int().nonnegative().safe(),
    truncated: z.boolean(),
    unsupportedContentBlockCount: z.number().int().nonnegative().safe(),
  })
  .strict();

/**
 * 独立按需读取合同，不并入每秒轮询的 LifeosProjection。`ready` 表示至少完成过
 * 一次 DSH pre-step 组装；ready + 空 items 是合法的“当前没有生产者上下文”。
 */
export const dshContextInjectionProjectionSchema = z
  .object({
    schemaVersion: z.literal(DSH_CONTEXT_INJECTION_SCHEMA_VERSION),
    dshSessionId: dshSessionIdSchema,
    status: z.enum(["not_assembled", "ready"]),
    revision: sha256Schema,
    chatForwarding: z.literal("latest_direct_user_message_and_workspace_instructions"),
    items: z.array(dshContextInjectionItemSchema).max(MAX_DSH_CONTEXT_INJECTION_ITEMS),
    totalItems: z.number().int().nonnegative().safe(),
    omittedItems: z.number().int().nonnegative().safe(),
    totalContentCharacters: z.number().int().nonnegative().safe(),
  })
  .strict();

export type DshContextInjectionItem = z.infer<typeof dshContextInjectionItemSchema>;
export type DshContextInjectionProjection = z.infer<typeof dshContextInjectionProjectionSchema>;

export const dshBridgeSendPreviewRequestSchema = z
  .object({ text: z.string().trim().min(1).max(4_000) })
  .strict();

const bridgeChatWorkflowSelectionSchema = z
  .object({
    kind: z.literal("published_revision"),
    workflowDefinitionRevisionId: workflowDefinitionRevisionIdSchema,
    definitionSha256: sha256Schema,
    runConfiguration: workflowRunConfigurationSchema,
  })
  .strict();

const bridgeChatSubmitPayloadSchema = z
  .object({
    text: z.string().min(1).max(4_000),
    workflowSelection: bridgeChatWorkflowSelectionSchema.optional(),
    context: z
      .object({ workspaceInstructions: workspaceInstructionsInputSchema })
      .strict()
      .optional(),
    promptSelection: promptTurnSelectionInputSchema.optional(),
  })
  .strict();

export const dshAdapterRequestCaptureSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("captured"),
      requestJson: z.string().min(2).max(MAX_DSH_ADAPTER_REQUEST_JSON_CHARS),
      requestSha256: sha256Schema,
    })
    .strict(),
  z
    .object({
      status: z.literal("not_captured"),
      reason: z.literal("native_send_not_started"),
    })
    .strict(),
]);

export type DshAdapterRequestCapture = z.infer<typeof dshAdapterRequestCaptureSchema>;

/**
 * 发送前边界投影：DSH→Bridge展示当前用户输入与DSH生产者上下文；Bridge→Chat
 * 展示按当前Workflow政策真正形成的Command payload。它不是Provider HTTP请求。
 */
export const dshBridgeSendPreviewSchema = z
  .object({
    schemaVersion: z.literal(DSH_BRIDGE_SEND_PREVIEW_SCHEMA_VERSION),
    boundary: z.literal("dsh_to_lifeos_bridge"),
    status: z.literal("pre_send_projection"),
    workspace: promptSelectionProjectionSchema.shape.workspace,
    workflowSelection: workflowSelectionSchema.nullable(),
    promptSelection: promptTurnSelectionInputSchema,
    promptConfiguration: promptConfigurationPreviewDtoSchema.nullable(),
    dshToBridge: z
      .object({
        adapterRequest: dshAdapterRequestCaptureSchema,
        userInput: z.object({ text: z.string().min(1).max(4_000), sha256: sha256Schema }).strict(),
        contextInjections: dshContextInjectionProjectionSchema,
      })
      .strict(),
    bridgeToChat: z
      .object({
        policy: z.enum(["direct_prompt_selection", "non_direct_workspace_instructions"]),
        payload: bridgeChatSubmitPayloadSchema,
        payloadJson: z.string().min(2).max(1_000_000),
        payloadSha256: sha256Schema,
      })
      .strict(),
  })
  .strict();

export type DshBridgeSendPreviewRequest = z.infer<typeof dshBridgeSendPreviewRequestSchema>;
export type DshBridgeSendPreview = z.infer<typeof dshBridgeSendPreviewSchema>;

export const dshSendReviewIdSchema = z.string().regex(/^dsr_[a-f0-9]{32}$/u);
export const dshSendReviewSchema = z
  .object({
    schemaVersion: z.literal("chat-dsh-send-review.v1"),
    reviewId: dshSendReviewIdSchema,
    status: z.literal("open"),
    preview: dshBridgeSendPreviewSchema,
  })
  .strict();

export const dshSendReviewSettingRequestSchema = z.object({ enabled: z.boolean() }).strict();
export const dshSendReviewDecisionRequestSchema = z
  .object({
    reviewId: dshSendReviewIdSchema,
    kind: z.enum(["approve", "reject"]),
  })
  .strict();

export type DshSendReview = z.infer<typeof dshSendReviewSchema>;
export type DshSendReviewDecisionRequest = z.infer<typeof dshSendReviewDecisionRequestSchema>;

export const projectBootstrapDecisionRequestSchema = z
  .object({
    kind: z.enum(["confirm", "reject", "retry"]),
    explanation: z.string().trim().min(1).max(1_000).optional(),
    binding: z
      .object({
        projectBootstrapCandidateId: projectBootstrapCandidateIdSchema,
        candidateRevision: z.number().int().positive(),
        candidateSha256: sha256Schema,
      })
      .strict(),
  })
  .strict();

export type ProjectBootstrapDecisionRequest = z.infer<typeof projectBootstrapDecisionRequestSchema>;

export const projectBootstrapPresetSchema = z.discriminatedUnion("enabled", [
  z.object({ enabled: z.literal(false) }).strict(),
  z
    .object({
      enabled: z.literal(true),
      configuration: projectBootstrapConfigurationSchema,
      workflowSelection: workflowSelectionSchema,
      promptSelection: promptTurnSelectionInputSchema,
    })
    .strict(),
]);

export type ProjectBootstrapPreset = z.infer<typeof projectBootstrapPresetSchema>;

/** Same-origin Client read model；不暴露Workflow/pi的运行时私有身份。 */
export const lifeosProjectionSchema = z
  .object({
    schemaVersion: z.literal(BRIDGE_SCHEMA_VERSION),
    dshSessionId: dshSessionIdSchema,
    run: publicRunSchema.nullable(),
    plan: planDtoSchema.nullable(),
    approval: approvalDtoSchema.nullable(),
    pendingDecision: decisionRequestSchema.nullable(),
    noteCandidate: noteCandidateReviewDtoSchema.nullable(),
    pendingNoteDecision: noteDecisionRequestSchema.nullable(),
    promptReview: promptReviewRequestDtoSchema.nullable().default(null),
    pendingPromptReviewDecision: promptReviewDecisionRequestSchema.nullable().default(null),
    dshSendReviewEnabled: z.boolean().default(false),
    dshSendReview: dshSendReviewSchema.nullable().default(null),
    projectBootstrap: projectBootstrapSessionProjectionSchema.nullable().default(null),
    projectBootstrapTargets: z
      .object({
        workspaceCwd: z.string().min(1).max(2_000).optional(),
        planeUrl: z.url().optional(),
      })
      .strict()
      .nullable()
      .default(null),
    workflowSelection: workflowSelectionSchema.nullable(),
    executionTraces: z.array(lifeosExecutionTraceSchema).max(100),
  })
  .strict();

export type LifeosProjection = z.infer<typeof lifeosProjectionSchema>;
