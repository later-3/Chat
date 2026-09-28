/** Dates belong to the Agent's persisted calendar, never the browser or process timezone. */
export function validateCalendarDate(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || value < "1970-01-01" || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString().slice(0, 10) !== value) throw new Error("日历日期必须是有效的 YYYY-MM-DD");
  return value;
}

// Intl.DateTimeFormat construction dominates repeated date work (session ownership resolution
// walks every dailySession per read); formatters are immutable per locale+timeZone, so cache them.
const dayFormatters = new Map<string, Intl.DateTimeFormat>();
const resolvedTimeZones = new Map<string, string>();

function dayFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = dayFormatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    dayFormatters.set(timeZone, formatter);
  }
  return formatter;
}

export function validateTimeZone(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "" || /^[+-]/.test(value)) throw new Error("timeZone必须是IANA时区");
  const cached = resolvedTimeZones.get(value);
  if (cached !== undefined) return cached;
  try {
    const resolved = new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions().timeZone;
    resolvedTimeZones.set(value, resolved);
    return resolved;
  } catch { throw new Error(`无效timeZone: ${value}`); }
}

export function agentDate(timeZone: string, now = new Date()): string {
  const parts = dayFormatter(timeZone).formatToParts(now);
  const part = (type: string) => parts.find((value) => value.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
