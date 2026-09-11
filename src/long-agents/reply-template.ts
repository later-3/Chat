/**
 * 回复模板（B2）：Agent 回复末尾追加一段可配置文本。
 * 变量：{{project}}（当前上下文项目名）、{{agentName}}、{{date}}（本地日期）。
 * 模板为空字符串时不追加；渲染失败时安全回退为原样回复。
 */
export const DEFAULT_RESPONSE_TEMPLATE = "\n\nproject：{{project}}";

export function renderResponseTemplate(
  template: string | undefined,
  vars: { readonly project: string; readonly agentName: string; readonly date: string },
): string {
  const value = (template ?? DEFAULT_RESPONSE_TEMPLATE).trim();
  if (value === "") return "";
  try {
    return `\n\n${value
      .replaceAll("{{project}}", vars.project)
      .replaceAll("{{agentName}}", vars.agentName)
      .replaceAll("{{date}}", vars.date)}`;
  } catch {
    return "";
  }
}

export function localDate(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
