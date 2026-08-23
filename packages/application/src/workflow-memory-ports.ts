import type {
  MemoryProviderDescriptor,
  MemoryWriteIntentId,
  PrincipalId,
  ProductRunId,
  ProductSessionId,
  WorkflowMemoryCategory,
} from "@chat/contracts";

export interface WorkflowMemoryProviderHealth {
  readonly status: "ready" | "unavailable";
  readonly errorCode?: string;
}

interface WorkflowMemoryQueryInputBase {
  readonly operationId: string;
  readonly principalId: PrincipalId;
  readonly query: string;
  readonly maxResults: number;
  readonly maxContextCharacters: number;
}

/** Workflow查询保留产品绑定；只读比较使用同一Port但只携带Provider中立namespace key。 */
export type WorkflowMemoryQueryInput = WorkflowMemoryQueryInputBase &
  (
    | {
        readonly productRunId: ProductRunId;
        readonly productSessionId: ProductSessionId;
      }
    | {
        readonly sessionKey: string;
      }
  );

export interface WorkflowMemoryQuerySection {
  readonly externalObjectIds: readonly string[];
  readonly title: string;
  readonly category: WorkflowMemoryCategory;
  readonly content: string;
  readonly labels: readonly string[];
  readonly score?: number | undefined;
  readonly sourceUpdatedAt?: string | undefined;
}

export interface WorkflowMemoryQueryOutput {
  readonly externalQueryId: string;
  readonly hitCount: number;
  readonly sections: readonly WorkflowMemoryQuerySection[];
}

interface WorkflowMemoryWriteInputBase {
  readonly operationId: MemoryWriteIntentId;
  readonly requestSha256: string;
  readonly content: string;
  readonly contentType: "conversation_turn";
  readonly principalId: PrincipalId;
}

/** v1 Message写入形状为历史Workflow bundle保留；新Session导入使用通用稳定键。 */
export type WorkflowMemoryWriteInput = WorkflowMemoryWriteInputBase &
  (
    | {
        readonly productSessionId: ProductSessionId;
        readonly sourceMessageId: string;
      }
    | {
        /** Provider命名空间；普通Message保持psn_*，Codex导入使用稳定codex-session:*。 */
        readonly sessionKey: string;
        /** Provider幂等turn身份；普通Message保持msg_*。 */
        readonly turnKey: string;
      }
  );

export interface WorkflowMemoryWriteAccepted {
  readonly externalObjectId: string;
  readonly externalObjectVersion?: string;
  readonly externalStatus?: string;
  readonly responseSha256: string;
}

export type WorkflowMemoryWriteReconcileOutput =
  | { readonly status: "accepted"; readonly accepted: WorkflowMemoryWriteAccepted }
  | {
      readonly status: "materialized";
      readonly accepted: WorkflowMemoryWriteAccepted;
      readonly verificationKind: string;
      readonly verificationSha256: string;
    }
  | { readonly status: "failed"; readonly errorCode: string; readonly summary: string }
  | { readonly status: "outcome_unknown"; readonly errorCode: string };

export type WorkflowMemoryWriteReconcileInput = WorkflowMemoryWriteInput & {
  readonly externalObjectId?: string;
};

/** 查询能力可单独存在；一个Provider不需要为了注册而伪造写入能力。 */
export interface WorkflowMemoryQueryProviderPort {
  describeProvider(): MemoryProviderDescriptor;
  health(): Promise<WorkflowMemoryProviderHealth>;
  queryMemory(input: WorkflowMemoryQueryInput): Promise<WorkflowMemoryQueryOutput>;
}

/** 写入与查询分Port，强制调用方处理结果未知和只读对账。 */
export interface WorkflowMemoryWriteProviderPort {
  describeProvider(): MemoryProviderDescriptor;
  writeMemory(input: WorkflowMemoryWriteInput): Promise<WorkflowMemoryWriteAccepted>;
  reconcileMemoryWrite(
    input: WorkflowMemoryWriteReconcileInput,
  ): Promise<WorkflowMemoryWriteReconcileOutput>;
}

export interface WorkflowMemoryProviderRegistryPort {
  list(): readonly MemoryProviderDescriptor[];
  getQuery(providerId: string): WorkflowMemoryQueryProviderPort | undefined;
  getWrite(providerId: string): WorkflowMemoryWriteProviderPort | undefined;
}

export class WorkflowMemoryProviderError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(input: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  }) {
    super(input.message);
    this.name = "WorkflowMemoryProviderError";
    this.code = input.code;
    this.retryable = input.retryable;
  }
}

export type WorkflowMemoryWriteFailurePhase =
  "before_external_call" | "rejected_before_write" | "write_outcome_unknown";

export class WorkflowMemoryWriteProviderError extends Error {
  readonly code: string;
  readonly phase: WorkflowMemoryWriteFailurePhase;
  constructor(input: {
    readonly code: string;
    readonly message: string;
    readonly phase: WorkflowMemoryWriteFailurePhase;
  }) {
    super(input.message);
    this.name = "WorkflowMemoryWriteProviderError";
    this.code = input.code;
    this.phase = input.phase;
  }
}
