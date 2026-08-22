import { canonicalJsonStringify, hashCanonical } from "./canonical-hash.js";
import { DomainInvariantError } from "./plan-state.js";

export const promptReviewRequestStatuses = [
  "open",
  "approved",
  "rejected",
  "dispatching",
  "dispatched",
  "outcome_unknown",
  "cancelled",
] as const;

export type PromptReviewRequestStatus = (typeof promptReviewRequestStatuses)[number];

/** 与P1冻结的Direct Agent Provider请求预算一致；超过后必须收敛而不能再开审核。 */
export const MAX_PROMPT_REVIEW_REQUESTS_PER_ATTEMPT = 16;

const allowedTransitions: Readonly<
  Record<PromptReviewRequestStatus, readonly PromptReviewRequestStatus[]>
> = {
  open: ["approved", "rejected", "cancelled"],
  approved: ["dispatching", "cancelled"],
  rejected: [],
  dispatching: ["dispatched", "outcome_unknown"],
  dispatched: [],
  outcome_unknown: [],
  cancelled: [],
};

export function canTransitionPromptReviewStatus(
  from: PromptReviewRequestStatus,
  to: PromptReviewRequestStatus,
): boolean {
  return allowedTransitions[from].includes(to);
}

export function transitionPromptReviewStatus(
  from: PromptReviewRequestStatus,
  to: PromptReviewRequestStatus,
): PromptReviewRequestStatus {
  if (!canTransitionPromptReviewStatus(from, to)) {
    throw new DomainInvariantError(
      "prompt_review_transition_invalid",
      `非法Prompt Review转换:${from}->${to}`,
    );
  }
  return to;
}

export function isTerminalPromptReviewStatus(status: PromptReviewRequestStatus): boolean {
  return allowedTransitions[status].length === 0;
}

/** 只检查HTTP请求正文顶层；Prompt文本中出现这些词不构成Credential泄漏。 */
const FORBIDDEN_TOP_LEVEL_KEYS = new Set([
  "headers",
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "apikey",
  "api_key",
  "access-token",
  "access_token",
  "credential",
  "credentials",
]);

const HIDDEN_REASONING_MESSAGE_KEYS = new Set([
  "reasoning",
  "reasoning_content",
  "reasoning_details",
  "reasoning_text",
  "thinking",
  "thinking_blocks",
]);

export const PROMPT_REVIEW_HIDDEN_REASONING_REDACTION_KIND =
  "chat.prompt_review.hidden_reasoning_redaction.v1" as const;

export interface PromptReviewHiddenReasoningRedaction {
  readonly kind: typeof PROMPT_REVIEW_HIDDEN_REASONING_REDACTION_KIND;
  readonly sha256: string;
}

function isPromptReviewHiddenReasoningRedaction(
  value: unknown,
): value is PromptReviewHiddenReasoningRedaction {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 2 &&
    record["kind"] === PROMPT_REVIEW_HIDDEN_REASONING_REDACTION_KIND &&
    typeof record["sha256"] === "string" &&
    /^[0-9a-f]{64}$/u.test(record["sha256"])
  );
}

/**
 * Provider为延续Tool Loop，可能把上一轮Assistant隐藏推理放回下一次messages。
 * Chat不拥有也不展示这些内容，只在审核投影中保留绑定原值的确定性Hash；Pi Session和
 * Provider Adapter仍在各自边界内使用原始值。函数幂等，便于Executor与Application复算。
 */
export function redactPromptReviewHiddenReasoning(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return payload;
  const record = payload as Record<string, unknown>;
  if (!Array.isArray(record["messages"])) return payload;
  return {
    ...record,
    messages: record["messages"].map((message) => {
      if (typeof message !== "object" || message === null || Array.isArray(message)) {
        return message;
      }
      return Object.fromEntries(
        Object.entries(message).map(([key, value]) => {
          if (!HIDDEN_REASONING_MESSAGE_KEYS.has(key.toLowerCase())) return [key, value];
          if (isPromptReviewHiddenReasoningRedaction(value)) return [key, value];
          return [
            key,
            {
              kind: PROMPT_REVIEW_HIDDEN_REASONING_REDACTION_KIND,
              sha256: hashCanonical("prompt-review-hidden-reasoning.v1", value),
            } satisfies PromptReviewHiddenReasoningRedaction,
          ];
        }),
      );
    }),
  };
}

export function parseCanonicalPromptReviewPayload(canonicalPayloadJson: string): unknown {
  let payload: unknown;
  try {
    payload = JSON.parse(canonicalPayloadJson) as unknown;
  } catch {
    throw new DomainInvariantError(
      "prompt_review_payload_invalid_json",
      "Prompt Review Payload不是合法JSON",
    );
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new DomainInvariantError(
      "prompt_review_payload_not_object",
      "Prompt Review Payload必须是JSON对象",
    );
  }
  if (canonicalJsonStringify(payload) !== canonicalPayloadJson) {
    throw new DomainInvariantError(
      "prompt_review_payload_not_canonical",
      "Prompt Review Payload不是canonical JSON",
    );
  }
  const forbidden = Object.keys(payload).find((key) =>
    FORBIDDEN_TOP_LEVEL_KEYS.has(key.toLowerCase()),
  );
  if (forbidden !== undefined) {
    throw new DomainInvariantError(
      "prompt_review_payload_contains_credential",
      `Prompt Review Payload不得包含Credential或HTTP Header:${forbidden}`,
    );
  }
  const messages = (payload as { readonly messages?: unknown }).messages;
  if (Array.isArray(messages)) {
    const rawHiddenReasoning = messages.find((message) => {
      if (typeof message !== "object" || message === null || Array.isArray(message)) return false;
      return Object.entries(message).some(
        ([key, value]) =>
          HIDDEN_REASONING_MESSAGE_KEYS.has(key.toLowerCase()) &&
          !isPromptReviewHiddenReasoningRedaction(value),
      );
    });
    if (rawHiddenReasoning !== undefined) {
      throw new DomainInvariantError(
        "prompt_review_payload_contains_hidden_reasoning",
        "Prompt Review产品事实不得保存隐藏推理原文",
      );
    }
  }
  return payload;
}

export function computePromptReviewPayloadSha256(canonicalPayloadJson: string): string {
  const payload = parseCanonicalPromptReviewPayload(canonicalPayloadJson);
  return hashCanonical("reviewable-provider-request-payload.v1", payload);
}

/**
 * `prompt-readable.v1`的确定性投影。它不持久化第二份正文，也不调用另一个模型；
 * 字符串消息按角色分节，复杂内容与Tools保留为格式化JSON，确保原始信息不丢失。
 */
export function renderPromptReviewReadable(
  canonicalPayloadJson: string,
  rendererVersion: "prompt-readable.v1",
): string {
  if (rendererVersion !== "prompt-readable.v1") {
    throw new DomainInvariantError(
      "prompt_review_renderer_unsupported",
      `不支持Prompt Review Renderer:${rendererVersion as string}`,
    );
  }
  const payload = parseCanonicalPromptReviewPayload(canonicalPayloadJson) as Record<
    string,
    unknown
  >;
  const sections: string[] = [];
  const messages = payload["messages"];
  if (Array.isArray(messages)) {
    sections.push("## 消息");
    messages.forEach((message, index) => {
      if (typeof message !== "object" || message === null || Array.isArray(message)) {
        sections.push(`### ${String(index + 1)} · UNKNOWN\n\n${formatReadableValue(message)}`);
        return;
      }
      const record = message as Record<string, unknown>;
      const role = typeof record["role"] === "string" ? record["role"].toUpperCase() : "UNKNOWN";
      const messageFields = Object.fromEntries(
        Object.entries(record).filter(([key]) => key !== "content"),
      );
      sections.push(
        [
          `### ${String(index + 1)} · ${role}`,
          record["content"] === undefined
            ? "#### 内容\n\n（无 content 字段）"
            : `#### 内容\n\n${formatReadableValue(record["content"])}`,
          `#### 消息字段（除 content）\n\n${formatReadableValue(messageFields)}`,
        ].join("\n\n"),
      );
    });
  }
  if (payload["tools"] !== undefined) {
    sections.push(`## 工具定义\n\n${formatReadableValue(payload["tools"])}`);
  }
  const parameters = Object.fromEntries(
    Object.entries(payload).filter(([key]) => key !== "messages" && key !== "tools"),
  );
  if (Object.keys(parameters).length > 0) {
    sections.push(`## 请求参数\n\n${formatReadableValue(parameters)}`);
  }
  const readable = sections.join("\n\n");
  // 大量短消息/Tool Schema在pretty JSON中可能膨胀。回退仍由同一Renderer完成，
  // 保存完整canonical正文且不截断，保证公开DTO的2MiB字符上限不会变成运行时500。
  return readable.length <= 2 * 1024 * 1024
    ? readable
    : `\`\`\`json\n${canonicalPayloadJson}\n\`\`\``;
}

function formatReadableValue(value: unknown): string {
  if (typeof value === "string") return value;
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

export interface PromptReviewHashInput {
  readonly promptReviewRequestId: string;
  readonly productRunId: string;
  readonly directAgentAttemptId: string;
  readonly requestIndex: number;
  readonly requestKind: "agent_turn" | "compaction" | "retry";
  readonly providerId: string;
  readonly modelId: string;
  readonly endpointHost: string;
  readonly requestRevision: number;
  readonly payloadSha256: string;
  readonly rendererVersion: "prompt-readable.v1";
}

export function computePromptReviewSha256(input: PromptReviewHashInput): string {
  return hashCanonical("prompt-review-request.v1", input);
}

export function computePromptReviewDecisionSha256(input: {
  readonly promptReviewDecisionId: string;
  readonly promptReviewRequestId: string;
  readonly productRunId: string;
  readonly requestRevision: number;
  readonly reviewSha256: string;
  readonly payloadSha256: string;
  readonly kind: "approve" | "reject";
  readonly reason?: string | undefined;
  readonly principalId: string;
  readonly commandId: string;
}): string {
  return hashCanonical("prompt-review-decision.v1", {
    ...input,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
  });
}

export interface PromptReviewBinding {
  readonly promptReviewRequestId: string;
  readonly productRunId: string;
  readonly requestRevision: number;
  readonly reviewSha256: string;
  readonly payloadSha256: string;
  readonly status: PromptReviewRequestStatus;
}

export interface PromptReviewDecisionBindingInput {
  readonly promptReviewRequestId: string;
  readonly productRunId: string;
  readonly requestRevision: number;
  readonly reviewSha256: string;
  readonly payloadSha256: string;
}

/** Decision只能绑定当前open Request的精确业务版本、Review Hash与最终Payload Hash。 */
export function assertPromptReviewDecisionBinding(
  request: PromptReviewBinding,
  input: PromptReviewDecisionBindingInput,
): void {
  if (request.status !== "open") {
    throw new DomainInvariantError(
      "prompt_review_already_decided",
      "Prompt Review Request已决定或已进入Provider派发",
    );
  }
  if (
    request.promptReviewRequestId !== input.promptReviewRequestId ||
    request.productRunId !== input.productRunId ||
    request.requestRevision !== input.requestRevision
  ) {
    throw new DomainInvariantError(
      "prompt_review_revision_conflict",
      "Prompt Review Decision绑定了错误Request或revision",
    );
  }
  if (request.reviewSha256 !== input.reviewSha256) {
    throw new DomainInvariantError(
      "prompt_review_hash_conflict",
      "Prompt Review Hash与已提交Request不一致",
    );
  }
  if (request.payloadSha256 !== input.payloadSha256) {
    throw new DomainInvariantError(
      "prompt_review_payload_hash_conflict",
      "Prompt Review Payload Hash与已提交Request不一致",
    );
  }
}

/** 同一Run任意时刻最多一个open Request。 */
export function assertSingleOpenPromptReview(
  requests: readonly Pick<PromptReviewBinding, "status">[],
): void {
  if (requests.filter((request) => request.status === "open").length > 1) {
    throw new DomainInvariantError(
      "multiple_open_prompt_reviews",
      "同一Product Run不允许同时存在多个open Prompt Review",
    );
  }
}

/** 同一Attempt的Request序号必须从1开始连续递增，避免恢复时复制或跳过审核轮次。 */
export function assertPromptReviewRequestIndexes(
  requests: readonly { readonly requestIndex: number }[],
): void {
  const ordered = [...requests].map((request) => request.requestIndex).sort((a, b) => a - b);
  if (
    ordered.length > MAX_PROMPT_REVIEW_REQUESTS_PER_ATTEMPT ||
    ordered.some((requestIndex) => requestIndex > MAX_PROMPT_REVIEW_REQUESTS_PER_ATTEMPT)
  ) {
    throw new DomainInvariantError(
      "prompt_review_request_budget_exceeded",
      `Direct Agent每个Attempt最多允许${String(MAX_PROMPT_REVIEW_REQUESTS_PER_ATTEMPT)}次Prompt Review`,
    );
  }
  for (let index = 0; index < ordered.length; index += 1) {
    if (ordered[index] !== index + 1) {
      throw new DomainInvariantError(
        "prompt_review_request_index_invalid",
        "Prompt Review requestIndex必须从1开始连续递增",
      );
    }
  }
}
