import { open, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
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
import { assertSnapshotIntegrity } from "./snapshot-integrity.js";
import { migrateProductSnapshotV1ToV2, productSnapshotV1Schema } from "./migrate-v1-to-v2.js";
import { migrateProductSnapshotV2ToV3, productSnapshotV2Schema } from "./migrate-v2-to-v3.js";
import { migrateProductSnapshotV3ToV4, productSnapshotV3Schema } from "./migrate-v3-to-v4.js";
import { productSnapshotV4Schema } from "./legacy-v4.js";
import { productSnapshotV5Schema } from "./legacy-v5.js";
import { migrateProductSnapshotV4ToV5 } from "./migrate-v4-to-v5.js";
import { migrateProductSnapshotV5ToV6 } from "./migrate-v5-to-v6.js";

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

    const legacyV5 = productSnapshotV5Schema.safeParse(parsedJson);
    let v5;
    if (legacyV5.success) {
      v5 = legacyV5.data;
    } else {
      const legacyV4 = productSnapshotV4Schema.safeParse(parsedJson);
      let v4;
      if (legacyV4.success) {
        v4 = legacyV4.data;
      } else {
        const legacyV3 = productSnapshotV3Schema.safeParse(parsedJson);
        let v3;
        if (legacyV3.success) {
          v3 = legacyV3.data;
        } else {
          const legacyV2 = productSnapshotV2Schema.safeParse(parsedJson);
          let v2;
          if (legacyV2.success) {
            v2 = legacyV2.data;
          } else {
            const legacyV1 = productSnapshotV1Schema.safeParse(parsedJson);
            if (!legacyV1.success) {
              throw new StoreCorruptedError("Product Store Schema未知或非法，已保留原文件");
            }
            v2 = migrateProductSnapshotV1ToV2(legacyV1.data);
          }
          v3 = migrateProductSnapshotV2ToV3(v2);
        }
        v4 = migrateProductSnapshotV3ToV4(v3);
      }
      v5 = migrateProductSnapshotV4ToV5(v4);
    }
    const migrated = migrateProductSnapshotV5ToV6(v5);
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
