import type { CommandId, ProductSnapshot } from "@chat/contracts";

/**
 * Product Store Port（任务书§10）。
 *
 * 语义：
 * - API进程是Product Store的唯一Owner和唯一写者；实现可以是单实例JSON
 *   （当前）或未来的数据库，调用方不感知物理形态。
 * - transact把"产品事实 + Command Receipt + Outbox"作为一次原子提交；
 *   任一步失败，调用方看到稳定错误，已提交状态逐字节不变。
 * - mutate是纯函数：只在克隆draft上应用变更，不进行IO、不读全局时间/随机；
 *   同一commandId重放被Receipt短路，mutate不会第二次运行。
 */
export interface ProductStorePort {
  read(query: ProductReadRequest): Promise<ProductReadResult>;
  transact(command: ProductTransaction): Promise<ProductTransactionResult>;
}

/**
 * 当前唯一读语义：读取已提交快照。数据量小，Application在内存中构建索引；
 * 未来数据库实现必须保持同等语义，不得把选择性读暴露成新事实源。
 */
export interface ProductReadRequest {
  readonly kind: "committedSnapshot";
}

export interface ProductReadResult {
  readonly snapshot: Readonly<ProductSnapshot>;
}

export interface ProductTransaction {
  readonly commandId: CommandId;
  readonly commandType: string;
  /** canonical JSON SHA-256；同一commandId不同Hash返回COMMAND_ID_REUSED。 */
  readonly requestSha256: string;
  readonly mutate: (draft: ProductSnapshot) => ProductMutationResult;
}

export interface ProductMutationResult {
  /** 重建原响应所需的产品对象引用，随Receipt持久化。 */
  readonly resultRefs: Record<string, string>;
}

export interface ProductTransactionResult {
  readonly storeRevision: number;
  readonly resultRefs: Record<string, string>;
  /** true表示本次调用命中幂等Receipt，没有再次执行mutate。 */
  readonly replayed: boolean;
}
