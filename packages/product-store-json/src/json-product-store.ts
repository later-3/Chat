import { open, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createEmptySnapshot, productSnapshotSchema, type ProductSnapshot } from "@chat/contracts";
import {
  ApplicationError,
  StoreCorruptedError,
  exactCommandReceipt,
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
  createSystemMemoryDirectDefinition,
  createSystemMemoryAgentDirectDefinition,
  createSystemMemoryReadDirectDefinition,
  createSystemMemoryWriteDirectDefinition,
  createSystemNoteDefinition,
  createSystemDirectAgentDefinition,
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
  SYSTEM_MEMORY_READ_DIRECT_WORKFLOW_DEFINITION_ID,
  SYSTEM_MEMORY_READ_DIRECT_WORKFLOW_REVISION_ID,
  SYSTEM_MEMORY_READ_DIRECT_WORKFLOW_VIEW_ID,
  SYSTEM_MEMORY_WRITE_DIRECT_WORKFLOW_DEFINITION_ID,
  SYSTEM_MEMORY_WRITE_DIRECT_WORKFLOW_REVISION_ID,
  SYSTEM_MEMORY_WRITE_DIRECT_WORKFLOW_VIEW_ID,
} from "@chat/application/workflow-system-definitions";
import {
  assertSupervisedAgentAttemptTransitionV3,
  assertSupervisedStepReviewRequestTransitionV3,
} from "@chat/domain";
import { assertSnapshotIntegrity } from "./snapshot-integrity.js";
import { migrateProductSnapshotV1ToV2, productSnapshotV1Schema } from "./migrate-v1-to-v2.js";
import { migrateProductSnapshotV2ToV3, productSnapshotV2Schema } from "./migrate-v2-to-v3.js";
import {
  migrateProductSnapshotV3ToV4,
  productSnapshotV3Schema,
} from "./internal-compat/migrate-v3-to-v4.js";
import { productSnapshotV4Schema } from "./internal-compat/legacy-v4.js";
import { productSnapshotV5Schema } from "./internal-compat/legacy-v5.js";
import { productSnapshotV6Schema, type ProductSnapshotV6 } from "./internal-compat/legacy-v6.js";
import { productSnapshotV7Schema, type ProductSnapshotV7 } from "./internal-compat/legacy-v7.js";
import { productSnapshotV8Schema, type ProductSnapshotV8 } from "./internal-compat/legacy-v8.js";
import { productSnapshotV9Schema, type ProductSnapshotV9 } from "./internal-compat/legacy-v9.js";
import { productSnapshotV10Schema, type ProductSnapshotV10 } from "./internal-compat/legacy-v10.js";
import { productSnapshotV11Schema, type ProductSnapshotV11 } from "./internal-compat/legacy-v11.js";
import { productSnapshotV12Schema, type ProductSnapshotV12 } from "./internal-compat/legacy-v12.js";
import { productSnapshotV13Schema, type ProductSnapshotV13 } from "./internal-compat/legacy-v13.js";
import { productSnapshotV14Schema, type ProductSnapshotV14 } from "./internal-compat/legacy-v14.js";
import {
  productSnapshotV15Schema,
  type ProductSnapshotV15,
} from "./internal-compat/legacy-v15-reader.js";
import {
  productSnapshotV16Schema,
  type ProductSnapshotV16,
} from "./internal-compat/legacy-v16-reader.js";
import {
  productSnapshotV17Schema,
  type ProductSnapshotV17,
} from "./internal-compat/legacy-v17-reader.js";
import { productSnapshotV18Schema } from "./internal-compat/legacy-v18-reader.js";
import { productSnapshotV19Schema } from "./internal-compat/legacy-v19-base.js";
import { productSnapshotV20Schema } from "./legacy-v20.js";
import { productSnapshotV20CapabilitySchema } from "./internal-compat/legacy-v20-capability-reader.js";
import { productSnapshotV21Schema } from "./legacy-v21.js";
import { productSnapshotV22Schema } from "./legacy-v22.js";
import { productSnapshotV23Schema, type ProductSnapshotV23 } from "./legacy-v23.js";
import { productSnapshotV24Schema } from "./legacy-v24.js";
import { productSnapshotV25Schema } from "./legacy-v25.js";
import { migrateProductSnapshotV4ToV5 } from "./internal-compat/migrate-v4-to-v5.js";
import { migrateProductSnapshotV5ToV6 } from "./internal-compat/migrate-v5-to-v6.js";
import { migrateProductSnapshotV6ToV7 } from "./internal-compat/migrate-v6-to-v7.js";
import { migrateProductSnapshotV7ToV8 } from "./internal-compat/migrate-v7-to-v8.js";
import { migrateProductSnapshotV8ToV9 } from "./internal-compat/migrate-v8-to-v9.js";
import { migrateProductSnapshotV9ToV10 } from "./internal-compat/migrate-v9-to-v10.js";
import { migrateProductSnapshotV10ToV11 } from "./internal-compat/migrate-v10-to-v11.js";
import { migrateProductSnapshotV11ToV12 } from "./internal-compat/migrate-v11-to-v12.js";
import { migrateProductSnapshotV12ToV13 } from "./internal-compat/migrate-v12-to-v13.js";
import { migrateProductSnapshotV13ToV14 } from "./internal-compat/migrate-v13-to-v14.js";
import { migrateProductSnapshotV14ToV15 } from "./internal-compat/migrate-v14-to-v15.js";
import {
  migrateProductSnapshotV15ToV16,
  migrateProductSnapshotV16ToV17,
  migrateProductSnapshotV17ToV18,
  migrateProductSnapshotV18ToV19,
  migrateProductSnapshotV19ToV20,
} from "./internal-compat/migrations-v15-v20.js";
import { migrateProductSnapshotV20ToV21 } from "./migrate-v20-to-v21.js";
import { migrateProductSnapshotV20CapabilityToV22 } from "./migrate-v20-capability-to-v22.js";
import { migrateProductSnapshotV21ToV22 } from "./migrate-v21-to-v22.js";
import { migrateProductSnapshotV22ToV23 } from "./migrate-v22-to-v23.js";
import { migrateProductSnapshotV23ToV24 } from "./migrate-v23-to-v24.js";
import { migrateProductSnapshotV24ToV25 } from "./migrate-v24-to-v25.js";
import { migrateProductSnapshotV25ToV26 } from "./migrate-v25-to-v26.js";

function migrateProductSnapshotV23ToCurrent(snapshot: ProductSnapshotV23): ProductSnapshot {
  return migrateProductSnapshotV25ToV26(
    migrateProductSnapshotV24ToV25(migrateProductSnapshotV23ToV24(snapshot)),
  );
}

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
        const seed = createSystemPlanningDefinition(genesis.committedAt);
        const simpleSeed = createSystemSimplePlanningDefinition(genesis.committedAt);
        const memorySeed = createSystemMemoryPlanningDefinition(genesis.committedAt);
        const noteSeed = createSystemNoteDefinition(genesis.committedAt);
        const directSeed = createSystemDirectAgentDefinition(genesis.committedAt);
        const memoryDirectSeed = createSystemMemoryDirectDefinition(genesis.committedAt);
        const memoryAgentDirectSeed = createSystemMemoryAgentDirectDefinition(genesis.committedAt);
        const memoryReadDirectSeed = createSystemMemoryReadDirectDefinition(genesis.committedAt);
        const memoryWriteDirectSeed = createSystemMemoryWriteDirectDefinition(genesis.committedAt);
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
        genesis.entities.workflowDefinitions[SYSTEM_MEMORY_READ_DIRECT_WORKFLOW_DEFINITION_ID] =
          memoryReadDirectSeed.definition;
        genesis.entities.workflowDefinitions[SYSTEM_MEMORY_WRITE_DIRECT_WORKFLOW_DEFINITION_ID] =
          memoryWriteDirectSeed.definition;
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
        genesis.entities.workflowDefinitionRevisions[
          SYSTEM_MEMORY_READ_DIRECT_WORKFLOW_REVISION_ID
        ] = memoryReadDirectSeed.revision;
        genesis.entities.workflowDefinitionRevisions[
          SYSTEM_MEMORY_WRITE_DIRECT_WORKFLOW_REVISION_ID
        ] = memoryWriteDirectSeed.revision;
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
        genesis.entities.workflowViewDefinitions[SYSTEM_MEMORY_READ_DIRECT_WORKFLOW_VIEW_ID] =
          memoryReadDirectSeed.view;
        genesis.entities.workflowViewDefinitions[SYSTEM_MEMORY_WRITE_DIRECT_WORKFLOW_VIEW_ID] =
          memoryWriteDirectSeed.view;
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

    const legacyV25 = productSnapshotV25Schema.safeParse(parsedJson);
    if (legacyV25.success) {
      const migrated = migrateProductSnapshotV25ToV26(legacyV25.data);
      assertSnapshotIntegrity(migrated);
      const store = new JsonProductStore(options, migrated);
      await store.persist(migrated);
      return store;
    }

    const legacyV24 = productSnapshotV24Schema.safeParse(parsedJson);
    if (legacyV24.success) {
      const migrated = migrateProductSnapshotV25ToV26(
        migrateProductSnapshotV24ToV25(legacyV24.data),
      );
      assertSnapshotIntegrity(migrated);
      const store = new JsonProductStore(options, migrated);
      await store.persist(migrated);
      return store;
    }

    const legacyV23 = productSnapshotV23Schema.safeParse(parsedJson);
    if (legacyV23.success) {
      const migrated = migrateProductSnapshotV23ToCurrent(legacyV23.data);
      assertSnapshotIntegrity(migrated);
      const store = new JsonProductStore(options, migrated);
      await store.persist(migrated);
      return store;
    }

    const legacyV22 = productSnapshotV22Schema.safeParse(parsedJson);
    if (legacyV22.success) {
      const migrated = migrateProductSnapshotV23ToCurrent(
        migrateProductSnapshotV22ToV23(legacyV22.data),
      );
      assertSnapshotIntegrity(migrated);
      const store = new JsonProductStore(options, migrated);
      await store.persist(migrated);
      return store;
    }

    const legacyV21 = productSnapshotV21Schema.safeParse(parsedJson);
    if (legacyV21.success) {
      const migrated = migrateProductSnapshotV23ToCurrent(
        migrateProductSnapshotV22ToV23(migrateProductSnapshotV21ToV22(legacyV21.data)),
      );
      assertSnapshotIntegrity(migrated);
      const store = new JsonProductStore(options, migrated);
      await store.persist(migrated);
      return store;
    }

    const legacyV20Capability = productSnapshotV20CapabilitySchema.safeParse(parsedJson);
    if (legacyV20Capability.success) {
      const migrated = migrateProductSnapshotV23ToCurrent(
        migrateProductSnapshotV22ToV23(
          migrateProductSnapshotV20CapabilityToV22(legacyV20Capability.data),
        ),
      );
      assertSnapshotIntegrity(migrated);
      const store = new JsonProductStore(options, migrated);
      await store.persist(migrated);
      return store;
    }

    const legacyV20 = productSnapshotV20Schema.safeParse(parsedJson);
    if (legacyV20.success) {
      const migrated = migrateProductSnapshotV23ToCurrent(
        migrateProductSnapshotV22ToV23(
          migrateProductSnapshotV21ToV22(migrateProductSnapshotV20ToV21(legacyV20.data)),
        ),
      );
      assertSnapshotIntegrity(migrated);
      const store = new JsonProductStore(options, migrated);
      await store.persist(migrated);
      return store;
    }

    const legacyV19 = productSnapshotV19Schema.safeParse(parsedJson);
    if (legacyV19.success) {
      const migrated = migrateProductSnapshotV23ToCurrent(
        migrateProductSnapshotV22ToV23(
          migrateProductSnapshotV21ToV22(
            migrateProductSnapshotV20ToV21(migrateProductSnapshotV19ToV20(legacyV19.data)),
          ),
        ),
      );
      assertSnapshotIntegrity(migrated);
      const store = new JsonProductStore(options, migrated);
      await store.persist(migrated);
      return store;
    }

    const legacyV18 = productSnapshotV18Schema.safeParse(parsedJson);
    if (legacyV18.success) {
      const migrated = migrateProductSnapshotV23ToCurrent(
        migrateProductSnapshotV22ToV23(
          migrateProductSnapshotV21ToV22(
            migrateProductSnapshotV20ToV21(
              migrateProductSnapshotV19ToV20(migrateProductSnapshotV18ToV19(legacyV18.data)),
            ),
          ),
        ),
      );
      assertSnapshotIntegrity(migrated);
      const store = new JsonProductStore(options, migrated);
      await store.persist(migrated);
      return store;
    }

    const legacyV17 = productSnapshotV17Schema.safeParse(parsedJson);
    let v17: ProductSnapshotV17;
    if (legacyV17.success) {
      v17 = legacyV17.data;
    } else {
      const legacyV16 = productSnapshotV16Schema.safeParse(parsedJson);
      let v16: ProductSnapshotV16;
      if (legacyV16.success) {
        v16 = legacyV16.data;
      } else {
        const legacyV15 = productSnapshotV15Schema.safeParse(parsedJson);
        let v15: ProductSnapshotV15;
        if (legacyV15.success) {
          v15 = legacyV15.data;
        } else {
          const legacyV14 = productSnapshotV14Schema.safeParse(parsedJson);
          let v14: ProductSnapshotV14;
          if (legacyV14.success) {
            v14 = legacyV14.data;
          } else {
            const legacyV13 = productSnapshotV13Schema.safeParse(parsedJson);
            let v13: ProductSnapshotV13;
            if (legacyV13.success) {
              v13 = legacyV13.data;
            } else {
              const legacyV12 = productSnapshotV12Schema.safeParse(parsedJson);
              let v12: ProductSnapshotV12;
              if (legacyV12.success) {
                v12 = legacyV12.data;
              } else {
                const legacyV11 = productSnapshotV11Schema.safeParse(parsedJson);
                let v11: ProductSnapshotV11;
                if (legacyV11.success) {
                  v11 = legacyV11.data;
                } else {
                  const legacyV10 = productSnapshotV10Schema.safeParse(parsedJson);
                  let v10: ProductSnapshotV10;
                  if (legacyV10.success) {
                    v10 = legacyV10.data;
                  } else {
                    const legacyV9 = productSnapshotV9Schema.safeParse(parsedJson);
                    let v9: ProductSnapshotV9;
                    if (legacyV9.success) {
                      v9 = legacyV9.data;
                    } else {
                      const legacyV8 = productSnapshotV8Schema.safeParse(parsedJson);
                      let v8: ProductSnapshotV8;
                      if (legacyV8.success) {
                        v8 = legacyV8.data;
                      } else {
                        const legacyV7 = productSnapshotV7Schema.safeParse(parsedJson);
                        let v7: ProductSnapshotV7;
                        if (legacyV7.success) {
                          v7 = legacyV7.data;
                        } else {
                          const legacyV6 = productSnapshotV6Schema.safeParse(parsedJson);
                          let v6: ProductSnapshotV6;
                          if (legacyV6.success) {
                            v6 = legacyV6.data;
                          } else {
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
                                      throw new StoreCorruptedError(
                                        "Product Store Schema未知或非法，已保留原文件",
                                      );
                                    }
                                    v2 = migrateProductSnapshotV1ToV2(legacyV1.data);
                                  }
                                  v3 = migrateProductSnapshotV2ToV3(v2);
                                }
                                v4 = migrateProductSnapshotV3ToV4(v3);
                              }
                              v5 = migrateProductSnapshotV4ToV5(v4);
                            }
                            v6 = migrateProductSnapshotV5ToV6(v5);
                          }
                          v7 = migrateProductSnapshotV6ToV7(v6);
                        }
                        v8 = productSnapshotV8Schema.parse(migrateProductSnapshotV7ToV8(v7));
                      }
                      v9 = migrateProductSnapshotV8ToV9(v8);
                    }
                    v10 = productSnapshotV10Schema.parse(migrateProductSnapshotV9ToV10(v9));
                  }
                  v11 = migrateProductSnapshotV10ToV11(v10);
                }
                v12 = migrateProductSnapshotV11ToV12(v11);
              }
              v13 = migrateProductSnapshotV12ToV13(v12);
            }
            v14 = migrateProductSnapshotV13ToV14(v13);
          }
          v15 = migrateProductSnapshotV14ToV15(v14);
        }
        v16 = migrateProductSnapshotV15ToV16(v15);
      }
      v17 = migrateProductSnapshotV16ToV17(v16);
    }
    const migrated = migrateProductSnapshotV23ToCurrent(
      migrateProductSnapshotV22ToV23(
        migrateProductSnapshotV21ToV22(
          migrateProductSnapshotV20ToV21(
            migrateProductSnapshotV19ToV20(
              migrateProductSnapshotV18ToV19(migrateProductSnapshotV17ToV18(v17)),
            ),
          ),
        ),
      ),
    );
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
    const receipt = exactCommandReceipt(current, command);
    if (receipt !== undefined) {
      return {
        storeRevision: current.storeRevision,
        resultRefs: receipt.resultRefs,
        replayed: true,
      };
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
      for (const [attemptId, existing] of Object.entries(
        current.entities.supervisedAgentAttempts,
      )) {
        const next = draft.entities.supervisedAgentAttempts[attemptId];
        if (next === undefined) {
          throw new ApplicationError({
            code: "internal_error",
            httpStatus: 500,
            message: `监督Agent Attempt不能删除（${attemptId}）`,
          });
        }
        if (!isDeepStrictEqual(next, existing)) {
          try {
            assertSupervisedAgentAttemptTransitionV3(existing, next);
          } catch (error) {
            throw new ApplicationError({
              code: "internal_error",
              httpStatus: 500,
              message: `监督Agent Attempt非法收敛（${attemptId}）：${error instanceof Error ? error.message : String(error)}`,
            });
          }
        }
      }
      for (const [attemptId, attempt] of Object.entries(draft.entities.supervisedAgentAttempts)) {
        if (
          current.entities.supervisedAgentAttempts[attemptId] === undefined &&
          (attempt.outcome !== "running" || attempt.revision !== 1)
        ) {
          throw new ApplicationError({
            code: "internal_error",
            httpStatus: 500,
            message: `监督Agent Attempt必须从running@1创建（${attemptId}）`,
          });
        }
      }
      for (const [reviewId, existing] of Object.entries(
        current.entities.supervisedStepReviewRequests,
      )) {
        const next = draft.entities.supervisedStepReviewRequests[reviewId];
        if (next === undefined) {
          throw new ApplicationError({
            code: "internal_error",
            httpStatus: 500,
            message: `监督Product Review不能删除（${reviewId}）`,
          });
        }
        if (!isDeepStrictEqual(next, existing)) {
          try {
            assertSupervisedStepReviewRequestTransitionV3(existing, next);
          } catch (error) {
            throw new ApplicationError({
              code: "internal_error",
              httpStatus: 500,
              message: `监督Product Review非法收敛（${reviewId}）：${error instanceof Error ? error.message : String(error)}`,
            });
          }
        }
      }
      for (const [reviewId, review] of Object.entries(
        draft.entities.supervisedStepReviewRequests,
      )) {
        if (
          current.entities.supervisedStepReviewRequests[reviewId] === undefined &&
          (review.decisionState.status !== "open" || review.revision !== 1)
        ) {
          throw new ApplicationError({
            code: "internal_error",
            httpStatus: 500,
            message: `监督Product Review必须从open@1创建（${reviewId}）`,
          });
        }
      }
      const immutableProjectCollections = [
        ["Project Event", current.entities.projectEvents, draft.entities.projectEvents],
        [
          "Project Metric Observation",
          current.entities.projectMetricObservations,
          draft.entities.projectMetricObservations,
        ],
        [
          "Supervised Planning Epoch",
          current.entities.supervisedPlanningEpochs,
          draft.entities.supervisedPlanningEpochs,
        ],
        [
          "Supervised Carry Forward",
          current.entities.supervisedCarryForwards,
          draft.entities.supervisedCarryForwards,
        ],
        [
          "Supervised Step State Version",
          current.entities.supervisedStepStates,
          draft.entities.supervisedStepStates,
        ],
        [
          "Supervised Step Evidence",
          current.entities.supervisedStepEvidence,
          draft.entities.supervisedStepEvidence,
        ],
        [
          "Supervised Step Candidate",
          current.entities.supervisedStepCandidates,
          draft.entities.supervisedStepCandidates,
        ],
        [
          "Supervised Reviewer Verdict",
          current.entities.supervisedPlannerVerdicts,
          draft.entities.supervisedPlannerVerdicts,
        ],
        [
          "Supervised Product Decision",
          current.entities.supervisedStepHumanDecisions,
          draft.entities.supervisedStepHumanDecisions,
        ],
        [
          "Supervised Outcome Observation",
          current.entities.supervisedAgentOutcomeObservations,
          draft.entities.supervisedAgentOutcomeObservations,
        ],
        [
          "Supervised Execution Result",
          current.entities.supervisedExecutionResults,
          draft.entities.supervisedExecutionResults,
        ],
      ] as const;
      for (const [label, existingFacts, nextFacts] of immutableProjectCollections) {
        for (const [factId, existing] of Object.entries(existingFacts)) {
          const next = (nextFacts as Readonly<Record<string, unknown>>)[factId];
          if (next === undefined || !isDeepStrictEqual(next, existing)) {
            throw new ApplicationError({
              code: "internal_error",
              httpStatus: 500,
              message: `${label}是不可变历史事实，不能覆盖或删除（${factId}）`,
            });
          }
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
