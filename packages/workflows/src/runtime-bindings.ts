import { open, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import {
  approvalRequestIdSchema,
  productRunIdSchema,
  type ApprovalRequestId,
  type ProductRunId,
} from "@chat/contracts";

/**
 * Runtime Binding Store（任务书§8.4）。
 *
 * 保存产品身份与私有Runtime身份的映射：
 * - productRunId -> workflowRunId + workflowDefinitionVersion + startDispatchState
 * - approvalRequestId -> hookToken + hookClaimState + resumeDispatchState
 *
 * 边界：
 * - 只有Workflow Adapter（Workflow Runtime进程）可以读写。
 * - Runtime ID和Hook Token不进入API、浏览器、URL、localStorage、Trace或PR证据。
 * - 文件缺失、损坏、版本未知或映射冲突时失败关闭，不猜测或重新创建可能重复的Workflow。
 * - 单进程/单机Adapter；与Product Snapshot之间的不确定区间由Outbox对账处理。
 */

const RUNTIME_BINDINGS_SCHEMA_VERSION = "runtime-bindings.v1";

const workflowBindingSchema = z
  .object({
    workflowRunId: z.string().min(1).max(200),
    workflowDefinitionVersion: z.string().min(1).max(100),
    startDispatchState: z.enum(["started"]),
    createdAt: z.iso.datetime(),
  })
  .strict();

const hookBindingSchema = z
  .object({
    hookToken: z.string().min(1).max(300),
    productRunId: productRunIdSchema,
    planRevision: z.number().int().positive(),
    hookClaimState: z.enum(["claimed"]),
    resumeDispatchState: z.enum(["none", "dispatched", "failed_terminal"]),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const runtimeBindingsFileSchema = z
  .object({
    schemaVersion: z.literal(RUNTIME_BINDINGS_SCHEMA_VERSION),
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
  return { schemaVersion: RUNTIME_BINDINGS_SCHEMA_VERSION, workflows: {}, hooks: {} };
}

export class RuntimeBindingStore {
  private readonly filePath: string;
  private bindings: RuntimeBindingsFile;
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(filePath: string, bindings: RuntimeBindingsFile) {
    this.filePath = filePath;
    this.bindings = bindings;
  }

  /** 文件缺失时初始化空映射；损坏/未知版本/非法内容失败关闭并保留原文件。 */
  static async open(filePath: string): Promise<RuntimeBindingStore> {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        const store = new RuntimeBindingStore(filePath, emptyBindings());
        await store.persist();
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
    return new RuntimeBindingStore(filePath, validated.data);
  }

  getWorkflowBinding(productRunId: ProductRunId): WorkflowBinding | undefined {
    return this.bindings.workflows[productRunId];
  }

  getHookBinding(approvalRequestId: ApprovalRequestId): HookBinding | undefined {
    return this.bindings.hooks[approvalRequestId];
  }

  /**
   * 记录Workflow启动映射。同一productRunId已存在且内容一致时幂等返回；
   * 存在但workflowRunId不同视为冲突，失败关闭（不得猜测或重建）。
   */
  async claimWorkflowBinding(input: {
    productRunId: ProductRunId;
    workflowRunId: string;
    workflowDefinitionVersion: string;
    now: string;
  }): Promise<{ alreadyExisted: boolean }> {
    return this.enqueue(async () => {
      const existing = this.bindings.workflows[input.productRunId];
      if (existing !== undefined) {
        if (existing.workflowRunId !== input.workflowRunId) {
          throw new RuntimeBindingError("productRunId的Workflow映射冲突，失败关闭");
        }
        return { alreadyExisted: true };
      }
      this.bindings.workflows[input.productRunId] = {
        workflowRunId: input.workflowRunId,
        workflowDefinitionVersion: input.workflowDefinitionVersion,
        startDispatchState: "started",
        createdAt: input.now,
      };
      await this.persist();
      return { alreadyExisted: false };
    });
  }

  async claimHookBinding(input: {
    approvalRequestId: ApprovalRequestId;
    productRunId: ProductRunId;
    planRevision: number;
    hookToken: string;
    now: string;
  }): Promise<void> {
    return this.enqueue(async () => {
      const existing = this.bindings.hooks[input.approvalRequestId];
      if (existing !== undefined) {
        if (existing.hookToken !== input.hookToken) {
          throw new RuntimeBindingError("approvalRequestId的Hook映射冲突，失败关闭");
        }
        return;
      }
      this.bindings.hooks[input.approvalRequestId] = {
        hookToken: input.hookToken,
        productRunId: input.productRunId,
        planRevision: input.planRevision,
        hookClaimState: "claimed",
        resumeDispatchState: "none",
        createdAt: input.now,
        updatedAt: input.now,
      };
      await this.persist();
    });
  }

  /** 标记Resume已派发；重复派发请求由调用方据此短路，不再第二次恢复Hook。 */
  async markResumeDispatched(approvalRequestId: ApprovalRequestId, now: string): Promise<void> {
    return this.enqueue(async () => {
      const existing = this.bindings.hooks[approvalRequestId];
      if (existing === undefined) {
        throw new RuntimeBindingError("Resume前Hook映射缺失，失败关闭");
      }
      existing.resumeDispatchState = "dispatched";
      existing.updatedAt = now;
      await this.persist();
    });
  }

  async markResumeFailedTerminal(approvalRequestId: ApprovalRequestId, now: string): Promise<void> {
    return this.enqueue(async () => {
      const existing = this.bindings.hooks[approvalRequestId];
      if (existing === undefined) {
        throw new RuntimeBindingError("标记失败前Hook映射缺失，失败关闭");
      }
      existing.resumeDispatchState = "failed_terminal";
      existing.updatedAt = now;
      await this.persist();
    });
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** 原子写入：同目录临时文件(0600) -> fsync -> rename。 */
  private async persist(): Promise<void> {
    const tempPath = join(
      dirname(this.filePath),
      `.${basename(this.filePath)}.tmp-${randomUUID()}`,
    );
    await writeFile(tempPath, JSON.stringify(this.bindings, null, 2), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    const handle = await open(tempPath, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempPath, this.filePath);
  }
}
