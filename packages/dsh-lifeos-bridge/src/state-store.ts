import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import {
  approvalRequestIdSchema,
  commandIdSchema,
  messageIdSchema,
  noteCandidateIdSchema,
  planIdSchema,
  promptReviewRequestIdSchema,
  productRunIdSchema,
  productSessionIdSchema,
  sha256Schema,
  workspaceInstructionsInputSchema,
} from "@chat/contracts/public";
import { z } from "zod";
import {
  decisionRequestSchema,
  dshMessageIdSchema,
  dshSessionIdSchema,
  noteDecisionRequestSchema,
  promptSelectionRequestSchema,
  promptReviewDecisionRequestSchema,
  workflowSelectionSchema,
} from "./contracts.ts";

/** v1-v10的Workflow草稿还没有发送级Run Configuration。 */
const legacyWorkflowSelectionSchema = z
  .object({
    workflowDefinitionRevisionId: workflowSelectionSchema.shape.workflowDefinitionRevisionId,
    definitionSha256: workflowSelectionSchema.shape.definitionSha256,
    title: workflowSelectionSchema.shape.title,
    blueprintKey: workflowSelectionSchema.shape.blueprintKey,
  })
  .strict();

const pendingDecisionSchema = z
  .object({
    bodySha256: sha256Schema,
    commandId: commandIdSchema.transform(String),
    productRunId: productRunIdSchema.transform(String),
    expectedRunRevision: z.number().int().positive(),
    approvalRequestId: approvalRequestIdSchema.transform(String),
    planId: planIdSchema.transform(String),
    planRevision: z.number().int().positive(),
    planSha256: sha256Schema,
    request: decisionRequestSchema,
  })
  .strict();

const pendingNoteDecisionSchema = z
  .object({
    bodySha256: sha256Schema,
    commandId: commandIdSchema.transform(String),
    productRunId: productRunIdSchema.transform(String),
    expectedRunRevision: z.number().int().positive(),
    noteCandidateId: noteCandidateIdSchema.transform(String),
    candidateRevision: z.number().int().positive(),
    candidateSha256: sha256Schema,
    request: noteDecisionRequestSchema,
  })
  .strict();

const pendingPromptReviewDecisionSchema = z
  .object({
    bodySha256: sha256Schema,
    commandId: commandIdSchema.transform(String),
    productRunId: productRunIdSchema.transform(String),
    expectedRunRevision: z.number().int().positive(),
    promptReviewRequestId: promptReviewRequestIdSchema.transform(String),
    requestRevision: z.number().int().positive(),
    reviewSha256: sha256Schema,
    payloadSha256: sha256Schema,
    request: promptReviewDecisionRequestSchema,
  })
  .strict();

const requestSchema = z
  .object({
    /** 触发本请求的DSH user/message身份；旧v1/v2记录迁移后可能暂时缺失。 */
    dshMessageId: dshMessageIdSchema.optional(),
    userTextSha256: sha256Schema,
    messageCommandId: commandIdSchema.transform(String),
    /** Chat正式User Message；只保存身份，用于双源记录关联，不复制正文。 */
    productUserMessageId: messageIdSchema.transform(String).optional(),
    productRunId: productRunIdSchema.transform(String).optional(),
    /** Chat正式Assistant Message；Run终态读取后补记，旧记录可按Run Query恢复。 */
    productAssistantMessageId: messageIdSchema.transform(String).optional(),
    /** @deprecated v3-v11的lifeos_trace显示cursor；仅为无损读取旧状态保留。 */
    traceCursor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    pendingDecision: pendingDecisionSchema.optional(),
    pendingNoteDecision: pendingNoteDecisionSchema.optional(),
    pendingPromptReviewDecision: pendingPromptReviewDecisionSchema.optional(),
    /**
     * 请求创建时冻结的Workflow选择快照。发送中途修改会话草稿不影响
     * 已创建请求；同一请求的幂等重放始终携带同一选择。
     */
    workflowSelection: workflowSelectionSchema.optional(),
    /** 请求创建时冻结的Prompt选择；所有Workflow都透明提交给Chat重新编译。 */
    promptSelection: promptSelectionRequestSchema.shape.promptSelection.optional(),
    /** @deprecated v5-v11旧请求的DSH指令旁路；只为无损迁移保留，新请求不再写入。 */
    workspaceInstructions: workspaceInstructionsInputSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const pendingCount = [
      value.pendingDecision,
      value.pendingNoteDecision,
      value.pendingPromptReviewDecision,
    ].filter((entry) => entry !== undefined).length;
    if (pendingCount > 1) {
      ctx.addIssue({
        code: "custom",
        path: ["pendingPromptReviewDecision"],
        message: "同一请求不能同时等待多个产品决定",
      });
    }
  });

const sessionBindingSchema = z
  .object({
    createSessionCommandId: commandIdSchema.transform(String),
    chatSessionId: productSessionIdSchema.transform(String).optional(),
    currentRequestKey: z.string().min(1).max(256).optional(),
    requests: z.record(z.string().min(1).max(256), requestSchema),
    /** 会话级Workflow选择草稿；undefined表示使用系统默认规划工作流。 */
    workflowSelection: workflowSelectionSchema.optional(),
    /** 会话级Prompt选择草稿；Workspace rootId已经由Host解析并校验。 */
    promptSelection: promptSelectionRequestSchema.shape.promptSelection.optional(),
    /** DSH完成本轮组装后、Bridge提交Chat命令前是否等待用户审核。 */
    dshSendReviewEnabled: z.boolean(),
    /** Bridge已经冻结Chat Command后、第一次Chat写入前是否等待用户审核。 */
    bridgeDispatchReviewEnabled: z.boolean(),
  })
  .strict();

const projectBootstrapLifecycleSchema = z
  .object({
    schemaVersion: z.literal("chat-dsh-project-bootstrap-lifecycle.v1"),
    lifecycleId: z.string().regex(/^pbl_[a-f0-9]{32}$/u),
    status: z.enum(["active", "ready", "rejected", "failed_terminal"]),
    bootstrapWorkflowSelection: workflowSelectionSchema,
    /**
     * 专用能力结束后恢复的普通会话选择。null明确表示系统默认；它在入口初始化时
     * 冻结，不能用之后变化的用户偏好反推。
     */
    returnWorkflowSelection: workflowSelectionSchema.nullable(),
  })
  .strict();

/** v13把“当前会话草稿”和“以后新会话偏好”改成不可混淆的持久字段。 */
const legacyV13SessionBindingSchema = sessionBindingSchema
  .omit({ workflowSelection: true })
  .extend({
    sessionWorkflowSelection: workflowSelectionSchema.optional(),
    projectBootstrapLifecycle: projectBootstrapLifecycleSchema.optional(),
  })
  .strict();

/** v14只冻结了HTTP提交目标；strict旧格式不能静默接受v15状态字段。 */
const legacyV14RequestSchema = requestSchema.safeExtend({
  /** 请求首次创建时冻结的Product Message目标；响应未知重试不得随Session映射漂移。 */
  submissionTarget: z.enum(["first_message", "existing_session"]),
});

const legacyV14SessionBindingSchema = legacyV13SessionBindingSchema
  .omit({ requests: true })
  .extend({
    requests: z.record(z.string().min(1).max(256), legacyV14RequestSchema),
  })
  .strict();

const currentRequestSchema = legacyV14RequestSchema
  .safeExtend({
    /**
     * Bridge对Product Message写边界的耐久认识。prepared尚未越过HTTP写边界；
     * outcome_unknown只能用原Command恢复；bound已经绑定Product Run；
     * definitely_uncommitted已由本地拒绝或确定性4xx证明没有提交。
     */
    submissionStatus: z.enum(["prepared", "outcome_unknown", "bound", "definitely_uncommitted"]),
  })
  .superRefine((value, ctx) => {
    if (value.submissionStatus === "bound" && value.productRunId === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["productRunId"],
        message: "bound Request必须携带Product Run身份",
      });
    }
    if (value.submissionStatus !== "bound" && value.productRunId !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["submissionStatus"],
        message: "只有bound Request允许携带Product Run身份",
      });
    }
  });

const currentSessionBindingSchema = legacyV13SessionBindingSchema
  .omit({ requests: true })
  .extend({
    requests: z.record(z.string().min(1).max(256), currentRequestSchema),
  })
  .strict();

const {
  promptSelection: legacyPromptSelection,
  workflowSelection: currentRequestWorkflowSelection,
  ...legacyRequestShape
} = requestSchema.shape;
// 解构只用于从v1-v8旧状态合同中移除v9新增字段；显式读取避免Lint把它误判为遗漏。
void legacyPromptSelection;
void currentRequestWorkflowSelection;
const legacyRequestSchema = z
  .object(legacyRequestShape)
  .extend({ workflowSelection: legacyWorkflowSelectionSchema.optional() })
  .strict();
const legacySessionBindingSchema = sessionBindingSchema
  .omit({
    requests: true,
    workflowSelection: true,
    promptSelection: true,
    dshSendReviewEnabled: true,
    bridgeDispatchReviewEnabled: true,
  })
  .extend({
    requests: z.record(z.string().min(1).max(256), legacyRequestSchema),
    workflowSelection: legacyWorkflowSelectionSchema.optional(),
  })
  .strict();

const legacyV9RequestSchema = z
  .object({
    ...requestSchema.shape,
    workflowSelection: legacyWorkflowSelectionSchema.optional(),
  })
  .strict();
const legacyV9SessionBindingSchema = sessionBindingSchema
  .omit({
    requests: true,
    workflowSelection: true,
    dshSendReviewEnabled: true,
    bridgeDispatchReviewEnabled: true,
  })
  .extend({
    requests: z.record(z.string().min(1).max(256), legacyV9RequestSchema),
    workflowSelection: legacyWorkflowSelectionSchema.optional(),
  })
  .strict();
const legacyV10SessionBindingSchema = sessionBindingSchema
  .omit({ requests: true, workflowSelection: true, bridgeDispatchReviewEnabled: true })
  .extend({
    requests: z.record(z.string().min(1).max(256), legacyV9RequestSchema),
    workflowSelection: legacyWorkflowSelectionSchema.optional(),
  })
  .strict();

/**
 * 两条已发布开发线都曾使用v11：main的v11增加Run Configuration，Prompt纵向的
 * v11增加Bridge Dispatch审核。这里同时接收二者，随后统一迁移到不含歧义的v12。
 */
const legacyV11SessionBindingSchema = sessionBindingSchema.extend({
  bridgeDispatchReviewEnabled: z.boolean().optional(),
});

/**
 * rc.6切换后已经存在的Bridge状态。除可恢复的外部身份外，v6只增加提交结果未知期间
 * 的有界Workspace指令重试正文；迁移读取接受v1-v8，随后立即改写为当前版本，不能在
 * 旧schema标记下静默扩展strict格式。
 */
const legacyBridgeStateBeforePreferenceSchema = z
  .object({
    schemaVersion: z.enum([
      "chat-dsh-lifeos-state.v1",
      "chat-dsh-lifeos-state.v2",
      "chat-dsh-lifeos-state.v3",
      "chat-dsh-lifeos-state.v4",
      "chat-dsh-lifeos-state.v5",
      "chat-dsh-lifeos-state.v6",
      "chat-dsh-lifeos-state.v7",
    ]),
    sessions: z.record(dshSessionIdSchema, legacySessionBindingSchema),
  })
  .strict();

/**
 * v8已经把最近一次Workflow选择提升成了顶层偏好，v9增加Prompt选择，v10增加
 * DSH发送审核开关；两条开发线曾分别用v11增加Run Configuration和Bridge Dispatch
 * 审核，v12把二者收敛为唯一当前格式。迁移必须精确保留旧字段，不能靠删除旧状态启动。
 */
const legacyBridgeStateWithPreferenceSchema = z
  .object({
    schemaVersion: z.literal("chat-dsh-lifeos-state.v8"),
    preferredWorkflowSelection: legacyWorkflowSelectionSchema.nullable(),
    sessions: z.record(dshSessionIdSchema, legacySessionBindingSchema),
  })
  .strict();

const legacyBridgeStateV9Schema = z
  .object({
    schemaVersion: z.literal("chat-dsh-lifeos-state.v9"),
    preferredWorkflowSelection: legacyWorkflowSelectionSchema.nullable(),
    sessions: z.record(dshSessionIdSchema, legacyV9SessionBindingSchema),
  })
  .strict();

const legacyBridgeStateV10Schema = z
  .object({
    schemaVersion: z.literal("chat-dsh-lifeos-state.v10"),
    preferredWorkflowSelection: legacyWorkflowSelectionSchema.nullable(),
    sessions: z.record(dshSessionIdSchema, legacyV10SessionBindingSchema),
  })
  .strict();

const legacyBridgeStateV11Schema = z
  .object({
    schemaVersion: z.literal("chat-dsh-lifeos-state.v11"),
    preferredWorkflowSelection: workflowSelectionSchema.nullable(),
    sessions: z.record(dshSessionIdSchema, legacyV11SessionBindingSchema),
  })
  .strict();

const legacyBridgeStateV12Schema = z
  .object({
    schemaVersion: z.literal("chat-dsh-lifeos-state.v12"),
    preferredWorkflowSelection: workflowSelectionSchema.nullable(),
    sessions: z.record(dshSessionIdSchema, sessionBindingSchema),
  })
  .strict();

const legacyBridgeStateV13Schema = z
  .object({
    schemaVersion: z.literal("chat-dsh-lifeos-state.v13"),
    newSessionWorkflowPreference: workflowSelectionSchema.nullable(),
    sessions: z.record(dshSessionIdSchema, legacyV13SessionBindingSchema),
  })
  .strict();

const legacyBridgeStateV14Schema = z
  .object({
    schemaVersion: z.literal("chat-dsh-lifeos-state.v14"),
    newSessionWorkflowPreference: workflowSelectionSchema.nullable(),
    sessions: z.record(dshSessionIdSchema, legacyV14SessionBindingSchema),
  })
  .strict();

const legacyBridgeStateSchema = z.union([
  legacyBridgeStateBeforePreferenceSchema,
  legacyBridgeStateWithPreferenceSchema,
  legacyBridgeStateV9Schema,
  legacyBridgeStateV10Schema,
  legacyBridgeStateV11Schema,
  legacyBridgeStateV12Schema,
  legacyBridgeStateV13Schema,
  legacyBridgeStateV14Schema,
]);

const bridgeStateSchema = z
  .object({
    schemaVersion: z.literal("chat-dsh-lifeos-state.v15"),
    /** 新DSH会话继承的用户级Workflow选择；null表示系统默认规划工作流。 */
    newSessionWorkflowPreference: workflowSelectionSchema.nullable(),
    sessions: z.record(dshSessionIdSchema, currentSessionBindingSchema),
  })
  .strict();

export type BridgeState = z.infer<typeof bridgeStateSchema>;
export type SessionBinding = z.infer<typeof currentSessionBindingSchema>;
export type RequestBinding = z.infer<typeof currentRequestSchema>;
export type PendingDecision = z.infer<typeof pendingDecisionSchema>;
export type PendingNoteDecision = z.infer<typeof pendingNoteDecisionSchema>;
export type PendingPromptReviewDecision = z.infer<typeof pendingPromptReviewDecisionSchema>;

const emptyState = (): BridgeState => ({
  schemaVersion: "chat-dsh-lifeos-state.v15",
  newSessionWorkflowPreference: null,
  sessions: {},
});

function bootstrapLifecycleId(dshSessionId: string): string {
  return `pbl_${createHash("sha256")
    .update(`chat-dsh-bootstrap-lifecycle.v1\u0000${dshSessionId}`)
    .digest("hex")
    .slice(0, 32)}`;
}

export function isProjectBootstrapWorkflowSelection(
  selection: z.infer<typeof workflowSelectionSchema> | undefined,
): boolean {
  return (
    selection?.runConfiguration.overrides.some(
      (override) =>
        override.kind === "node_config" &&
        override.field === "capabilityMode" &&
        override.value === "project_bootstrap",
    ) === true
  );
}

/** 旧Bridge无法证明bootstrap选择来自专用入口；迁移时只剥离该高影响能力。 */
function withoutProjectBootstrapCapability(
  selection: z.infer<typeof workflowSelectionSchema> | undefined,
): z.infer<typeof workflowSelectionSchema> | undefined {
  if (selection === undefined || !isProjectBootstrapWorkflowSelection(selection)) return selection;
  return workflowSelectionSchema.parse({
    ...selection,
    runConfiguration: {
      ...selection.runConfiguration,
      overrides: selection.runConfiguration.overrides.filter(
        (override) =>
          !(
            override.kind === "node_config" &&
            override.field === "capabilityMode" &&
            override.value === "project_bootstrap"
          ),
      ),
    },
  });
}

/**
 * v15同时持久化每条Request的提交状态。所有v1-v14旧记录只按productRunId这一条
 * 可证明事实迁移：存在即bound，不存在即outcome_unknown；不能用Session、对象顺序、
 * currentRequestKey或lifecycle猜测是否已经跨过Product HTTP写边界。
 *
 * v14已经持久化每条Request最初使用的Message路由。更旧复合历史无法只凭Bridge
 * State逐条证明首轮身份：已有Session一律选择既有Session目标；若它其实是新架构的
 * 首轮半绑定，Product Receipt必然已经随Session原子提交，Application会同时校验两种
 * 旧Hash域并恢复。若没有Receipt，它只能按已有Session安全创建，不会制造第二Session。
 */
function legacySubmissionStatus(request: {
  readonly productRunId?: string | undefined;
}): "bound" | "outcome_unknown" {
  return request.productRunId === undefined ? "outcome_unknown" : "bound";
}

function requestsFromPreV14(input: {
  readonly chatSessionId?: string | undefined;
  readonly requests: Readonly<Record<string, unknown>>;
}): Record<string, RequestBinding> {
  const entries = Object.entries(input.requests);
  return Object.fromEntries(
    entries.map(([requestKey, rawRequest]) => {
      const request = requestSchema.parse(rawRequest);
      const submissionTarget =
        input.chatSessionId === undefined ? "first_message" : "existing_session";
      return [
        requestKey,
        { ...request, submissionTarget, submissionStatus: legacySubmissionStatus(request) },
      ];
    }),
  );
}

function requestsFromV14(
  requests: Readonly<Record<string, unknown>>,
): Record<string, RequestBinding> {
  return Object.fromEntries(
    Object.entries(requests).map(([requestKey, rawRequest]) => {
      const request = legacyV14RequestSchema.parse(rawRequest);
      return [requestKey, { ...request, submissionStatus: legacySubmissionStatus(request) }];
    }),
  );
}

function requireRequest(binding: SessionBinding, requestKey: string): RequestBinding {
  const request = binding.requests[requestKey];
  if (request === undefined) throw new Error("lifeos bridge request does not exist");
  return request;
}

function completeBootstrapLifecycleInBinding(
  binding: SessionBinding,
  status: "ready" | "rejected" | "failed_terminal",
): boolean {
  const lifecycle = binding.projectBootstrapLifecycle;
  if (lifecycle === undefined || lifecycle.status !== "active") return false;
  lifecycle.status = status;
  if (lifecycle.returnWorkflowSelection === null) {
    delete binding.sessionWorkflowSelection;
  } else {
    binding.sessionWorkflowSelection = lifecycle.returnWorkflowSelection;
  }
  return true;
}

/**
 * Bridge-local identity projection. It不保存Chat Message/Plan正文；唯一临时正文是
 * Product Run确认前的Workspace指令重试快照。它不决定产品状态，Chat Product Store
 * 仍拥有所有权威事实。
 */
export class AtomicBridgeStateStore {
  private state: BridgeState | undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor(readonly path: string) {}

  async ready(): Promise<void> {
    await this.serial(async () => {
      await this.load();
    });
  }

  async readSession(dshSessionId: string): Promise<SessionBinding | undefined> {
    dshSessionIdSchema.parse(dshSessionId);
    return await this.serial(async () => {
      const state = await this.load();
      const value = Object.hasOwn(state.sessions, dshSessionId)
        ? state.sessions[dshSessionId]
        : undefined;
      return value === undefined ? undefined : structuredClone(value);
    });
  }

  /**
   * 尚未建立Bridge绑定的新DSH会话读取最近一次用户选择；已经建立的会话仍使用
   * 自己冻结的草稿，避免在另一个标签页切换Workflow时改写已有会话语义。
   */
  async readWorkflowSelection(
    dshSessionId: string,
  ): Promise<z.infer<typeof workflowSelectionSchema> | null> {
    dshSessionIdSchema.parse(dshSessionId);
    return await this.serial(async () => {
      const state = await this.load();
      const binding = Object.hasOwn(state.sessions, dshSessionId)
        ? state.sessions[dshSessionId]
        : undefined;
      return structuredClone(
        binding === undefined
          ? state.newSessionWorkflowPreference
          : (binding.sessionWorkflowSelection ?? null),
      );
    });
  }

  async readNewSessionWorkflowPreference(): Promise<z.infer<
    typeof workflowSelectionSchema
  > | null> {
    return await this.serial(async () => {
      const state = await this.load();
      return structuredClone(state.newSessionWorkflowPreference);
    });
  }

  async readPromptSelection(
    dshSessionId: string,
  ): Promise<z.infer<typeof promptSelectionRequestSchema>["promptSelection"] | undefined> {
    dshSessionIdSchema.parse(dshSessionId);
    return await this.serial(async () => {
      const state = await this.load();
      const binding = Object.hasOwn(state.sessions, dshSessionId)
        ? state.sessions[dshSessionId]
        : undefined;
      return binding?.promptSelection === undefined
        ? undefined
        : structuredClone(binding.promptSelection);
    });
  }

  async readDshSendReviewEnabled(dshSessionId: string): Promise<boolean> {
    dshSessionIdSchema.parse(dshSessionId);
    return await this.serial(async () => {
      const state = await this.load();
      const binding = Object.hasOwn(state.sessions, dshSessionId)
        ? state.sessions[dshSessionId]
        : undefined;
      return binding?.dshSendReviewEnabled ?? false;
    });
  }

  async readBridgeDispatchReviewEnabled(dshSessionId: string): Promise<boolean> {
    dshSessionIdSchema.parse(dshSessionId);
    return await this.serial(async () => {
      const state = await this.load();
      const binding = Object.hasOwn(state.sessions, dshSessionId)
        ? state.sessions[dshSessionId]
        : undefined;
      return binding?.bridgeDispatchReviewEnabled ?? false;
    });
  }

  async mutateSession<T>(
    dshSessionId: string,
    createSessionCommandId: string,
    mutate: (binding: SessionBinding) => T,
  ): Promise<T> {
    dshSessionIdSchema.parse(dshSessionId);
    return await this.serial(async () => {
      const current = await this.load();
      const next = structuredClone(current);
      const binding = this.getOrCreateSessionBinding(next, dshSessionId, createSessionCommandId);
      const result = mutate(binding);
      bridgeStateSchema.parse(next);
      await this.writeAtomic(next);
      this.state = next;
      return result;
    });
  }

  /**
   * 唯一的Product写前标记。prepared先原子变成outcome_unknown，再允许HTTP调用；
   * 若进程在标记后、调用前退出，恢复也只能用原Command，宁可保守未知也不双写。
   */
  async markRequestOutcomeUnknown(
    dshSessionId: string,
    createSessionCommandId: string,
    requestKey: string,
  ): Promise<void> {
    await this.mutateSession(dshSessionId, createSessionCommandId, (binding) => {
      const request = requireRequest(binding, requestKey);
      if (request.submissionStatus === "outcome_unknown") return;
      if (request.submissionStatus !== "prepared") {
        throw new Error(`lifeos bridge cannot dispatch request from ${request.submissionStatus}`);
      }
      request.submissionStatus = "outcome_unknown";
    });
  }

  /**
   * 只有HTTP前本地审核拒绝，或HTTP返回白名单确定性4xx，才能证明没有Product提交。
   * 对bootstrap 4xx可在同一次原子写中消费lifecycle，避免两个本地事实之间崩溃。
   */
  async markRequestDefinitelyUncommitted(
    dshSessionId: string,
    createSessionCommandId: string,
    requestKey: string,
    options: {
      readonly reason: "local_review_rejected" | "product_definitely_uncommitted";
      readonly failProjectBootstrapLifecycle?: boolean;
    },
  ): Promise<void> {
    await this.mutateSession(dshSessionId, createSessionCommandId, (binding) => {
      const request = requireRequest(binding, requestKey);
      if (request.submissionStatus === "bound") {
        throw new Error("lifeos bridge cannot unbind a committed Product request");
      }
      if (
        options.reason === "local_review_rejected" &&
        request.submissionStatus !== "prepared" &&
        request.submissionStatus !== "definitely_uncommitted"
      ) {
        throw new Error("response-unknown request cannot be cleared by a later local rejection");
      }
      request.submissionStatus = "definitely_uncommitted";
      if (options.failProjectBootstrapLifecycle === true) {
        completeBootstrapLifecycleInBinding(binding, "failed_terminal");
      }
    });
  }

  /**
   * 显式更新当前会话、以后新会话或两者。scope是写命令的一部分，调用方不能再
   * 通过一次隐藏副作用同时改变两种语义。
   */
  async selectWorkflow(
    dshSessionId: string,
    createSessionCommandId: string,
    selection: z.infer<typeof workflowSelectionSchema> | null,
    scope: "session" | "new_sessions" | "session_and_new_sessions" = "session",
  ): Promise<void> {
    dshSessionIdSchema.parse(dshSessionId);
    if (selection !== null && isProjectBootstrapWorkflowSelection(selection)) {
      throw new Error("project_bootstrap workflow selection requires the dedicated lifecycle");
    }
    await this.serial(async () => {
      const current = await this.load();
      const next = structuredClone(current);
      if (scope === "session" || scope === "session_and_new_sessions") {
        const binding = this.getOrCreateSessionBinding(next, dshSessionId, createSessionCommandId);
        if (binding.projectBootstrapLifecycle?.status === "active") {
          throw new Error("lifeos project bootstrap workflow is frozen until lifecycle exit");
        }
        if (selection === null) {
          delete binding.sessionWorkflowSelection;
        } else {
          binding.sessionWorkflowSelection = selection;
        }
      }
      if (scope === "new_sessions" || scope === "session_and_new_sessions") {
        next.newSessionWorkflowPreference = selection;
      }
      bridgeStateSchema.parse(next);
      await this.writeAtomic(next);
      this.state = next;
    });
  }

  /** 专属入口只配置目标会话，不污染普通“新会话”的偏好Workflow。 */
  async selectWorkflowForSession(
    dshSessionId: string,
    createSessionCommandId: string,
    selection: z.infer<typeof workflowSelectionSchema>,
  ): Promise<void> {
    dshSessionIdSchema.parse(dshSessionId);
    await this.selectWorkflow(dshSessionId, createSessionCommandId, selection, "session");
  }

  /** Prompt草稿只属于当前DSH会话，不像Workflow选择那样成为新会话偏好。 */
  async selectPrompt(
    dshSessionId: string,
    createSessionCommandId: string,
    selection: z.infer<typeof promptSelectionRequestSchema>["promptSelection"],
  ): Promise<void> {
    dshSessionIdSchema.parse(dshSessionId);
    await this.mutateSession(dshSessionId, createSessionCommandId, (binding) => {
      binding.promptSelection = selection;
    });
  }

  /** 专用入口一次性冻结bootstrap选择、返回选择和Prompt，避免多次写入间的半状态。 */
  async initializeProjectBootstrapSession(
    dshSessionId: string,
    createSessionCommandId: string,
    bootstrapWorkflowSelection: z.infer<typeof workflowSelectionSchema>,
    promptSelection: z.infer<typeof promptSelectionRequestSchema>["promptSelection"],
  ): Promise<void> {
    if (!isProjectBootstrapWorkflowSelection(bootstrapWorkflowSelection)) {
      throw new Error("project bootstrap lifecycle requires its dedicated workflow selection");
    }
    await this.mutateSession(dshSessionId, createSessionCommandId, (binding) => {
      const lifecycleId = bootstrapLifecycleId(dshSessionId);
      const existing = binding.projectBootstrapLifecycle;
      if (existing !== undefined) {
        if (
          existing.lifecycleId !== lifecycleId ||
          existing.status !== "active" ||
          JSON.stringify(existing.bootstrapWorkflowSelection) !==
            JSON.stringify(bootstrapWorkflowSelection)
        ) {
          throw new Error("lifeos project bootstrap lifecycle already exists with other semantics");
        }
      } else {
        binding.projectBootstrapLifecycle = {
          schemaVersion: "chat-dsh-project-bootstrap-lifecycle.v1",
          lifecycleId,
          status: "active",
          bootstrapWorkflowSelection,
          returnWorkflowSelection: binding.sessionWorkflowSelection ?? null,
        };
      }
      binding.sessionWorkflowSelection = bootstrapWorkflowSelection;
      binding.promptSelection = promptSelection;
    });
  }

  /** Product终态只消费一次专用能力；正式建项事实仍全部留在Product Store。 */
  async completeProjectBootstrapLifecycle(
    dshSessionId: string,
    createSessionCommandId: string,
    status: "ready" | "rejected" | "failed_terminal",
    preparedRequestKey?: string,
  ): Promise<void> {
    await this.mutateSession(dshSessionId, createSessionCommandId, (binding) => {
      const completed = completeBootstrapLifecycleInBinding(binding, status);
      if (!completed || preparedRequestKey === undefined) return;
      const request = requireRequest(binding, preparedRequestKey);
      if (request.submissionStatus !== "prepared") return;
      // ensureRequest可能在Product终态查询前冻结了专用选择。只有确定尚未越过HTTP
      // 边界的prepared请求，才能与lifecycle终态在同一次原子写中恢复普通选择。
      if (binding.sessionWorkflowSelection === undefined) {
        delete request.workflowSelection;
      } else {
        request.workflowSelection = structuredClone(binding.sessionWorkflowSelection);
      }
    });
  }

  async setDshSendReviewEnabled(
    dshSessionId: string,
    createSessionCommandId: string,
    enabled: boolean,
  ): Promise<void> {
    await this.mutateSession(dshSessionId, createSessionCommandId, (binding) => {
      binding.dshSendReviewEnabled = enabled;
    });
  }

  async setBridgeDispatchReviewEnabled(
    dshSessionId: string,
    createSessionCommandId: string,
    enabled: boolean,
  ): Promise<void> {
    await this.mutateSession(dshSessionId, createSessionCommandId, (binding) => {
      binding.bridgeDispatchReviewEnabled = enabled;
    });
  }

  /**
   * 所有首次会话写入共享这一原语：校验稳定身份、冻结当时的新会话偏好，并写入
   * 两个审核默认值与空requests。Prompt、Review、请求绑定和Workspace解析不得复制默认对象。
   */
  private getOrCreateSessionBinding(
    state: BridgeState,
    dshSessionId: string,
    createSessionCommandId: string,
  ): SessionBinding {
    let binding = Object.hasOwn(state.sessions, dshSessionId)
      ? state.sessions[dshSessionId]
      : undefined;
    if (binding === undefined) {
      binding = {
        createSessionCommandId,
        requests: {},
        dshSendReviewEnabled: false,
        bridgeDispatchReviewEnabled: false,
        ...(state.newSessionWorkflowPreference === null
          ? {}
          : { sessionWorkflowSelection: state.newSessionWorkflowPreference }),
      };
      state.sessions[dshSessionId] = binding;
    }
    if (binding.createSessionCommandId !== createSessionCommandId) {
      throw new Error(`lifeos bridge state command identity mismatch for session ${dshSessionId}`);
    }
    return binding;
  }

  private async serial<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  }

  private async load(): Promise<BridgeState> {
    if (this.state !== undefined) return this.state;
    let source: string;
    try {
      source = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.state = emptyState();
        return this.state;
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(source) as unknown;
    } catch (error) {
      throw new Error(`lifeos bridge state is not valid JSON: ${this.path}`, { cause: error });
    }
    const current = bridgeStateSchema.safeParse(parsed);
    if (current.success) {
      this.state = current.data;
      return this.state;
    }
    const legacy = legacyBridgeStateSchema.safeParse(parsed);
    if (!legacy.success) {
      this.state = bridgeStateSchema.parse(parsed);
      return this.state;
    }
    const migrated =
      legacy.data.schemaVersion === "chat-dsh-lifeos-state.v14"
        ? bridgeStateSchema.parse({
            schemaVersion: "chat-dsh-lifeos-state.v15",
            newSessionWorkflowPreference: legacy.data.newSessionWorkflowPreference,
            sessions: Object.fromEntries(
              Object.entries(legacy.data.sessions).map(([sessionId, binding]) => [
                sessionId,
                {
                  ...binding,
                  requests: requestsFromV14(binding.requests),
                },
              ]),
            ),
          })
        : legacy.data.schemaVersion === "chat-dsh-lifeos-state.v13"
          ? bridgeStateSchema.parse({
              schemaVersion: "chat-dsh-lifeos-state.v15",
              newSessionWorkflowPreference: legacy.data.newSessionWorkflowPreference,
              sessions: Object.fromEntries(
                Object.entries(legacy.data.sessions).map(([sessionId, binding]) => [
                  sessionId,
                  {
                    ...binding,
                    requests: requestsFromPreV14(binding),
                  },
                ]),
              ),
            })
          : bridgeStateSchema.parse({
              schemaVersion: "chat-dsh-lifeos-state.v15",
              newSessionWorkflowPreference: (() => {
                const preference =
                  legacy.data.schemaVersion === "chat-dsh-lifeos-state.v8" ||
                  legacy.data.schemaVersion === "chat-dsh-lifeos-state.v9" ||
                  legacy.data.schemaVersion === "chat-dsh-lifeos-state.v10" ||
                  legacy.data.schemaVersion === "chat-dsh-lifeos-state.v11" ||
                  legacy.data.schemaVersion === "chat-dsh-lifeos-state.v12"
                    ? legacy.data.preferredWorkflowSelection
                    : null;
                if (preference === null) return null;
                return (
                  withoutProjectBootstrapCapability(workflowSelectionSchema.parse(preference)) ??
                  null
                );
              })(),
              sessions: Object.fromEntries(
                Object.entries(legacy.data.sessions).map(([sessionId, binding]) => {
                  const { workflowSelection, ...bindingWithoutWorkflow } = binding;
                  const legacyWorkflowSelection =
                    workflowSelection === undefined
                      ? undefined
                      : workflowSelectionSchema.parse(workflowSelection);
                  const normalizedWorkflowSelection =
                    withoutProjectBootstrapCapability(legacyWorkflowSelection);
                  return [
                    sessionId,
                    {
                      ...bindingWithoutWorkflow,
                      // 冻结Request可能已经越过Product Command边界，只是响应在rememberRun前丢失。
                      // 迁移只增加本地路由目标，不改Product payload；普通新提交仍由Application
                      // 的专用授权门拒绝。
                      requests: requestsFromPreV14(binding),
                      dshSendReviewEnabled:
                        "dshSendReviewEnabled" in binding ? binding.dshSendReviewEnabled : false,
                      bridgeDispatchReviewEnabled:
                        "bridgeDispatchReviewEnabled" in binding &&
                        binding.bridgeDispatchReviewEnabled !== undefined
                          ? binding.bridgeDispatchReviewEnabled
                          : false,
                      ...(normalizedWorkflowSelection === undefined
                        ? {}
                        : { sessionWorkflowSelection: normalizedWorkflowSelection }),
                    },
                  ];
                }),
              ),
            });
    await this.writeAtomic(migrated);
    this.state = migrated;
    return this.state;
  }

  private async writeAtomic(next: BridgeState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp-${process.pid}-${randomUUID()}`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(next, undefined, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.path);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}
