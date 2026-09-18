import type { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";

export type NativeAssistant = NonNullable<ConstructorParameters<typeof AssistantMessageComponent>[0]>;
export interface ContentBlock { type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: Record<string, unknown>; data?: string; mimeType?: string }
export interface NativeMessage {
  role: string; content: string | ContentBlock[]; toolCallId?: string; toolName?: string; isError?: boolean; details?: unknown;
}
export interface HistoryEntry { id: string; parentId: string | null; timestamp: string; type: "message" | "notice"; message?: NativeMessage; label?: string }
export interface RunReference { runId: string; workflowInvocationId: string; workflowId: string; projectId: string }
export interface Review {
  reviewId: string; workflowInvocationId: string; sessionId: string; planRevision: number; planSha256: string;
  plan: string; readiness: "ready_for_review" | "needs_clarification";
}
export interface Transcript {
  schemaVersion: 1; projectId: string; sessionId: string; name: string; leafId: string | null; revision: string;
  workflowId: string | null; entries: HistoryEntry[]; nextCursor: string | null;
  activeRun: (RunReference & { phase: string; review?: Review }) | null;
}
export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("服务器响应不是对象");
  return value as Record<string, unknown>;
}
export function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("服务器响应缺少字符串字段");
  return value;
}
export function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("服务器响应缺少数组字段");
  return value;
}
export function nullableString(value: unknown): string | null { return value === null ? null : string(value); }
export function parseMessage(value: unknown): NativeMessage {
  const message = record(value);
  const role = string(message.role);
  if (!["user", "assistant", "toolResult", "custom", "bashExecution"].includes(role)) throw new Error(`不支持的消息角色: ${role}`);
  if (typeof message.content !== "string") {
    for (const part of array(message.content)) {
      const block = record(part);
      const type = string(block.type);
      if (type === "text") string(block.text);
      else if (type === "thinking") string(block.thinking);
      else if (type === "toolCall") { string(block.id); string(block.name); record(block.arguments); }
      else if (type === "image") { string(block.data); string(block.mimeType); }
      else throw new Error(`不支持的消息内容: ${type}`);
    }
  }
  if (role === "assistant" && !Array.isArray(message.content)) throw new Error("Assistant内容必须为数组");
  if (role === "toolResult") { string(message.toolCallId); string(message.toolName); if (typeof message.isError !== "boolean") throw new Error("Tool状态无效"); }
  return message as unknown as NativeMessage;
}
export function assistantMessage(value: NativeMessage): NativeAssistant {
  if (value.role !== "assistant" || !Array.isArray(value.content)) throw new Error("不是Assistant消息");
  // Native renderer only reads content, stopReason and errorMessage. Execution never consumes this projection.
  return value as unknown as NativeAssistant;
}
export function parseRun(value: unknown, projectId?: string): RunReference {
  const run = record(value);
  return { runId: string(run.runId), workflowInvocationId: string(run.workflowInvocationId),
    workflowId: string(run.workflowId ?? run.workflow), projectId: projectId ?? string(run.projectId) };
}
export function parseReview(value: unknown): Review {
  const review = record(value);
  if (!Number.isSafeInteger(review.planRevision) || Number(review.planRevision) < 1
    || !["ready_for_review", "needs_clarification"].includes(String(review.readiness))) throw new Error("审核响应无效");
  return { reviewId: string(review.reviewId), workflowInvocationId: string(review.workflowInvocationId),
    sessionId: string(review.sessionId), planRevision: Number(review.planRevision), planSha256: string(review.planSha256),
    plan: string(review.plan), readiness: review.readiness as Review["readiness"] };
}
export function parseTranscript(value: unknown): Transcript {
  const data = record(value);
  if (data.schemaVersion !== 1) throw new Error("服务器不支持此版本的TUI合同，请升级Chat后端或客户端");
  const active = data.activeRun === null ? null : record(data.activeRun);
  return { schemaVersion: 1, projectId: string(data.projectId), sessionId: string(data.sessionId), name: string(data.name),
    leafId: nullableString(data.leafId), revision: string(data.revision), workflowId: nullableString(data.workflowId),
    nextCursor: nullableString(data.nextCursor), activeRun: active === null ? null : {
      ...parseRun(active), phase: string(active.phase), ...(active.review === undefined ? {} : { review: parseReview(active.review) }),
    },
    entries: array(data.entries).map((value) => {
      const entry = record(value);
      if (entry.type !== "message" && entry.type !== "notice") throw new Error("历史条目类型无效");
      return { id: string(entry.id), parentId: nullableString(entry.parentId), timestamp: string(entry.timestamp), type: entry.type,
        ...(entry.type === "message" ? { message: parseMessage(entry.message) } : { label: string(entry.label) }) };
    }),
  };
}
export function messageText(message: NativeMessage): string {
  return typeof message.content === "string" ? message.content : message.content.flatMap((p) => p.type === "text" ? [p.text ?? ""] : []).join("\n");
}
