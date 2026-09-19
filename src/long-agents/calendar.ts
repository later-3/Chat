/** Dates belong to the Agent's persisted calendar, never the browser or process timezone. */
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
