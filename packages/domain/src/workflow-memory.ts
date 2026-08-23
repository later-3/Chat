import { canonicalJsonStringify, hashCanonical, sha256Hex } from "./canonical-hash.js";

export interface WorkflowMemoryProviderDescriptorShape {
  readonly schemaVersion: "memory-provider-descriptor.v1";
  readonly providerId: string;
  readonly displayName: string;
  readonly providerKind: string;
  readonly transport: "http" | "sdk" | "mcp";
  readonly adapterContractVersion: string;
  readonly configured: boolean;
  readonly configurationFingerprint: string;
  readonly capabilities: {
    readonly query: {
      readonly maxResults: number;
      readonly maxContextCharacters: number;
    } | null;
    readonly write: {
      readonly maxContentCharacters: number;
      readonly materialization: "synchronous" | "asynchronous" | "accepted_only";
      readonly idempotency: "provider_key" | "chat_reconcile";
    } | null;
    readonly reconcile: boolean;
    readonly management: {
      readonly list: boolean;
      readonly get: boolean;
      readonly update: boolean;
      readonly delete: boolean;
      readonly history: boolean;
    };
  };
  readonly authMode: "none" | "bearer";
  readonly credentialRevision: string;
}

export interface WorkflowMemorySectionShape {
  readonly externalObjectIds: readonly string[];
  readonly title: string;
  readonly category: "episode" | "fact" | "preference" | "procedure" | "skill" | "other";
  readonly content: string;
  readonly labels: readonly string[];
  readonly score?: number | undefined;
  readonly sourceUpdatedAt?: string | undefined;
}

export class WorkflowMemoryInvariantError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "WorkflowMemoryInvariantError";
    this.code = code;
  }
}

export function computeMemoryProviderDescriptorSha256(
  descriptor: WorkflowMemoryProviderDescriptorShape,
): string {
  return hashCanonical("memory-provider-descriptor.v1", descriptor);
}

export function computeWorkflowMemoryQueryRequestSha256(input: {
  readonly productRunId: string;
  readonly workflowRunSpecId: string;
  readonly workflowRunSpecSha256: string;
  readonly definitionNodeId: string;
  readonly executionPath: readonly {
    readonly containerNodeId: string;
    readonly iteration: number;
  }[];
  readonly attemptNumber: number;
  readonly sourceMessageId: string;
  readonly sourceMessageSha256: string;
  readonly querySha256: string;
  readonly providerDescriptorSha256: string;
  readonly requirement: "required" | "optional";
  readonly maxResults: number;
  readonly maxContextCharacters: number;
}): string {
  return hashCanonical("workflow-memory-query-request.v1", input);
}

export function computeWorkflowMemorySnapshotSha256(input: {
  readonly providerId: string;
  readonly externalObjectIds: readonly string[];
  readonly title: string;
  readonly category: WorkflowMemorySectionShape["category"];
  readonly content: string;
  readonly labels: readonly string[];
  readonly score?: number | undefined;
  readonly sourceUpdatedAt?: string | undefined;
}): string {
  return hashCanonical("workflow-memory-snapshot.v1", input);
}

export function computeWorkflowMemoryQueryResultSha256(input: {
  readonly externalQueryId: string;
  readonly hitCount: number;
  readonly sections: readonly WorkflowMemorySectionShape[];
}): string {
  return hashCanonical("workflow-memory-query-result.v1", input);
}

export function computeWorkflowMemoryContextSha256(input: {
  readonly productRunId: string;
  readonly workflowRunSpecId: string;
  readonly workflowRunSpecSha256: string;
  readonly queries: readonly {
    readonly workflowMemoryQueryId: string;
    readonly revision: 1 | 2;
    readonly providerId: string;
    readonly outcome: "completed" | "optional_failed";
    readonly resultSetSha256?: string | undefined;
    readonly errorCode?: string | undefined;
  }[];
  readonly items: readonly {
    readonly workflowMemorySnapshotId: string;
    readonly revision: 1;
    readonly sha256: string;
  }[];
  readonly totalContentCharacters: number;
}): string {
  return hashCanonical("workflow-memory-context.v1", input);
}

/** Adapter输出先在Chat边界去重、排序和裁剪，Provider顺序不能改变历史Hash。 */
export function normalizeWorkflowMemorySections(input: {
  readonly sections: readonly WorkflowMemorySectionShape[];
  readonly hitCount: number;
  readonly maxResults: number;
  readonly maxContextCharacters: number;
}): readonly WorkflowMemorySectionShape[] {
  if (input.hitCount < 0 || !Number.isInteger(input.hitCount)) {
    throw new WorkflowMemoryInvariantError(
      "memory.provider.contract_invalid",
      "Memory Provider返回了无效命中数量",
    );
  }
  if (input.sections.length > input.maxResults) {
    throw new WorkflowMemoryInvariantError(
      "memory.provider.too_many_results",
      "Memory Provider返回条目超过节点上限",
    );
  }
  const normalized = input.sections
    .map((section) => ({
      ...section,
      title: section.title.trim(),
      externalObjectIds: [...new Set(section.externalObjectIds.map((value) => value.trim()))]
        .filter(Boolean)
        .sort(),
      labels: [...new Set(section.labels.map((value) => value.trim().toLowerCase()))]
        .filter(Boolean)
        .sort(),
    }))
    .sort((left, right) =>
      canonicalJsonStringify({
        externalObjectIds: left.externalObjectIds,
        category: left.category,
        title: left.title,
        contentSha256: sha256Hex(left.content),
      }).localeCompare(
        canonicalJsonStringify({
          externalObjectIds: right.externalObjectIds,
          category: right.category,
          title: right.title,
          contentSha256: sha256Hex(right.content),
        }),
      ),
    );
  if (
    normalized.some(
      (section) =>
        section.title.length === 0 ||
        section.content.length === 0 ||
        section.externalObjectIds.length === 0,
    )
  ) {
    throw new WorkflowMemoryInvariantError(
      "memory.provider.contract_invalid",
      "Memory Provider返回了空白结果",
    );
  }
  const sourceCount = new Set(normalized.flatMap((section) => section.externalObjectIds)).size;
  if (sourceCount > input.hitCount) {
    throw new WorkflowMemoryInvariantError(
      "memory.provider.contract_invalid",
      "Memory Provider命中数量小于来源数量",
    );
  }
  let consumed = 0;
  const selected: WorkflowMemorySectionShape[] = [];
  for (const section of normalized) {
    const sectionCharacters = section.title.length + section.content.length;
    if (consumed + sectionCharacters > input.maxContextCharacters) continue;
    consumed += sectionCharacters;
    selected.push(section);
  }
  return selected;
}

interface MessageForMemoryWrite {
  readonly messageId: string;
  readonly sessionId: string;
  readonly sessionSequence: number;
  readonly role: "user" | "assistant";
  readonly content: { readonly format: "markdown"; readonly text: string };
}

type MemoryWriteSourceSelectionShape =
  | {
      readonly kind: "full_message";
      readonly sourceMessageId: string;
      readonly sourceMessageSha256: string;
    }
  | {
      readonly kind: "utf16_range";
      readonly sourceMessageId: string;
      readonly sourceMessageSha256: string;
      readonly startUtf16: number;
      readonly endUtf16: number;
      readonly selectedTextSha256: string;
    };

export function computeWorkflowMemoryMessageSha256(message: MessageForMemoryWrite): string {
  return hashCanonical("message.v1", {
    messageId: message.messageId,
    sessionId: message.sessionId,
    sessionSequence: message.sessionSequence,
    role: message.role,
    content: message.content,
  });
}

export function resolveMemoryWriteContent(input: {
  readonly message: MessageForMemoryWrite;
  readonly selection: MemoryWriteSourceSelectionShape;
  readonly maxContentCharacters: number;
}): string {
  if (input.selection.sourceMessageId !== input.message.messageId) {
    throw new WorkflowMemoryInvariantError(
      "memory.write.source_mismatch",
      "Memory写入来源不属于指定Message",
    );
  }
  if (input.selection.sourceMessageSha256 !== computeWorkflowMemoryMessageSha256(input.message)) {
    throw new WorkflowMemoryInvariantError(
      "memory.write.source_hash_mismatch",
      "Message版本已变化，请刷新后重新选择",
    );
  }
  let content: string;
  if (input.selection.kind === "full_message") {
    content = input.message.content.text;
  } else {
    if (
      input.selection.startUtf16 >= input.selection.endUtf16 ||
      input.selection.endUtf16 > input.message.content.text.length
    ) {
      throw new WorkflowMemoryInvariantError(
        "memory.write.selection_invalid",
        "Memory写入选区范围无效",
      );
    }
    content = input.message.content.text.slice(
      input.selection.startUtf16,
      input.selection.endUtf16,
    );
    if (sha256Hex(content) !== input.selection.selectedTextSha256) {
      throw new WorkflowMemoryInvariantError(
        "memory.write.selection_hash_mismatch",
        "Memory写入选区内容已变化",
      );
    }
  }
  if (!/[^\p{C}\s]/u.test(content)) {
    throw new WorkflowMemoryInvariantError(
      "memory.write.content_empty",
      "不能写入空白或仅含控制字符的内容",
    );
  }
  if (content.length > input.maxContentCharacters) {
    throw new WorkflowMemoryInvariantError(
      "memory.write.content_too_large",
      "内容超过Memory Provider允许的长度",
    );
  }
  return content;
}

export function computeMemoryWriteRequestSha256(input: {
  readonly operationId: string;
  readonly providerDescriptorSha256: string;
  readonly contentType: "conversation_turn";
  readonly sourceSelection: MemoryWriteSourceSelectionShape;
  readonly contentSha256: string;
}): string {
  return hashCanonical("memory-write-request.v1", input);
}

export function computeMemoryWriteSemanticDedupeSha256(input: {
  readonly requestedByPrincipalId: string;
  readonly productSessionId: string;
  readonly providerId: string;
  readonly sourceSelection: MemoryWriteSourceSelectionShape;
}): string {
  return hashCanonical("memory-write-semantic-dedupe.v1", input);
}

type MemoryWriteStatus =
  "queued" | "dispatching" | "accepted" | "materialized" | "failed" | "outcome_unknown";

const LEGAL_WRITE_TRANSITIONS: Readonly<Record<MemoryWriteStatus, readonly MemoryWriteStatus[]>> = {
  queued: ["dispatching", "failed", "outcome_unknown"],
  dispatching: ["accepted", "materialized", "failed", "outcome_unknown"],
  accepted: ["materialized", "failed", "outcome_unknown"],
  outcome_unknown: ["accepted", "materialized", "failed"],
  materialized: [],
  failed: [],
};

export function assertMemoryWriteTransition(
  current: { readonly status: MemoryWriteStatus },
  nextStatus: MemoryWriteStatus,
): void {
  if (!LEGAL_WRITE_TRANSITIONS[current.status].includes(nextStatus)) {
    throw new WorkflowMemoryInvariantError(
      "memory.write.transition_invalid",
      `不允许${current.status} -> ${nextStatus}`,
    );
  }
}

export function assertWorkflowMemoryContextOrder(input: {
  readonly queries: readonly { readonly workflowMemoryQueryId: string }[];
  readonly items: readonly { readonly workflowMemorySnapshotId: string }[];
}): void {
  const queryIds = input.queries.map((item) => item.workflowMemoryQueryId);
  const itemIds = input.items.map((item) => item.workflowMemorySnapshotId);
  if (
    new Set(queryIds).size !== queryIds.length ||
    new Set(itemIds).size !== itemIds.length ||
    canonicalJsonStringify(queryIds) !== canonicalJsonStringify([...queryIds].sort()) ||
    canonicalJsonStringify(itemIds) !== canonicalJsonStringify([...itemIds].sort())
  ) {
    throw new WorkflowMemoryInvariantError(
      "memory.context.order_invalid",
      "Workflow Memory Context引用必须唯一且稳定排序",
    );
  }
}
