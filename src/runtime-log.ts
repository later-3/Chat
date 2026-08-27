/**
 * `Date#toISOString()`固定输出UTC，Nitro控制台显示系统本地时间。
 * 这个Formatter使用当前进程的本地时区，并在结果中保留UTC偏移量，
 * 使两类日志可以直接比较时间。
 */
const localTimestampFormatter = new Intl.DateTimeFormat("sv-SE", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  fractionalSecondDigits: 3,
  hour12: false,
  timeZoneName: "longOffset",
});

export function localTimestamp(): string {
  return localTimestampFormatter
    .format(new Date())
    .replace(" ", "T")
    .replace(",", ".")
    .replace(" GMT", "");
}
