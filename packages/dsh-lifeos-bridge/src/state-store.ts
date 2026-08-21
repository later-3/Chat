import { randomUUID } from "node:crypto";
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
    /** 已经投影进DSH原生Trajectory的Run内Trace位置；只用于显示幂等。 */
    traceCursor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    pendingDecision: pendingDecisionSchema.optional(),
    pendingNoteDecision: pendingNoteDecisionSchema.optional(),
    pendingPromptReviewDecision: pendingPromptReviewDecisionSchema.optional(),
    /**
     * 请求创建时冻结的Workflow选择快照。发送中途修改会话草稿不影响
     * 已创建请求；同一请求的幂等重放始终携带同一选择。
     */
    workflowSelection: workflowSelectionSchema.optional(),
    /** 请求创建时冻结的Prompt选择；仅Direct Workflow会把它提交给Chat。 */
    promptSelection: promptSelectionRequestSchema.shape.promptSelection.optional(),
    /** Chat确认Product Run前保留的有界重试快照；确认后立即删除。 */
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

const legacyBridgeStateSchema = z.union([
  legacyBridgeStateBeforePreferenceSchema,
  legacyBridgeStateWithPreferenceSchema,
  legacyBridgeStateV9Schema,
  legacyBridgeStateV10Schema,
  legacyBridgeStateV11Schema,
]);

const bridgeStateSchema = z
  .object({
    schemaVersion: z.literal("chat-dsh-lifeos-state.v12"),
    /** 新DSH会话继承的用户级Workflow选择；null表示系统默认规划工作流。 */
    preferredWorkflowSelection: workflowSelectionSchema.nullable(),
    sessions: z.record(dshSessionIdSchema, sessionBindingSchema),
  })
  .strict();

export type BridgeState = z.infer<typeof bridgeStateSchema>;
export type SessionBinding = z.infer<typeof sessionBindingSchema>;
export type RequestBinding = z.infer<typeof requestSchema>;
export type PendingDecision = z.infer<typeof pendingDecisionSchema>;
export type PendingNoteDecision = z.infer<typeof pendingNoteDecisionSchema>;
export type PendingPromptReviewDecision = z.infer<typeof pendingPromptReviewDecisionSchema>;

const emptyState = (): BridgeState => ({
  schemaVersion: "chat-dsh-lifeos-state.v12",
  preferredWorkflowSelection: null,
  sessions: {},
});

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
          ? state.preferredWorkflowSelection
          : (binding.workflowSelection ?? null),
      );
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
      let binding = Object.hasOwn(next.sessions, dshSessionId)
        ? next.sessions[dshSessionId]
        : undefined;
      if (binding === undefined) {
        binding = {
          createSessionCommandId,
          requests: {},
          dshSendReviewEnabled: false,
          bridgeDispatchReviewEnabled: false,
          ...(next.preferredWorkflowSelection === null
            ? {}
            : { workflowSelection: next.preferredWorkflowSelection }),
        };
        next.sessions[dshSessionId] = binding;
      }
      if (binding.createSessionCommandId !== createSessionCommandId) {
        throw new Error(
          `lifeos bridge state command identity mismatch for session ${dshSessionId}`,
        );
      }
      const result = mutate(binding);
      bridgeStateSchema.parse(next);
      await this.writeAtomic(next);
      this.state = next;
      return result;
    });
  }

  /** 原子更新当前会话草稿与后续新会话默认值，避免二者在进程崩溃时分叉。 */
  async selectWorkflow(
    dshSessionId: string,
    createSessionCommandId: string,
    selection: z.infer<typeof workflowSelectionSchema> | null,
  ): Promise<void> {
    dshSessionIdSchema.parse(dshSessionId);
    await this.serial(async () => {
      const current = await this.load();
      const next = structuredClone(current);
      let binding = Object.hasOwn(next.sessions, dshSessionId)
        ? next.sessions[dshSessionId]
        : undefined;
      if (binding === undefined) {
        binding = {
          createSessionCommandId,
          requests: {},
          dshSendReviewEnabled: false,
          bridgeDispatchReviewEnabled: false,
        };
        next.sessions[dshSessionId] = binding;
      }
      if (binding.createSessionCommandId !== createSessionCommandId) {
        throw new Error(
          `lifeos bridge state command identity mismatch for session ${dshSessionId}`,
        );
      }
      if (selection === null) {
        delete binding.workflowSelection;
      } else {
        binding.workflowSelection = selection;
      }
      next.preferredWorkflowSelection = selection;
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
    await this.mutateSession(dshSessionId, createSessionCommandId, (binding) => {
      binding.workflowSelection = selection;
    });
  }

  /** Prompt草稿只属于当前DSH会话，不像Workflow选择那样成为新会话偏好。 */
  async selectPrompt(
    dshSessionId: string,
    createSessionCommandId: string,
    selection: z.infer<typeof promptSelectionRequestSchema>["promptSelection"],
  ): Promise<void> {
    dshSessionIdSchema.parse(dshSessionId);
    await this.serial(async () => {
      const current = await this.load();
      const next = structuredClone(current);
      let binding = Object.hasOwn(next.sessions, dshSessionId)
        ? next.sessions[dshSessionId]
        : undefined;
      if (binding === undefined) {
        binding = {
          createSessionCommandId,
          requests: {},
          dshSendReviewEnabled: false,
          bridgeDispatchReviewEnabled: false,
        };
        next.sessions[dshSessionId] = binding;
      }
      if (binding.createSessionCommandId !== createSessionCommandId) {
        throw new Error(
          `lifeos bridge state command identity mismatch for session ${dshSessionId}`,
        );
      }
      binding.promptSelection = selection;
      bridgeStateSchema.parse(next);
      await this.writeAtomic(next);
      this.state = next;
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
    const migrated = bridgeStateSchema.parse({
      schemaVersion: "chat-dsh-lifeos-state.v12",
      preferredWorkflowSelection:
        legacy.data.schemaVersion === "chat-dsh-lifeos-state.v8" ||
        legacy.data.schemaVersion === "chat-dsh-lifeos-state.v9" ||
        legacy.data.schemaVersion === "chat-dsh-lifeos-state.v10" ||
        legacy.data.schemaVersion === "chat-dsh-lifeos-state.v11"
          ? legacy.data.preferredWorkflowSelection
          : (Object.values(legacy.data.sessions).reduce<
              z.infer<typeof legacyWorkflowSelectionSchema> | undefined
            >((latest, binding) => binding.workflowSelection ?? latest, undefined) ?? null),
      sessions: Object.fromEntries(
        Object.entries(legacy.data.sessions).map(([sessionId, binding]) => [
          sessionId,
          {
            ...binding,
            dshSendReviewEnabled:
              "dshSendReviewEnabled" in binding ? binding.dshSendReviewEnabled : false,
            bridgeDispatchReviewEnabled:
              "bridgeDispatchReviewEnabled" in binding &&
              binding.bridgeDispatchReviewEnabled !== undefined
                ? binding.bridgeDispatchReviewEnabled
                : false,
          },
        ]),
      ),
    });
    await this.writeAtomic(migrated);
    this.state = migrated;
    return this.state;
  }

  /** 校验DSH Session当前请求确实绑定该Product Run，避免展示工具成为越权Query。 */
  async assertCurrentTraceBinding(dshSessionId: string, productRunId: string): Promise<void> {
    const binding = await this.readSession(dshSessionId);
    const request =
      binding?.currentRequestKey === undefined
        ? undefined
        : binding.requests[binding.currentRequestKey];
    if (request?.productRunId !== productRunId) {
      throw new Error("lifeos trace tool is not bound to the current Product Run");
    }
  }

  /** 单调推进展示cursor；重复执行同一显示工具不会回退或制造第二条事实链。 */
  async advanceTraceCursor(
    dshSessionId: string,
    productRunId: string,
    sequence: number,
  ): Promise<void> {
    const existing = await this.readSession(dshSessionId);
    if (existing === undefined) throw new Error("lifeos trace session is not bound");
    await this.mutateSession(dshSessionId, existing.createSessionCommandId, (binding) => {
      const request =
        binding.currentRequestKey === undefined
          ? undefined
          : binding.requests[binding.currentRequestKey];
      if (request?.productRunId !== productRunId) {
        throw new Error("lifeos trace cursor Product Run mismatch");
      }
      request.traceCursor = Math.max(request.traceCursor ?? 0, sequence);
    });
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
