import type {
  MemoryBackendId,
  MemoryImportBackendDescriptor,
  MemoryImportCapabilities,
  MemoryImportIntentId,
  ProductSessionId,
} from "@chat/contracts";

export interface MemoryImportBackendProfile {
  readonly descriptor: MemoryImportBackendDescriptor;
}

export interface MemoryImportInput {
  readonly operationId: MemoryImportIntentId;
  readonly requestSha256: string;
  readonly content: string;
  readonly layer: "L0" | "L2";
  readonly title: string;
  readonly tags: readonly string[];
  readonly source: "chat.explicit_import";
  readonly sessionId: ProductSessionId;
  readonly turnId: string;
}

export interface MemoryImportAccepted {
  readonly externalObjectId: string;
  readonly externalObjectVersion?: string;
  readonly externalStatus?: string;
  readonly responseSha256: string;
}

export type MemoryImportReconcileOutput =
  | { readonly status: "accepted"; readonly accepted: MemoryImportAccepted }
  | {
      readonly status: "materialized";
      readonly accepted: MemoryImportAccepted;
      readonly verificationKind: "read_by_id" | "read_by_id_and_search" | "l0_and_session_l1";
      readonly verificationSha256: string;
    }
  | { readonly status: "failed"; readonly errorCode: string; readonly summary: string }
  | { readonly status: "outcome_unknown"; readonly errorCode: string };

export interface MemoryImportReconcileInput extends MemoryImportInput {
  readonly externalObjectId?: string;
}

/** 查询与导入故意分Port：后者跨越外部副作用边界，具有结果未知语义。 */
export interface MemoryImportBackendPort {
  describeImport(): MemoryImportBackendProfile;
  import(input: MemoryImportInput): Promise<MemoryImportAccepted>;
  reconcile(input: MemoryImportReconcileInput): Promise<MemoryImportReconcileOutput>;
}

export interface MemoryImportBackendRegistryPort {
  list(): readonly MemoryImportBackendPort[];
  get(backendId: MemoryBackendId): MemoryImportBackendPort | undefined;
}

export type MemoryImportFailurePhase =
  "before_external_call" | "rejected_before_write" | "write_outcome_unknown";

/** Adapter不得把fetch Response、外部正文或底层Stack跨过Port。 */
export class MemoryImportBackendError extends Error {
  readonly code: string;
  readonly phase: MemoryImportFailurePhase;
  constructor(options: { code: string; message: string; phase: MemoryImportFailurePhase }) {
    super(options.message);
    this.name = "MemoryImportBackendError";
    this.code = options.code;
    this.phase = options.phase;
  }
}

export function importCapabilityOf(profile: MemoryImportBackendProfile): MemoryImportCapabilities {
  return profile.descriptor.capabilities;
}
