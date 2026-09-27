/** Read Pi's persisted usage on messages, compaction and branch summaries. No inferred model calls. */
export function nativeEntryUsage(entry: unknown): { input: number; output: number; total: number } {
  const zero = { input: 0, output: 0, total: 0 };
  if (!entry || typeof entry !== "object") return zero;
  const record = entry as Record<string, unknown>;
  const message = record.message;
  const source = record.type === "compaction" || record.type === "branch_summary" ? record
    : record.type === "message" && message && typeof message === "object"
      && "role" in message && (message.role === "assistant" || message.role === "toolResult") ? message : null;
  if (!source || !("usage" in source) || !source.usage || typeof source.usage !== "object") return zero;
  const usage = source.usage as Record<string, unknown>;
  const n = (key: string) => typeof usage[key] === "number" && Number.isFinite(usage[key]) && usage[key] >= 0 ? usage[key] : 0;
  const input = n("input"), output = n("output");
  return { input, output, total: input + output + n("cacheRead") + n("cacheWrite") };
}
