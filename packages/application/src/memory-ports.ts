import type { MemoryBackendId, MemoryLayer, ProductRunId, ProductSessionId } from "@chat/contracts";

/** 进程内部的安全能力说明；不包含 endpoint、Token 或 namespace 映射。 */
interface MemoryBackendProfileBase {
  readonly backendId: MemoryBackendId;
  readonly displayName: string;
  readonly kind: "memmy";
  readonly adapterContractVersion: "memmy-http-query.v1";
  readonly configurationFingerprint: string;
  readonly configured: boolean;
  readonly capabilities: {
    readonly query: true;
    readonly tags: true;
    readonly layers: readonly MemoryLayer[];
    readonly maxLimit: number;
    readonly maxContextBudget: number;
  };
}

/** 认证模式与非秘密keyId/revision必须同步；它不是Token的Hash。 */
export type MemoryBackendProfile = MemoryBackendProfileBase &
  (
    | { readonly authMode: "none"; readonly credentialRevision: "none" }
    | { readonly authMode: "bearer"; readonly credentialRevision: string }
  );

export interface MemoryBackendHealth {
  readonly status: "ready" | "unavailable";
  readonly errorCode?: string;
}

export interface MemoryQueryInput {
  readonly operationId: string;
  readonly productRunId: ProductRunId;
  readonly productSessionId: ProductSessionId;
  readonly query: string;
  readonly tags: readonly string[];
  readonly layers: readonly MemoryLayer[];
  readonly limit: number;
  readonly contextBudget: number;
}

export interface MemoryQuerySection {
  readonly externalObjectIds: readonly string[];
  readonly title: string;
  readonly kind: "trace" | "span" | "policy" | "world_model" | "skill";
  readonly memoryLayer: MemoryLayer;
  readonly content: string;
  readonly tags: readonly string[];
  readonly score?: number | undefined;
  readonly tokenEstimate?: number | undefined;
  readonly sourceUpdatedAt?: string | undefined;
}

export interface MemoryQueryOutput {
  readonly externalQueryId: string;
  readonly hitCount: number;
  readonly tokenEstimate?: number;
  readonly sections: readonly MemoryQuerySection[];
}

/**
 * Memory Adapter 的最小查询 Port。
 * M1 只冻结两个真实后端共同需要的查询语义；M2 再以独立副作用 Port 增加 import。
 */
export interface MemoryBackendPort {
  describe(): MemoryBackendProfile;
  health(): Promise<MemoryBackendHealth>;
  query(input: MemoryQueryInput): Promise<MemoryQueryOutput>;
}

export interface MemoryBackendRegistryPort {
  list(): readonly MemoryBackendPort[];
  get(backendId: MemoryBackendId): MemoryBackendPort | undefined;
}

/** Adapter 只抛稳定错误；外部响应正文和底层异常不跨过 Port。 */
export class MemoryBackendError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(options: { code: string; message: string; retryable: boolean }) {
    super(options.message);
    this.name = "MemoryBackendError";
    this.code = options.code;
    this.retryable = options.retryable;
  }
}
