function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read-only provenance from a native maintenance trigger, never inferred from JSON text. */
export interface ChatSessionActivity {
  readonly kind: "daily-summary" | "daily-summary-draft";
  readonly triggerEntryId: string;
  readonly date?: string;
}

export function sessionActivityTrigger(entry: unknown): ChatSessionActivity | undefined {
  if (!isRecord(entry) || typeof entry.id !== "string" || entry.type !== "custom_message") return undefined;
  const kind = entry.customType === "chat.daily-summary.v1" ? "daily-summary"
    : entry.customType === "chat.daily-summary-draft.v1" ? "daily-summary-draft" : undefined;
  if (kind === undefined) return undefined;
  const date = isRecord(entry.details) && typeof entry.details.date === "string"
    && /^\d{4}-\d{2}-\d{2}$/.test(entry.details.date) ? entry.details.date : undefined;
  return { kind, triggerEntryId: entry.id, ...(date === undefined ? {} : { date }) };
}
