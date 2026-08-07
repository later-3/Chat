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
} from "@chat/application";
import { assertSnapshotIntegrity } from "./snapshot-integrity.js";

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
  /** 失败注入点；生产必须缺省。 */
  readonly io?: Partial<StoreIo>;
}

export class JsonProductStore implements ProductStorePort {
  private readonly filePath: string;
  private readonly now: () => string;
  private readonly io: StoreIo;
  private snapshot: ProductSnapshot;
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(options: JsonProductStoreOptions, snapshot: ProductSnapshot) {
    this.filePath = options.filePath;
    this.now = options.now;
    this.io = { ...defaultIo, ...options.io };
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
    const parsed = productSnapshotSchema.safeParse(parsedJson);
    if (!parsed.success) {
      throw new StoreCorruptedError("Product Store Schema未知或非法，已保留原文件");
    }
    assertSnapshotIntegrity(parsed.data);
    return new JsonProductStore(options, parsed.data);
  }

  read(_query: ProductReadRequest): Promise<ProductReadResult> {
    return Promise.resolve({ snapshot: this.snapshot });
  }

  transact(command: ProductTransaction): Promise<ProductTransactionResult> {
    // 单写队列：并发transact按到达顺序序列化，CAS失败者不能覆盖成功者
    const run = this.queue.then(() => this.doTransact(command));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async doTransact(command: ProductTransaction): Promise<ProductTransactionResult> {
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
      throw new ApplicationError({
        code: "internal_error",
        httpStatus: 500,
        message: "事务产生了非法产品快照，已放弃提交",
      });
    }
    assertSnapshotIntegrity(parsed.data);

    await this.persist(parsed.data);
    this.snapshot = parsed.data;
    return {
      storeRevision: parsed.data.storeRevision,
      resultRefs: mutation.resultRefs,
      replayed: false,
    };
  }

  /**
   * 原子替换正式文件。顺序：写临时文件 -> fsync临时文件 -> fsync父目录 ->
   * atomic rename -> fsync父目录。
   * rename前任何一步失败，旧正式文件逐字节不变；rename后目录fsync失败时
   * 内存仍指向旧快照，下次open从正式文件恢复，不依赖内存状态。
   */
  private async persist(snapshot: ProductSnapshot): Promise<void> {
    const bytes = JSON.stringify(snapshot, null, 2);
    const tempPath = join(
      dirname(this.filePath),
      `.${basename(this.filePath)}.tmp-${randomUUID()}`,
    );
    await this.io.writeTempFile(tempPath, bytes);
    await this.io.fsyncTempFile(tempPath);
    await this.io.fsyncParentDirectory(dirname(this.filePath));
    await this.io.renameTempFile(tempPath, this.filePath);
    await this.io.fsyncParentDirectory(dirname(this.filePath));
  }
}

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
