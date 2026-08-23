import { open, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createEmptySnapshot, productSnapshotSchema, type ProductSnapshot } from "@chat/contracts";
import {
  ApplicationError,
  CommandIdReusedError,
  StoreCorruptedError,
  type ProductReadRequest,
  type ProductReadResult,
  type ProductStorePort,
  type ProductTransaction,
  type ProductTransactionResult,
  type TraceEmitter,
} from "@chat/application";
import {
  createSystemPlanningDefinition,
  createSystemSimplePlanningDefinition,
  createSystemMemoryPlanningDefinition,
  createSystemNoteDefinition,
  createSystemDirectAgentDefinition,
  createSystemMemoryDirectDefinition,
  createSystemMemoryAgentDirectDefinition,
  SYSTEM_PLANNING_WORKFLOW_DEFINITION_ID,
  SYSTEM_PLANNING_WORKFLOW_REVISION_ID,
  SYSTEM_PLANNING_WORKFLOW_VIEW_ID,
  SYSTEM_SIMPLE_PLANNING_WORKFLOW_DEFINITION_ID,
  SYSTEM_SIMPLE_PLANNING_WORKFLOW_REVISION_ID,
  SYSTEM_SIMPLE_PLANNING_WORKFLOW_VIEW_ID,
  SYSTEM_MEMORY_PLANNING_WORKFLOW_DEFINITION_ID,
  SYSTEM_MEMORY_PLANNING_WORKFLOW_REVISION_ID,
  SYSTEM_MEMORY_PLANNING_WORKFLOW_VIEW_ID,
  SYSTEM_NOTE_WORKFLOW_DEFINITION_ID,
  SYSTEM_NOTE_WORKFLOW_REVISION_ID,
  SYSTEM_NOTE_WORKFLOW_VIEW_ID,
  SYSTEM_DIRECT_AGENT_WORKFLOW_DEFINITION_ID,
  SYSTEM_DIRECT_AGENT_WORKFLOW_REVISION_ID,
  SYSTEM_DIRECT_AGENT_WORKFLOW_VIEW_ID,
  SYSTEM_MEMORY_DIRECT_WORKFLOW_DEFINITION_ID,
  SYSTEM_MEMORY_DIRECT_WORKFLOW_REVISION_ID,
  SYSTEM_MEMORY_DIRECT_WORKFLOW_VIEW_ID,
  SYSTEM_MEMORY_AGENT_DIRECT_WORKFLOW_DEFINITION_ID,
  SYSTEM_MEMORY_AGENT_DIRECT_WORKFLOW_REVISION_ID,
  SYSTEM_MEMORY_AGENT_DIRECT_WORKFLOW_VIEW_ID,
} from "@chat/application/workflow-system-definitions";
import { assertSnapshotIntegrity } from "./snapshot-integrity.js";
import { migrateProductSnapshotV1ToV2, productSnapshotV1Schema } from "./migrate-v1-to-v2.js";
import { migrateProductSnapshotV2ToV3, productSnapshotV2Schema } from "./migrate-v2-to-v3.js";
import { migrateProductSnapshotV3ToV4, productSnapshotV3Schema } from "./migrate-v3-to-v4.js";
import { productSnapshotV4Schema } from "./legacy-v4.js";
import { productSnapshotV5Schema } from "./legacy-v5.js";
import { productSnapshotV6Schema } from "./legacy-v6.js";
import { productSnapshotV7Schema } from "./legacy-v7.js";
import { productSnapshotV8Schema } from "./legacy-v8.js";
import { productSnapshotV9Schema } from "./legacy-v9.js";
import { productSnapshotV10Schema } from "./legacy-v10.js";
import { productSnapshotV11Schema } from "./legacy-v11.js";
import { productSnapshotV12Schema } from "./legacy-v12.js";
import { productSnapshotV13Schema } from "./legacy-v13.js";
import { productSnapshotV14Schema } from "./legacy-v14.js";
import { productSnapshotV15Schema } from "./legacy-v15.js";
import { productSnapshotV16Schema } from "./legacy-v16.js";
import { productSnapshotV17Schema } from "./legacy-v17.js";
import { productSnapshotV18Schema } from "./legacy-v18.js";
import { productSnapshotV19Schema } from "./legacy-v19.js";
import { productSnapshotV20Schema } from "./legacy-v20.js";
import { migrateProductSnapshotV4ToV5 } from "./migrate-v4-to-v5.js";
import { migrateProductSnapshotV5ToV6 } from "./migrate-v5-to-v6.js";
import { migrateProductSnapshotV6ToV7 } from "./migrate-v6-to-v7.js";
import { migrateProductSnapshotV7ToV8 } from "./migrate-v7-to-v8.js";
import { migrateProductSnapshotV8ToV9 } from "./migrate-v8-to-v9.js";
import { migrateProductSnapshotV9ToV10 } from "./migrate-v9-to-v10.js";
import { migrateProductSnapshotV10ToV11 } from "./migrate-v10-to-v11.js";
import { migrateProductSnapshotV11ToV12 } from "./migrate-v11-to-v12.js";
import { migrateProductSnapshotV12ToV13 } from "./migrate-v12-to-v13.js";
import { migrateProductSnapshotV13ToV14 } from "./migrate-v13-to-v14.js";
import { migrateProductSnapshotV14ToV15 } from "./migrate-v14-to-v15.js";
import { migrateProductSnapshotV15ToV16 } from "./migrate-v15-to-v16.js";
import { migrateProductSnapshotV16ToV17 } from "./migrate-v16-to-v17.js";
import { migrateProductSnapshotV17ToV18 } from "./migrate-v17-to-v18.js";
import { migrateProductSnapshotV18ToV19 } from "./migrate-v18-to-v19.js";
import { migrateProductSnapshotV19ToV20 } from "./migrate-v19-to-v20.js";
import { migrateProductSnapshotV20ToV21 } from "./migrate-v20-to-v21.js";

/**
 * 版本化JSON Product Store Adapter（任务书§8）。
 *
 * 边界：
 * - 单实例、单写者：只允许API组合根创建一个实例并独占文件；
 *   Workflow进程、Router和pi不得打开产品JSON文件。
 * - 原子提交算法：单写队列 -> 校验commandId/CAS/不变量 -> 克隆并应用 ->
 *   完整快照strict校验 -> 同目录唯一临时文件(0600) -> fsync -> atomic rename ->
 *   fsync父目录 -> 替换内存快照。
 * - 任一步失败：内存指向旧已提交快照，正式文件逐字节不变，
 *   临时文件只报告和隔离，不自动覆盖正式文件。
 * - 启动遇到损坏JSON、未知Schema、悬空引用或Hash不一致失败关闭，原文件不变。
 * - 本Adapter不宣称多实例生产耐久性；未来通过ProductStorePort替换数据库。
 */

/** IO边界，默认真实文件系统；测试可逐步注入失败。 */
export interface StoreIo {
  readSnapshotFile(path: string): Promise<string>;
  writeTempFile(path: string, bytes: string): Promise<void>;
  fsyncTempFile(path: string): Promise<void>;
  renameTempFile(from: string, to: string): Promise<void>;
  fsyncParentDirectory(path: string): Promise<void>;
}

const defaultIo: StoreIo = {
  readSnapshotFile: (path) => readFile(path, "utf8"),
  writeTempFile: async (path, bytes) => {
    await writeFile(path, bytes, { encoding: "utf8", mode: 0o600, flag: "wx" });
  },
  fsyncTempFile: async (path) => {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  renameTempFile: (from, to) => rename(from, to),
  fsyncParentDirectory: async (path) => {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
};

export interface JsonProductStoreOptions {
  readonly filePath: string;
  readonly now: () => string;
  readonly trace?: TraceEmitter;
  /** 失败注入点；生产必须缺省。 */
  readonly io?: Partial<StoreIo>;
}

function declaredSnapshotVersion(input: unknown): string | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const version = (input as { readonly schemaVersion?: unknown }).schemaVersion;
  return typeof version === "string" ? version : undefined;
}

function requireLegacySnapshot<T>(
  parsed: { readonly success: true; readonly data: T } | { readonly success: false },
): T {
  if (!parsed.success) {
    throw new StoreCorruptedError("Product Store Schema未知或非法，已保留原文件");
  }
  return parsed.data;
}

/**
 * 每轮只解释当前声明版本并执行一个迁移；不尝试用其他版本Schema“猜中”损坏数据。
 * 新版本只需新增一个case，不再把整个历史链继续向右嵌套。
 */
function migrateLegacySnapshot(input: unknown): ProductSnapshot {
  let candidate = input;
  for (let step = 0; step < 20; step += 1) {
    switch (declaredSnapshotVersion(candidate)) {
      case "chat-product-store.v1":
        candidate = migrateProductSnapshotV1ToV2(
          requireLegacySnapshot(productSnapshotV1Schema.safeParse(candidate)),
        );
        break;
      case "chat-product-store.v2":
        candidate = migrateProductSnapshotV2ToV3(
          requireLegacySnapshot(productSnapshotV2Schema.safeParse(candidate)),
        );
        break;
      case "chat-product-store.v3":
        candidate = migrateProductSnapshotV3ToV4(
          requireLegacySnapshot(productSnapshotV3Schema.safeParse(candidate)),
        );
        break;
      case "chat-product-store.v4":
        candidate = migrateProductSnapshotV4ToV5(
          requireLegacySnapshot(productSnapshotV4Schema.safeParse(candidate)),
        );
        break;
      case "chat-product-store.v5":
        candidate = migrateProductSnapshotV5ToV6(
          requireLegacySnapshot(productSnapshotV5Schema.safeParse(candidate)),
        );
        break;
      case "chat-product-store.v6":
        candidate = migrateProductSnapshotV6ToV7(
          requireLegacySnapshot(productSnapshotV6Schema.safeParse(candidate)),
        );
        break;
      case "chat-product-store.v7":
        candidate = productSnapshotV8Schema.parse(
          migrateProductSnapshotV7ToV8(
            requireLegacySnapshot(productSnapshotV7Schema.safeParse(candidate)),
          ),
        );
        break;
      case "chat-product-store.v8":
        candidate = migrateProductSnapshotV8ToV9(
          requireLegacySnapshot(productSnapshotV8Schema.safeParse(candidate)),
        );
        break;
      case "chat-product-store.v9":
        candidate = productSnapshotV10Schema.parse(
          migrateProductSnapshotV9ToV10(
            requireLegacySnapshot(productSnapshotV9Schema.safeParse(candidate)),
          ),
        );
        break;
      case "chat-product-store.v10":
        candidate = migrateProductSnapshotV10ToV11(
          requireLegacySnapshot(productSnapshotV10Schema.safeParse(candidate)),
        );
        break;
      case "chat-product-store.v11":
        candidate = migrateProductSnapshotV11ToV12(
          requireLegacySnapshot(productSnapshotV11Schema.safeParse(candidate)),
        );
        break;
      case "chat-product-store.v12":
        candidate = migrateProductSnapshotV12ToV13(
          requireLegacySnapshot(productSnapshotV12Schema.safeParse(candidate)),
        );
        break;
      case "chat-product-store.v13":
        candidate = migrateProductSnapshotV13ToV14(
          requireLegacySnapshot(productSnapshotV13Schema.safeParse(candidate)),
        );
        break;
      case "chat-product-store.v14":
        candidate = migrateProductSnapshotV14ToV15(
          requireLegacySnapshot(productSnapshotV14Schema.safeParse(candidate)),
        );
        break;
      case "chat-product-store.v15":
        candidate = migrateProductSnapshotV15ToV16(
          requireLegacySnapshot(productSnapshotV15Schema.safeParse(candidate)),
        );
        break;
      case "chat-product-store.v16":
        candidate = migrateProductSnapshotV16ToV17(
          requireLegacySnapshot(productSnapshotV16Schema.safeParse(candidate)),
        );
        break;
      case "chat-product-store.v17":
        candidate = migrateProductSnapshotV17ToV18(
          requireLegacySnapshot(productSnapshotV17Schema.safeParse(candidate)),
        );
        break;
      case "chat-product-store.v18":
        candidate = migrateProductSnapshotV18ToV19(
          requireLegacySnapshot(productSnapshotV18Schema.safeParse(candidate)),
        );
        break;
      case "chat-product-store.v19":
        candidate = migrateProductSnapshotV19ToV20(
          requireLegacySnapshot(productSnapshotV19Schema.safeParse(candidate)),
        );
        break;
      case "chat-product-store.v20":
        return migrateProductSnapshotV20ToV21(
          requireLegacySnapshot(productSnapshotV20Schema.safeParse(candidate)),
        );
      default:
        throw new StoreCorruptedError("Product Store Schema未知或非法，已保留原文件");
    }
  }
  throw new StoreCorruptedError("Product Store迁移链未能收敛，已保留原文件");
}

export class JsonProductStore implements ProductStorePort {
  private readonly filePath: string;
  private readonly now: () => string;
  private readonly io: StoreIo;
  private readonly trace: TraceEmitter | undefined;
  private snapshot: ProductSnapshot;
  private queue: Promise<unknown> = Promise.resolve();
  private unavailable: StoreCorruptedError | undefined;

  private constructor(options: JsonProductStoreOptions, snapshot: ProductSnapshot) {
    this.filePath = options.filePath;
    this.now = options.now;
    this.io = { ...defaultIo, ...options.io };
    this.trace = options.trace;
    this.snapshot = snapshot;
  }

  /**
   * 打开或初始化Store。文件不存在时创建创世快照；
   * 损坏/未知Schema/完整性失败时抛出StoreCorruptedError且不修改原文件。
   */
  static async open(options: JsonProductStoreOptions): Promise<JsonProductStore> {
    const io: StoreIo = { ...defaultIo, ...options.io };
    let raw: string;
    try {
      raw = await io.readSnapshotFile(options.filePath);
    } catch (error) {
      if (isFileNotFound(error)) {
        const genesis = createEmptySnapshot(options.now());
        const seed = createSystemPlanningDefinition(genesis.committedAt);
        const simpleSeed = createSystemSimplePlanningDefinition(genesis.committedAt);
        const memorySeed = createSystemMemoryPlanningDefinition(genesis.committedAt);
        const noteSeed = createSystemNoteDefinition(genesis.committedAt);
        const directSeed = createSystemDirectAgentDefinition(genesis.committedAt);
        const memoryDirectSeed = createSystemMemoryDirectDefinition(genesis.committedAt);
        const memoryAgentDirectSeed = createSystemMemoryAgentDirectDefinition(genesis.committedAt);
        genesis.entities.workflowDefinitions[SYSTEM_PLANNING_WORKFLOW_DEFINITION_ID] =
          seed.definition;
        genesis.entities.workflowDefinitions[SYSTEM_NOTE_WORKFLOW_DEFINITION_ID] =
          noteSeed.definition;
        genesis.entities.workflowDefinitions[SYSTEM_SIMPLE_PLANNING_WORKFLOW_DEFINITION_ID] =
          simpleSeed.definition;
        genesis.entities.workflowDefinitions[SYSTEM_MEMORY_PLANNING_WORKFLOW_DEFINITION_ID] =
          memorySeed.definition;
        genesis.entities.workflowDefinitions[SYSTEM_DIRECT_AGENT_WORKFLOW_DEFINITION_ID] =
          directSeed.definition;
        genesis.entities.workflowDefinitions[SYSTEM_MEMORY_DIRECT_WORKFLOW_DEFINITION_ID] =
          memoryDirectSeed.definition;
        genesis.entities.workflowDefinitions[SYSTEM_MEMORY_AGENT_DIRECT_WORKFLOW_DEFINITION_ID] =
          memoryAgentDirectSeed.definition;
        genesis.entities.workflowDefinitionRevisions[SYSTEM_PLANNING_WORKFLOW_REVISION_ID] =
          seed.revision;
        genesis.entities.workflowDefinitionRevisions[SYSTEM_NOTE_WORKFLOW_REVISION_ID] =
          noteSeed.revision;
        genesis.entities.workflowDefinitionRevisions[SYSTEM_SIMPLE_PLANNING_WORKFLOW_REVISION_ID] =
          simpleSeed.revision;
        genesis.entities.workflowDefinitionRevisions[SYSTEM_MEMORY_PLANNING_WORKFLOW_REVISION_ID] =
          memorySeed.revision;
        genesis.entities.workflowDefinitionRevisions[SYSTEM_DIRECT_AGENT_WORKFLOW_REVISION_ID] =
          directSeed.revision;
        genesis.entities.workflowDefinitionRevisions[SYSTEM_MEMORY_DIRECT_WORKFLOW_REVISION_ID] =
          memoryDirectSeed.revision;
        genesis.entities.workflowDefinitionRevisions[
          SYSTEM_MEMORY_AGENT_DIRECT_WORKFLOW_REVISION_ID
        ] = memoryAgentDirectSeed.revision;
        genesis.entities.workflowViewDefinitions[SYSTEM_PLANNING_WORKFLOW_VIEW_ID] = seed.view;
        genesis.entities.workflowViewDefinitions[SYSTEM_NOTE_WORKFLOW_VIEW_ID] = noteSeed.view;
        genesis.entities.workflowViewDefinitions[SYSTEM_SIMPLE_PLANNING_WORKFLOW_VIEW_ID] =
          simpleSeed.view;
        genesis.entities.workflowViewDefinitions[SYSTEM_MEMORY_PLANNING_WORKFLOW_VIEW_ID] =
          memorySeed.view;
        genesis.entities.workflowViewDefinitions[SYSTEM_DIRECT_AGENT_WORKFLOW_VIEW_ID] =
          directSeed.view;
        genesis.entities.workflowViewDefinitions[SYSTEM_MEMORY_DIRECT_WORKFLOW_VIEW_ID] =
          memoryDirectSeed.view;
        genesis.entities.workflowViewDefinitions[SYSTEM_MEMORY_AGENT_DIRECT_WORKFLOW_VIEW_ID] =
          memoryAgentDirectSeed.view;
        const store = new JsonProductStore(options, genesis);
        await store.persist(genesis);
        return store;
      }
      throw new StoreCorruptedError(
        `无法读取Product Store:${error instanceof Error ? error.message : String(error)}`,
      );
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      throw new StoreCorruptedError("Product Store不是合法JSON，已保留原文件");
    }
    const current = productSnapshotSchema.safeParse(parsedJson);
    if (current.success) {
      assertSnapshotIntegrity(current.data);
      return new JsonProductStore(options, current.data);
    }

    const migrated = migrateLegacySnapshot(parsedJson);
    assertSnapshotIntegrity(migrated);
    const store = new JsonProductStore(options, migrated);
    // 成功迁移使用与普通事务相同的原子替换；rename 前失败时旧文件逐字节不变。
    await store.persist(migrated);
    return store;
  }

  async read(_query: ProductReadRequest): Promise<ProductReadResult> {
    this.assertAvailable();
    // 不能把内部权威快照的可变引用交给Application；调用方只能修改自己的副本。
    return { snapshot: structuredClone(this.snapshot) };
  }

  transact(command: ProductTransaction): Promise<ProductTransactionResult> {
    // 单写队列：并发transact按到达顺序序列化，CAS失败者不能覆盖成功者
    const run = this.queue.then(() => this.doTransact(command));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async doTransact(command: ProductTransaction): Promise<ProductTransactionResult> {
    this.assertAvailable();
    const current = this.snapshot;
    const receipt = current.commandReceipts[command.commandId];
    if (receipt !== undefined) {
      if (
        receipt.requestSha256 === command.requestSha256 &&
        receipt.commandType === command.commandType
      ) {
        return {
          storeRevision: current.storeRevision,
          resultRefs: receipt.resultRefs,
          replayed: true,
        };
      }
      throw new CommandIdReusedError(command.commandId);
    }

    const startedAt = performance.now();
    const traceId = command.traceContext?.productRunId
      ? `tr_${command.traceContext.productRunId.slice(4)}`
      : `tr_${randomUUID().replaceAll("-", "")}`;
    const transactionType = command.commandType
      .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
      .toLowerCase();
    const traceBase = {
      traceId,
      spanId: `sp_${randomUUID().replaceAll("-", "")}`,
      transactionType,
      commandId: command.commandId,
      ...(command.traceContext?.productRunId !== undefined
        ? { productRunId: command.traceContext.productRunId }
        : {}),
      ...(command.traceContext?.productSessionId !== undefined
        ? { productSessionId: command.traceContext.productSessionId }
        : {}),
    };
    this.safeEmit({
      ...traceBase,
      level: "info",
      eventName: "product.transaction.started",
      outcome: "unknown",
    });

    try {
      const draft = structuredClone(current);
      const mutation = command.mutate(draft);
      for (const [agentVersionId, existing] of Object.entries(current.entities.agentVersions)) {
        const next = draft.entities.agentVersions[agentVersionId];
        if (next === undefined || !isDeepStrictEqual(next, existing)) {
          throw new ApplicationError({
            code: "internal_error",
            httpStatus: 500,
            message: `Agent Version是不可变事实，不能覆盖或删除（${agentVersionId}）`,
          });
        }
      }
      draft.storeRevision = current.storeRevision + 1;
      draft.committedAt = this.now();
      draft.commandReceipts[command.commandId] = {
        commandId: command.commandId,
        commandType: command.commandType,
        requestSha256: command.requestSha256,
        resultRefs: mutation.resultRefs,
        committedStoreRevision: draft.storeRevision,
        createdAt: draft.committedAt,
      };

      const parsed = productSnapshotSchema.safeParse(draft);
      if (!parsed.success) {
        // 用例产生了非法快照：这是内部缺陷，不写入、不替换内存
        const evidence = parsed.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join(".")}:${issue.code}`)
          .join(",");
        throw new ApplicationError({
          code: "internal_error",
          httpStatus: 500,
          message: `事务产生了非法产品快照，已放弃提交（${evidence}）`,
        });
      }
      assertSnapshotIntegrity(parsed.data);

      await this.persist(parsed.data);
      this.snapshot = parsed.data;
      this.safeEmit({
        ...traceBase,
        level: "info",
        eventName: "product.transaction.committed",
        outcome: "success",
        durationMs: Math.round(performance.now() - startedAt),
      });
      return {
        storeRevision: parsed.data.storeRevision,
        resultRefs: mutation.resultRefs,
        replayed: false,
      };
    } catch (error) {
      this.safeEmit({
        ...traceBase,
        level: "error",
        eventName: "product.transaction.failed",
        outcome: "failure",
        error: { code: stableErrorCode(error), type: safeErrorType(error) },
        durationMs: Math.round(performance.now() - startedAt),
      });
      throw error;
    }
  }

  private safeEmit(event: Parameters<TraceEmitter>[0]): void {
    try {
      this.trace?.(event);
    } catch {
      // Trace故障不能破坏产品事务；组合根的Trace Sink另有故障计数。
    }
  }

  /**
   * 原子替换正式文件。顺序：写临时文件 -> fsync临时文件 -> fsync父目录 ->
   * atomic rename -> fsync父目录。
   * rename前任何一步失败，旧正式文件逐字节不变。rename成功但最终目录fsync
   * 失败时磁盘结果已不可判定：当前Store立即熔断，禁止继续从旧内存提交；
   * 只能重新open并从正式文件恢复，避免下一次事务覆盖已经rename成功的事实。
   */
  private async persist(snapshot: ProductSnapshot): Promise<void> {
    const bytes = JSON.stringify(snapshot, null, 2);
    const tempPath = join(
      dirname(this.filePath),
      `.${basename(this.filePath)}.tmp-${randomUUID()}`,
    );
    let renamed = false;
    try {
      await this.io.writeTempFile(tempPath, bytes);
      await this.io.fsyncTempFile(tempPath);
      await this.io.fsyncParentDirectory(dirname(this.filePath));
      await this.io.renameTempFile(tempPath, this.filePath);
      renamed = true;
      await this.io.fsyncParentDirectory(dirname(this.filePath));
    } catch {
      if (renamed) {
        this.unavailable = new StoreCorruptedError(
          "Product Store在atomic rename后无法确认目录持久化，当前实例已熔断；必须重新打开后再继续",
        );
        throw this.unavailable;
      }
      throw new ApplicationError({
        code: "internal_error",
        httpStatus: 503,
        message: "Product Store提交在atomic rename前失败，可用同一commandId安全重试",
        retryable: true,
        recoveryAction: "retry_same_command",
      });
    }
  }

  private assertAvailable(): void {
    if (this.unavailable !== undefined) throw this.unavailable;
  }
}

function stableErrorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[a-z][a-z0-9_.-]{0,63}$/u.test(error.code)
  ) {
    return error.code;
  }
  return "internal_error";
}

function safeErrorType(error: unknown): string {
  return error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(error.name)
    ? error.name
    : "Error";
}

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
