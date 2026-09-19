import type { ChatLongAgentTurnAgentGroupContext } from "./session-turn.js";
import { validateTimeZone } from "./calendar.js";
import { parseWorkflowImages } from "../workflows/image-input.js";
import type { ImageContent } from "@earendil-works/pi-ai";

export interface DailySession {
  readonly longAgentId: string;
  readonly date: string;
  readonly timeZone: string;
  readonly sessionId: string;
  readonly createdAt: string;
  readonly summary: { readonly status: "pending" | "running" | "completed" | "failed";
    readonly attempts: number; readonly cutoff: string | null; readonly entryId: string | null;
    readonly nextAttemptAt: string | null; readonly error: string | null; readonly revision: string | null };
}
export interface AcceptedTurn {
  readonly turnId: string;
  readonly requestId: string;
  readonly payloadHash: string;
  readonly summaryDraft: boolean;
  readonly isNewSession: boolean;
  readonly longAgentId: string;
  readonly source: "chat-web" | "channel" | "scheduled";
  readonly channelType: string | null;
  readonly inboundEventId: string | null;
  readonly contextProjectId: string | null;
  readonly sessionId: string;
  readonly date: string;
  readonly timeZone: string;
  readonly acceptedAt: string;
  readonly sequence: number;
  readonly status: "queued" | "running" | "completed" | "failed" | "interrupted" | "cancelled";
  readonly error: string | null;
  readonly text?: string;
  readonly images?: readonly ImageContent[];
  readonly groupContext: ChatLongAgentTurnAgentGroupContext;
  readonly seed?: readonly { readonly customType: string; readonly data: unknown }[];
}
function record(value: unknown): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("每日生命周期记录必须是对象");
}
function string(value: unknown): asserts value is string { if (typeof value !== "string" || !value) throw new Error("生命周期字段必须是非空字符串"); }
function date(value: unknown): asserts value is string { string(value); if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new Error("无效日历日期"); }
function timestamp(value: unknown): void { string(value); if (!Number.isFinite(Date.parse(value))) throw new Error("无效生命周期时间"); }
function nullable(value: unknown): void { if (value !== null) string(value); }
function fields(value: Record<string, unknown>, names: string[]): void { if (Object.keys(value).some((key) => !names.includes(key))) throw new Error("未知生命周期字段"); }
export function parseDailySession(value: unknown): DailySession {
  record(value); fields(value, ["longAgentId", "date", "timeZone", "sessionId", "createdAt", "summary"]);
  string(value.longAgentId); string(value.sessionId); date(value.date); timestamp(value.createdAt); validateTimeZone(value.timeZone);
  record(value.summary); const summary = value.summary;
  fields(summary, ["status", "attempts", "cutoff", "entryId", "nextAttemptAt", "error", "revision"]);
  if (!["pending", "running", "completed", "failed"].includes(String(summary.status)) || !Number.isSafeInteger(summary.attempts) || Number(summary.attempts) < 0) throw new Error("无效总结状态");
  for (const key of ["cutoff", "entryId", "nextAttemptAt", "error", "revision"]) nullable(summary[key]);
  if (summary.nextAttemptAt !== null) timestamp(summary.nextAttemptAt);
  return value as unknown as DailySession;
}
export function parseAcceptedTurn(value: unknown): AcceptedTurn {
  record(value); fields(value, ["turnId", "requestId", "payloadHash", "summaryDraft", "isNewSession", "longAgentId", "source", "channelType", "inboundEventId", "contextProjectId", "sessionId", "date", "timeZone", "acceptedAt", "sequence", "status", "error", "text", "images", "seed", "groupContext"]);
  for (const key of ["turnId", "requestId", "payloadHash", "longAgentId", "sessionId"]) string(value[key]);
  for (const key of ["channelType", "inboundEventId", "contextProjectId", "error"]) nullable(value[key]);
  if (typeof value.summaryDraft !== "boolean" || typeof value.isNewSession !== "boolean") throw new Error("无效请求用途");
  date(value.date); timestamp(value.acceptedAt); validateTimeZone(value.timeZone);
  if (!["chat-web", "channel", "scheduled"].includes(String(value.source))
    || !["queued", "running", "completed", "failed", "interrupted", "cancelled"].includes(String(value.status))
    || !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1) throw new Error("无效请求状态或序号");
  if (value.text !== undefined && typeof value.text !== "string") throw new Error("无效请求正文");
  if (value.images !== undefined) parseWorkflowImages(value.images);
  record(value.groupContext);
  for (const key of ["contextRevision", "agentGroupId", "agentGroupRevision", "indexRevision", "definitionRevision", "fetchedAt"]) string(value.groupContext[key]);
  fields(value.groupContext, ["contextRevision", "agentGroupId", "agentGroupRevision", "indexRevision", "definitionRevision", "stale", "fetchedAt"]);
  timestamp(value.groupContext.fetchedAt);
  for (const key of ["contextRevision", "agentGroupRevision", "indexRevision", "definitionRevision"]) if (!/^sha256:[a-f0-9]{64}$/.test(String(value.groupContext[key]))) throw new Error("身份快照版本无效");
  if (!/^[a-f0-9]{64}$/.test(String(value.payloadHash))) throw new Error("请求摘要无效");
  if (typeof value.groupContext.stale !== "boolean") throw new Error("无效身份快照状态");
  if (value.seed !== undefined) {
    if (!Array.isArray(value.seed)) throw new Error("装配快照必须是数组");
    for (const entry of value.seed) { record(entry); fields(entry, ["customType", "data"]); string(entry.customType); if (!entry.customType.startsWith("chat.agent-assembly")) throw new Error("未知装配快照"); }
  }
  if ((value.status === "queued" || value.status === "running") && (value.text === undefined || value.seed === undefined)) throw new Error("待执行请求缺少冻结输入");
  return value as unknown as AcceptedTurn;
}
