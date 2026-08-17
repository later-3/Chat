import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import {
  approvalRequestIdSchema,
  commandIdSchema,
  planIdSchema,
  productRunIdSchema,
  productSessionIdSchema,
  sha256Schema,
} from "@chat/contracts/public";
import { z } from "zod";
import {
  decisionRequestSchema,
  dshSessionIdSchema,
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

const requestSchema = z
  .object({
    userTextSha256: sha256Schema,
    messageCommandId: commandIdSchema.transform(String),
    productRunId: productRunIdSchema.transform(String).optional(),
    pendingDecision: pendingDecisionSchema.optional(),
    /**
     * 请求创建时冻结的Workflow选择快照。发送中途修改会话草稿不影响
     * 已创建请求；同一请求的幂等重放始终携带同一选择。
     */
    workflowSelection: workflowSelectionSchema.optional(),
  })
  .strict();

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
 * rc.6切换时已经存在的Bridge状态。迁移读取也接受短暂开发版本写入的
 * optional workflow字段，随后立即改写为v2；不能在同一个v1标记下扩展strict格式。
 */
const legacyBridgeStateSchema = z
  .object({
    schemaVersion: z.literal("chat-dsh-lifeos-state.v1"),
    sessions: z.record(dshSessionIdSchema, sessionBindingSchema),
  })
  .strict();

const bridgeStateSchema = z
  .object({
    schemaVersion: z.literal("chat-dsh-lifeos-state.v2"),
    sessions: z.record(dshSessionIdSchema, sessionBindingSchema),
  })
  .strict();

export type BridgeState = z.infer<typeof bridgeStateSchema>;
export type SessionBinding = z.infer<typeof sessionBindingSchema>;
export type RequestBinding = z.infer<typeof requestSchema>;
export type PendingDecision = z.infer<typeof pendingDecisionSchema>;

const emptyState = (): BridgeState => ({
  schemaVersion: "chat-dsh-lifeos-state.v2",
  sessions: {},
});

/**
 * Bridge-local identity projection. It never stores message/Plan bodies and never
 * decides product state; Chat Product Store remains authoritative for every fact.
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
      schemaVersion: "chat-dsh-lifeos-state.v2",
      sessions: legacy.data.sessions,
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
