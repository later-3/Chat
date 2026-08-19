import { hashCanonical } from "./canonical-hash.js";

export interface NormalizedMemorySection {
  readonly externalObjectIds: readonly string[];
  readonly title: string;
  readonly kind: string;
  readonly memoryLayer: string;
  readonly content: string;
  readonly tags: readonly string[];
  readonly score?: number | undefined;
  readonly tokenEstimate?: number | undefined;
  readonly sourceUpdatedAt?: string | undefined;
}

/**
 * memmy 固定提交会按 contextBudget 组装 injected sections，但外部估算仍不是
 * Chat 的可信事实。Adapter、Application 与 Store 用同一保守算法再次复核，
 * 防止上游低报或未来实现漂移把超预算正文交给 Planner。
 */
export function estimateMemorySectionTokens(section: {
  readonly title: string;
  readonly content: string;
  readonly tokenEstimate?: number | undefined;
}): number {
  const fromContent = Math.ceil(`${section.title}\n${section.content}`.length / 4);
  return Math.max(section.tokenEstimate ?? 0, fromContent);
}

export function computeMemoryQueryResultSha256(input: {
  readonly externalQueryId: string;
  readonly hitCount: number;
  readonly tokenEstimate: number;
  readonly sections: readonly NormalizedMemorySection[];
}): string {
  return hashCanonical("memory-query-result.v1", input);
}

export function computeMemoryBackendDescriptorSha256(input: {
  readonly backendId: string;
  readonly displayName: string;
  readonly kind: string;
  readonly adapterContractVersion: string;
  readonly configured: boolean;
  readonly authMode: "none" | "bearer";
  readonly credentialRevision: string;
  readonly configurationFingerprint: string;
  readonly capabilities: {
    readonly query: true;
    readonly tags: boolean;
    readonly layers: readonly string[];
    readonly maxLimit: number;
    readonly maxContextBudget: number;
  };
}): string {
  return hashCanonical("memory-backend-profile.v2", input);
}

export function computeRunContextRequestSha256(input: {
  readonly productRunId: string;
  readonly requestedByPrincipalId: string;
  readonly sourceMessageId: string;
  readonly sourceMessageSha256: string;
  readonly memory?: {
    readonly backendId: string;
    readonly requirement: string;
    readonly tags: readonly string[];
    readonly layers: readonly string[];
    readonly limit: number;
    readonly contextBudget: number;
  };
  readonly workspaceInstructions?: {
    readonly schemaVersion: "workspace-instructions-snapshot.v1";
    readonly items: readonly { readonly content: string; readonly sha256: string }[];
    readonly totalContentCharacters: number;
    readonly sha256: string;
  };
}): string {
  return hashCanonical(
    input.workspaceInstructions === undefined ? "run-context-request.v1" : "run-context-request.v2",
    input,
  );
}

export function computeWorkspaceInstructionItemSha256(content: string): string {
  return hashCanonical("workspace-instruction-item.v1", { content });
}

export function computeWorkspaceInstructionsSha256(input: {
  readonly items: readonly { readonly content: string; readonly sha256: string }[];
  readonly totalContentCharacters: number;
}): string {
  return hashCanonical("workspace-instructions-snapshot.v1", input);
}

/** 被采用 Memory section 的内容 Hash；不包含 Chat 分配的实体 ID 与时间。 */
export function computeMemoryResultSnapshotSha256(input: {
  backendId: string;
  externalObjectIds: readonly string[];
  title: string;
  kind: string;
  memoryLayer: string;
  content: string;
  tags: readonly string[];
  score?: number;
  tokenEstimate?: number;
  sourceUpdatedAt?: string;
}): string {
  return hashCanonical("memory-result-snapshot.v1", input);
}

/** ContextPackage 是规划实际输入清单；Hash 不含时间和对象级 revision。 */
export function computeContextPackageSha256(input: {
  contextRequestId: string;
  productRunId: string;
  assembledForPlanRevision: number;
  purpose: "planning";
  memoryQueryId: string;
  items: readonly {
    kind: "memory_snapshot";
    memoryResultSnapshotId: string;
    revision: number;
    sha256: string;
    selection: "retrieved";
    reasonCode: "within_budget";
  }[];
  exclusions: readonly {
    kind: "memory_backend";
    backendId: string;
    reasonCode: string;
  }[];
}): string {
  return hashCanonical("context-package.v1", input);
}
