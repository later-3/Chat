import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ensureChatHome, resolveChatHome } from "./chat-home.js";

export interface ChatAuditEventInput {
  readonly action: string;
  readonly target: Readonly<Record<string, unknown>>;
  readonly source?: Readonly<Record<string, unknown>>;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface ChatAuditEvent extends ChatAuditEventInput {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly occurredAt: string;
  readonly actor: "local-user";
}

const writes = new Map<string, Promise<void>>();

/** Appends one management fact without turning domain storage into event sourcing. */
export async function appendChatAuditEvent(
  input: ChatAuditEventInput,
  chatHome = resolveChatHome(),
): Promise<ChatAuditEvent> {
  const home = await ensureChatHome(chatHome);
  const path = resolve(home.logsDir, "audit.jsonl");
  const event: ChatAuditEvent = {
    schemaVersion: 1,
    eventId: randomUUID(),
    occurredAt: new Date().toISOString(),
    actor: "local-user",
    ...input,
  };
  const previous = writes.get(path) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(async () => {
    await appendFile(path, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
  });
  writes.set(path, current);
  try {
    await current;
  } finally {
    if (writes.get(path) === current) writes.delete(path);
  }
  return event;
}
