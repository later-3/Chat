import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import {
  approvalRequestIdSchema,
  outboxEntryIdSchema,
  productRunIdSchema,
  type ApprovalRequestId,
  type OutboxEntryId,
  type ProductRunId,
} from "@chat/contracts";

/**
 * Runtime Binding Store：产品身份到Workflow私有身份的单机映射与派发栅栏。
 *
 * startIntent/dispatching必须先于不可逆Runtime调用落盘。若调用后无法确认结果，
 * 状态保持outcome_unknown并禁止盲重试，从而保证“宁可人工对账，也不重复启动/
 * 恢复”。文件本身使用克隆提交与atomic rename；rename后目录fsync不确定时实例
 * 立即熔断，避免旧内存覆盖已提交映射。
 */

const RUNTIME_BINDINGS_SCHEMA_VERSION = "runtime-bindings.v1";

const startIntentSchema = z
  .object({
    outboxId: outboxEntryIdSchema,
    workflowDefinitionVersion: z.string().min(1).max(100),
    state: z.enum(["starting", "outcome_unknown"]),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

const workflowBindingSchema = z
  .object({
    workflowRunId: z.string().min(1).max(200),
    workflowDefinitionVersion: z.string().min(1).max(100),
    startDispatchState: z.literal("started"),
    createdAt: z.iso.datetime(),
  })
  .strict();

const hookBindingSchema = z
  .object({
    hookToken: z.string().min(1).max(300),
    productRunId: productRunIdSchema,
    planRevision: z.number().int().positive(),
    hookClaimState: z.literal("claimed"),
    resumeDispatchState: z.enum([
      "none",
      "dispatching",
      "dispatched",
      "outcome_unknown",
      "failed_terminal",
    ]),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const runtimeBindingsFileSchema = z
  .object({
    schemaVersion: z.literal(RUNTIME_BINDINGS_SCHEMA_VERSION),
    /** default保持对早期v1调试文件的向后读取兼容。 */
    startIntents: z.record(productRunIdSchema, startIntentSchema).default({}),
    workflows: z.record(productRunIdSchema, workflowBindingSchema),
    hooks: z.record(approvalRequestIdSchema, hookBindingSchema),
  })
  .strict();

export type RuntimeBindingsFile = z.infer<typeof runtimeBindingsFileSchema>;
export type WorkflowBinding = z.infer<typeof workflowBindingSchema>;
export type HookBinding = z.infer<typeof hookBindingSchema>;

export class RuntimeBindingError extends Error {
  readonly code = "runtime_binding_invalid";
  constructor(message: string) {
    super(message);
    this.name = "RuntimeBindingError";
  }
}

function emptyBindings(): RuntimeBindingsFile {
  return {
    schemaVersion: RUNTIME_BINDINGS_SCHEMA_VERSION,
    startIntents: {},
    workflows: {},
    hooks: {},
  };
}

export class RuntimeBindingStore {
  private readonly filePath: string;
  private bindings: RuntimeBindingsFile;
  private queue: Promise<unknown> = Promise.resolve();
  private unavailable: RuntimeBindingError | undefined;

  private constructor(filePath: string, bindings: RuntimeBindingsFile) {
    this.filePath = filePath;
    this.bindings = bindings;
  }

  static async open(
    filePath: string,
    options: { readonly allowCreate?: boolean } = {},
  ): Promise<RuntimeBindingStore> {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (error) {
      if (isFileNotFound(error)) {
        if (options.allowCreate === false) {
          throw new RuntimeBindingError(
            "Runtime已有耐久运行数据但Binding Store缺失，拒绝创建空映射",
          );
        }
        await mkdir(dirname(filePath), { recursive: true });
        const store = new RuntimeBindingStore(filePath, emptyBindings());
        await store.persist(store.bindings);
        return store;
      }
      throw new RuntimeBindingError("无法读取Runtime Binding Store");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new RuntimeBindingError("Runtime Binding Store不是合法JSON，已保留原文件");
    }
    const validated = runtimeBindingsFileSchema.safeParse(parsed);
    if (!validated.success) {
      throw new RuntimeBindingError("Runtime Binding Store版本未知或内容非法，已保留原文件");
    }
    assertRuntimeBindingsIntegrity(validated.data);
    return new RuntimeBindingStore(filePath, validated.data);
  }

  hasDurableBindings(): boolean {
    this.assertAvailable();
    return (
      Object.keys(this.bindings.startIntents).length > 0 ||
      Object.keys(this.bindings.workflows).length > 0 ||
      Object.keys(this.bindings.hooks).length > 0
    );
  }

  listWorkflowBindings(): readonly {
    productRunId: ProductRunId;
    binding: WorkflowBinding;
  }[] {
    this.assertAvailable();
    return Object.entries(this.bindings.workflows).map(([productRunId, binding]) => ({
      productRunId: productRunId as ProductRunId,
      binding: structuredClone(binding),
    }));
  }

  getWorkflowBinding(productRunId: ProductRunId): WorkflowBinding | undefined {
    this.assertAvailable();
    const value = this.bindings.workflows[productRunId];
    return value === undefined ? undefined : structuredClone(value);
  }

  getHookBinding(approvalRequestId: ApprovalRequestId): HookBinding | undefined {
    this.assertAvailable();
    const value = this.bindings.hooks[approvalRequestId];
    return value === undefined ? undefined : structuredClone(value);
  }

  getStartState(productRunId: ProductRunId): "missing" | "outcome_unknown" | "exists" {
    this.assertAvailable();
    if (this.bindings.workflows[productRunId] !== undefined) return "exists";
    return this.bindings.startIntents[productRunId] !== undefined ? "outcome_unknown" : "missing";
  }

  /** 先落盘start意图；已有未决意图时绝不再次调用Workflow start。 */
  async claimStartIntent(input: {
    productRunId: ProductRunId;
    outboxId: OutboxEntryId;
    workflowDefinitionVersion: string;
    now: string;
  }): Promise<"claimed" | "already_started" | "outcome_unknown"> {
    return this.enqueue(async () => {
      this.assertAvailable();
      if (this.bindings.workflows[input.productRunId] !== undefined) return "already_started";
      const existing = this.bindings.startIntents[input.productRunId];
      if (existing !== undefined) {
        if (
          existing.outboxId !== input.outboxId ||
          existing.workflowDefinitionVersion !== input.workflowDefinitionVersion
        ) {
          throw new RuntimeBindingError("productRunId的Workflow start意图冲突，失败关闭");
        }
        return "outcome_unknown";
      }
      const next = structuredClone(this.bindings);
      next.startIntents[input.productRunId] = {
        outboxId: input.outboxId,
        workflowDefinitionVersion: input.workflowDefinitionVersion,
        state: "starting",
        createdAt: input.now,
        updatedAt: input.now,
      };
      await this.commit(next);
      return "claimed";
    });
  }

  /** start成功后一次提交Workflow映射并清除意图；同runId重放幂等。 */
  async claimWorkflowBinding(input: {
    productRunId: ProductRunId;
    outboxId: OutboxEntryId;
    workflowRunId: string;
    workflowDefinitionVersion: string;
    now: string;
  }): Promise<{ alreadyExisted: boolean }> {
    return this.enqueue(async () => {
      this.assertAvailable();
      const existing = this.bindings.workflows[input.productRunId];
      if (existing !== undefined) {
        if (
          existing.workflowRunId !== input.workflowRunId ||
          existing.workflowDefinitionVersion !== input.workflowDefinitionVersion
        ) {
          throw new RuntimeBindingError("productRunId的Workflow映射冲突，失败关闭");
        }
        return { alreadyExisted: true };
      }
      const intent = this.bindings.startIntents[input.productRunId];
      if (
        intent === undefined ||
        intent.outboxId !== input.outboxId ||
        intent.workflowDefinitionVersion !== input.workflowDefinitionVersion
      ) {
        throw new RuntimeBindingError("Workflow start结果缺少匹配的持久化意图");
      }
      const next = structuredClone(this.bindings);
      next.workflows[input.productRunId] = {
        workflowRunId: input.workflowRunId,
        workflowDefinitionVersion: input.workflowDefinitionVersion,
        startDispatchState: "started",
        createdAt: input.now,
      };
      delete next.startIntents[input.productRunId];
      await this.commit(next);
      return { alreadyExisted: false };
    });
  }

  async markStartOutcomeUnknown(productRunId: ProductRunId, now: string): Promise<void> {
    await this.enqueue(async () => {
      this.assertAvailable();
      const intent = this.bindings.startIntents[productRunId];
      if (intent === undefined) throw new RuntimeBindingError("缺少Workflow start意图");
      const next = structuredClone(this.bindings);
      next.startIntents[productRunId] = { ...intent, state: "outcome_unknown", updatedAt: now };
      await this.commit(next);
    });
  }

  async claimHookBinding(input: {
    approvalRequestId: ApprovalRequestId;
    productRunId: ProductRunId;
    planRevision: number;
    hookToken: string;
    now: string;
  }): Promise<void> {
    await this.enqueue(async () => {
      this.assertAvailable();
      const existing = this.bindings.hooks[input.approvalRequestId];
      if (existing !== undefined) {
        if (
          existing.hookToken !== input.hookToken ||
          existing.productRunId !== input.productRunId ||
          existing.planRevision !== input.planRevision
        ) {
          throw new RuntimeBindingError("approvalRequestId的Hook映射冲突，失败关闭");
        }
        return;
      }
      const next = structuredClone(this.bindings);
      next.hooks[input.approvalRequestId] = {
        hookToken: input.hookToken,
        productRunId: input.productRunId,
        planRevision: input.planRevision,
        hookClaimState: "claimed",
        resumeDispatchState: "none",
        createdAt: input.now,
        updatedAt: input.now,
      };
      await this.commit(next);
    });
  }

  async markResumeDispatching(approvalRequestId: ApprovalRequestId, now: string): Promise<void> {
    await this.setResumeState(approvalRequestId, "dispatching", now, ["none"]);
  }

  async markResumeDispatched(approvalRequestId: ApprovalRequestId, now: string): Promise<void> {
    await this.setResumeState(approvalRequestId, "dispatched", now, ["dispatching", "dispatched"]);
  }

  async markResumeOutcomeUnknown(approvalRequestId: ApprovalRequestId, now: string): Promise<void> {
    await this.setResumeState(approvalRequestId, "outcome_unknown", now, [
      "dispatching",
      "outcome_unknown",
    ]);
  }

  async markResumeFailedTerminal(approvalRequestId: ApprovalRequestId, now: string): Promise<void> {
    await this.setResumeState(approvalRequestId, "failed_terminal", now, ["none", "dispatching"]);
  }

  private async setResumeState(
    approvalRequestId: ApprovalRequestId,
    state: HookBinding["resumeDispatchState"],
    now: string,
    allowedFrom: readonly HookBinding["resumeDispatchState"][],
  ): Promise<void> {
    await this.enqueue(async () => {
      this.assertAvailable();
      const existing = this.bindings.hooks[approvalRequestId];
      if (existing === undefined) throw new RuntimeBindingError("Resume的Hook映射缺失，失败关闭");
      if (!allowedFrom.includes(existing.resumeDispatchState)) {
        throw new RuntimeBindingError(`Hook Resume状态不允许转换到${state}`);
      }
      if (existing.resumeDispatchState === state) return;
      const next = structuredClone(this.bindings);
      next.hooks[approvalRequestId] = { ...existing, resumeDispatchState: state, updatedAt: now };
      await this.commit(next);
    });
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async commit(next: RuntimeBindingsFile): Promise<void> {
    const validated = runtimeBindingsFileSchema.parse(next);
    assertRuntimeBindingsIntegrity(validated);
    await this.persist(validated);
    this.bindings = validated;
  }

  private async persist(bindings: RuntimeBindingsFile): Promise<void> {
    const directory = dirname(this.filePath);
    await mkdir(directory, { recursive: true });
    const tempPath = join(directory, `.${basename(this.filePath)}.tmp-${randomUUID()}`);
    let renamed = false;
    try {
      await writeFile(tempPath, JSON.stringify(bindings, null, 2), {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      const temp = await open(tempPath, "r");
      try {
        await temp.sync();
      } finally {
        await temp.close();
      }
      const beforeRenameDirectory = await open(directory, "r");
      try {
        await beforeRenameDirectory.sync();
      } finally {
        await beforeRenameDirectory.close();
      }
      await rename(tempPath, this.filePath);
      renamed = true;
      const afterRenameDirectory = await open(directory, "r");
      try {
        await afterRenameDirectory.sync();
      } finally {
        await afterRenameDirectory.close();
      }
    } catch (error) {
      if (renamed) {
        this.unavailable = new RuntimeBindingError(
          "Runtime Binding在rename后无法确认目录持久化，实例已熔断；必须重启恢复",
        );
        throw this.unavailable;
      }
      throw error;
    }
  }

  private assertAvailable(): void {
    if (this.unavailable !== undefined) throw this.unavailable;
  }
}

function assertRuntimeBindingsIntegrity(bindings: RuntimeBindingsFile): void {
  for (const productRunId of Object.keys(bindings.startIntents) as ProductRunId[]) {
    if (bindings.workflows[productRunId] !== undefined) {
      throw new RuntimeBindingError("同一Product Run不能同时存在start意图与Workflow映射");
    }
  }
  const workflowRunIds = Object.values(bindings.workflows).map((binding) => binding.workflowRunId);
  if (new Set(workflowRunIds).size !== workflowRunIds.length) {
    throw new RuntimeBindingError("多个Product Run不能共享同一Workflow Run映射");
  }
  const hookTokens = Object.values(bindings.hooks).map((binding) => binding.hookToken);
  if (new Set(hookTokens).size !== hookTokens.length) {
    throw new RuntimeBindingError("多个Approval不能共享同一Hook Token");
  }
  for (const hook of Object.values(bindings.hooks)) {
    if (bindings.workflows[hook.productRunId] === undefined) {
      throw new RuntimeBindingError("Hook映射缺少对应Workflow映射");
    }
  }
}

function isFileNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
