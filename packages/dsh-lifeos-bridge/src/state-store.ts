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
  promptReviewDecisionRequestSchema,
  workflowSelectionSchema,
} from "./contracts.ts";

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
  })
  .strict();

/**
 * rc.6切换后已经存在的Bridge状态。除可恢复的外部身份外，v6只增加提交结果未知期间
 * 的有界Workspace指令重试正文；迁移读取接受v1-v5，随后立即改写为当前版本，不能在
 * 旧schema标记下静默扩展strict格式。
 */
const legacyBridgeStateSchema = z
  .object({
    schemaVersion: z.enum([
      "chat-dsh-lifeos-state.v1",
      "chat-dsh-lifeos-state.v2",
      "chat-dsh-lifeos-state.v3",
      "chat-dsh-lifeos-state.v4",
      "chat-dsh-lifeos-state.v5",
      "chat-dsh-lifeos-state.v6",
    ]),
    sessions: z.record(dshSessionIdSchema, sessionBindingSchema),
  })
  .strict();

const bridgeStateSchema = z
  .object({
    schemaVersion: z.literal("chat-dsh-lifeos-state.v7"),
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
  schemaVersion: "chat-dsh-lifeos-state.v7",
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
        binding = { createSessionCommandId, requests: {} };
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
      schemaVersion: "chat-dsh-lifeos-state.v7",
      sessions: legacy.data.sessions,
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
