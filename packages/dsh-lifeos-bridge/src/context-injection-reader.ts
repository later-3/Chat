import { createHash } from "node:crypto";
import {
  DSH_CONTEXT_INJECTION_SCHEMA_VERSION,
  MAX_DSH_CONTEXT_INJECTION_ITEMS,
  MAX_DSH_CONTEXT_INJECTION_TEXT_CHARS,
  MAX_DSH_CONTEXT_SOURCE_DETAILS,
  dshContextInjectionProjectionSchema,
  type DshContextInjectionItem,
  type DshContextInjectionProjection,
} from "./contracts.ts";

interface DshMessageLike {
  readonly id: string;
  readonly role: string;
  readonly content: readonly unknown[];
  readonly source: unknown;
}

interface DshSessionLike {
  readonly events: readonly { readonly type: string }[];
  deriveMessages(): readonly DshMessageLike[];
}

/** DSH SessionStore 的最窄只读接缝，测试与升级合同无需构造完整 Agent Runtime。 */
export interface DshContextSessionSource {
  get(dshSessionId: string): DshSessionLike | undefined;
}

const KNOWN_FORMS = new Set(["instructions", "catalog", "snapshot", "notice", "relay", "recall"]);

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function boundedText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  return trimmed.slice(0, maximum);
}

function sourceDetails(source: Record<string, unknown>): {
  details: string[];
  truncated: boolean;
} {
  const values: string[] = [];
  const add = (value: unknown): void => {
    const text = boundedText(value, 512);
    if (text !== undefined && !values.includes(text)) values.push(text);
  };
  add(source.summary);
  for (const [collection, field] of [
    [source.sections, "name"],
    [source.changes, "path"],
    [source.entries, "name"],
  ] as const) {
    if (!Array.isArray(collection)) continue;
    for (const value of collection) add(recordOf(value)?.[field]);
  }
  return {
    details: values.slice(0, MAX_DSH_CONTEXT_SOURCE_DETAILS),
    truncated: values.length > MAX_DSH_CONTEXT_SOURCE_DETAILS,
  };
}

function contextSource(message: DshMessageLike): Record<string, unknown> | null {
  if (message.role !== "user") return null;
  const source = recordOf(message.source) ?? {};
  const kind = source?.kind;
  if (kind === "user" || kind === "tool") return null;
  if (kind === "plugin" && source.plugin === "compact") return null;
  return source;
}

function projectContent(content: readonly unknown[]): {
  text: string;
  contentCharacters: number;
  truncated: boolean;
  unsupportedContentBlockCount: number;
} {
  let text = "";
  let contentCharacters = 0;
  let unsupportedContentBlockCount = 0;
  for (const blockValue of content) {
    const block = recordOf(blockValue);
    if (block?.type !== "text" || typeof block.text !== "string") {
      unsupportedContentBlockCount += 1;
      continue;
    }
    contentCharacters = Math.min(Number.MAX_SAFE_INTEGER, contentCharacters + block.text.length);
    const remaining = MAX_DSH_CONTEXT_INJECTION_TEXT_CHARS - text.length;
    if (remaining > 0) text += block.text.slice(0, remaining);
  }
  return {
    text,
    contentCharacters,
    truncated: contentCharacters > text.length,
    unsupportedContentBlockCount,
  };
}

function projectMessage(
  message: DshMessageLike,
  source: Record<string, unknown>,
): DshContextInjectionItem {
  const rawKind = boundedText(source?.kind, 160);
  const sourceKind = rawKind ?? "unknown-context";
  const sourceName = boundedText(source?.plugin, 512) ?? boundedText(source?.name, 512) ?? null;
  const rawForm = source?.form;
  const form = typeof rawForm === "string" && KNOWN_FORMS.has(rawForm) ? rawForm : null;
  const details = sourceDetails(source);
  return {
    messageId: String(message.id).slice(0, 256) || "unknown-message",
    sourceKind,
    sourceName,
    form: form as DshContextInjectionItem["form"],
    sourceDetails: details.details,
    sourceDetailsTruncated: details.truncated,
    ...projectContent(message.content),
  };
}

function safeTotal(current: number, addition: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, current + addition);
}

/**
 * 从 DSH 权威 Session surface 派生“下一次模型请求仍会携带什么”。读取
 * `deriveMessages()` 而不是前端 transcript，因此 compaction 已替换的历史不会误报为当前上下文。
 */
export class DshContextInjectionReader {
  constructor(private readonly sessions: DshContextSessionSource) {}

  read(dshSessionId: string): DshContextInjectionProjection | null {
    const session = this.sessions.get(dshSessionId);
    if (session === undefined) return null;

    const allItems = session.deriveMessages().flatMap((message) => {
      const source = contextSource(message);
      return source === null ? [] : [projectMessage(message, source)];
    });
    const items = allItems.slice(-MAX_DSH_CONTEXT_INJECTION_ITEMS);
    const assembled =
      allItems.length > 0 || session.events.some((event) => event.type === "step/start");
    const totalContentCharacters = allItems.reduce(
      (total, item) => safeTotal(total, item.contentCharacters),
      0,
    );
    const body = {
      schemaVersion: DSH_CONTEXT_INJECTION_SCHEMA_VERSION,
      dshSessionId,
      status: assembled ? ("ready" as const) : ("not_assembled" as const),
      chatForwarding: "latest_direct_user_message_and_workspace_instructions" as const,
      items,
      totalItems: allItems.length,
      omittedItems: allItems.length - items.length,
      totalContentCharacters,
    };
    const revision = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    return dshContextInjectionProjectionSchema.parse({ ...body, revision });
  }
}
