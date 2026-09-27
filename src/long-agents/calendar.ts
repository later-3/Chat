/** Dates belong to the Agent's persisted calendar, never the browser or process timezone. */
export function validateCalendarDate(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || value < "1970-01-01" || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString().slice(0, 10) !== value) throw new Error("日历日期必须是有效的 YYYY-MM-DD");
  return value;
}

export function validateTimeZone(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "" || /^[+-]/.test(value)) throw new Error("timeZone必须是IANA时区");
  try { return new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions().timeZone; }
  catch { throw new Error(`无效timeZone: ${value}`); }
}

export function agentDate(timeZone: string, now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const part = (type: string) => parts.find((value) => value.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
