import { hashCanonical, sha256Hex } from "./canonical-hash.js";

interface MessageForMemoryImport {
  readonly messageId: string;
  readonly sessionId: string;
  readonly sessionSequence: number;
  readonly role: "user" | "assistant";
  readonly content: { readonly format: "markdown"; readonly text: string };
}

type MemoryImportSourceSelectionShape =
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

type MemoryImportStatus =
  "queued" | "dispatching" | "accepted" | "materialized" | "failed" | "outcome_unknown";

/** 导入选区错误是可稳定映射到公开Problem Detail的领域错误。 */
export class MemoryImportInvariantError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "MemoryImportInvariantError";
    this.code = code;
  }
}

export function computeMessageSha256(message: MessageForMemoryImport): string {
  return hashCanonical("message.v1", {
    messageId: message.messageId,
    sessionId: message.sessionId,
    sessionSequence: message.sessionSequence,
    role: message.role,
    content: message.content,
  });
}

/**
 * 浏览器只提交范围；服务端始终从权威 Message 重新切片。UTF-16 与 JS 字符串索引
 * 完全一致，可稳定覆盖中文、Emoji 和 Markdown，不需要复制选区正文进 Intent。
 */
export function resolveMemoryImportContent(input: {
  readonly message: MessageForMemoryImport;
  readonly selection: MemoryImportSourceSelectionShape;
  readonly maxContentChars: number;
}): string {
  const { message, selection } = input;
  if (selection.sourceMessageId !== message.messageId) {
    throw new MemoryImportInvariantError("memory.import.source_mismatch", "选区不属于指定Message");
  }
  if (selection.sourceMessageSha256 !== computeMessageSha256(message)) {
    throw new MemoryImportInvariantError(
      "memory.import.source_hash_mismatch",
      "Message版本已变化，请刷新后重新选择",
    );
  }

  let content: string;
  if (selection.kind === "full_message") {
    content = message.content.text;
  } else {
    if (
      selection.startUtf16 >= selection.endUtf16 ||
      selection.endUtf16 > message.content.text.length
    ) {
      throw new MemoryImportInvariantError("memory.import.selection_invalid", "选区范围无效");
    }
    content = message.content.text.slice(selection.startUtf16, selection.endUtf16);
    if (sha256Hex(content) !== selection.selectedTextSha256) {
      throw new MemoryImportInvariantError(
        "memory.import.selection_hash_mismatch",
        "选区内容已变化，请重新选择",
      );
    }
  }

  // `trim()`不会移除NUL、方向控制符等Unicode控制字符；这类内容对用户不可读，
  // 也会在memmy协议规范化时发生变化，因此必须在进入Intent之前失败关闭。
  if (!/[^\p{C}\s]/u.test(content)) {
    throw new MemoryImportInvariantError(
      "memory.import.selection_empty",
      "不能导入空白或仅含控制字符的内容",
    );
  }
  if (content.length > input.maxContentChars) {
    throw new MemoryImportInvariantError(
      "memory.import.content_too_large",
      "选区超过Memory后端允许的长度",
    );
  }
  return content;
}

export function normalizeMemoryImportTitle(title: string): string {
  const normalized = title.trim().replace(/\s+/gu, " ");
  if (normalized.length === 0 || normalized.length > 200) {
    throw new MemoryImportInvariantError("memory.import.title_invalid", "标题长度无效");
  }
  return normalized;
}

export function normalizeMemoryImportTags(tags: readonly string[]): string[] {
  const normalized = [...new Set(tags.map((tag) => tag.trim().toLowerCase()))]
    .filter((tag) => tag.length > 0)
    .sort();
  if (normalized.length > 20 || normalized.some((tag) => tag.length > 64)) {
    throw new MemoryImportInvariantError("memory.import.tags_invalid", "标签数量或长度无效");
  }
  return normalized;
}

export function computeMemoryImportBackendDescriptorSha256(descriptor: {
  readonly backendId: string;
  readonly displayName: string;
  readonly kind: "memmy";
  readonly adapterContractVersion: "memmy-http-import.v1";
  readonly configured: boolean;
  readonly configurationFingerprint: string;
  readonly capabilities: {
    readonly mode: "explicit_fact";
    readonly layers: readonly ["L2"];
    readonly title: true;
    readonly tags: true;
    readonly maxContentChars: number;
  };
  readonly authMode: "none" | "bearer";
  readonly credentialRevision: string;
}): string {
  return hashCanonical("memory-import-backend-profile.v1", descriptor);
}

export interface MemoryImportRequestShape {
  readonly content: string;
  readonly layer: "L2";
  readonly title: string;
  readonly tags: readonly string[];
  readonly turnId: string;
}

export function computeMemoryImportRequestSha256(input: MemoryImportRequestShape): string {
  return hashCanonical("memory-import-request.v1", input);
}

export function computeMemoryImportSemanticDedupeSha256(input: {
  readonly requestedByPrincipalId: string;
  readonly sourceSelection: MemoryImportSourceSelectionShape;
  readonly backendId: string;
  readonly title: string;
  readonly tags: readonly string[];
}): string {
  return hashCanonical("memory-import-semantic-dedupe.v1", {
    ...input,
    memoryLayer: "L2",
  });
}

const legalTransitions: Readonly<Record<MemoryImportStatus, readonly MemoryImportStatus[]>> = {
  queued: ["dispatching", "failed", "outcome_unknown"],
  dispatching: ["accepted", "failed", "outcome_unknown"],
  accepted: ["materialized", "failed", "outcome_unknown"],
  outcome_unknown: ["accepted", "materialized", "failed"],
  materialized: [],
  failed: [],
};

export function assertMemoryImportTransition(
  current: { readonly status: MemoryImportStatus },
  nextStatus: MemoryImportStatus,
): void {
  if (!(legalTransitions[current.status] ?? []).includes(nextStatus)) {
    throw new MemoryImportInvariantError(
      "memory.import.transition_invalid",
      `不允许${current.status} -> ${nextStatus}`,
    );
  }
}
