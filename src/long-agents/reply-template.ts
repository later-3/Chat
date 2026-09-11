/**
 * 回复格式模板（B2）：它是给 Agent 的**提示词要求**，让 Agent 自己按这个格式写回复，
 * 而不是程序在模型输出外面包一层（那样会导致 Web 与会话历史、不同渠道内容不一致）。
 *
 * 变量：{{project}}（当前上下文项目名）、{{agentName}}、{{date}}（本地日期）。
 * 模板为空字符串表示不加任何格式要求。
 */
export const DEFAULT_RESPONSE_TEMPLATE = "project：{{project}}";

export function renderResponseTemplate(
  template: string | undefined,
  vars: { readonly project: string; readonly agentName: string; readonly date: string },
): string {
  const value = (template ?? DEFAULT_RESPONSE_TEMPLATE).trim();
  if (value === "") return "";
  return value
    .replaceAll("{{project}}", vars.project)
    .replaceAll("{{agentName}}", vars.agentName)
    .replaceAll("{{date}}", vars.date);
}

/** 把模板渲染成本轮注入 Agent 的格式要求；返回 null 表示不注入。 */
export function buildReplyFormatInstruction(
  template: string | undefined,
  vars: { readonly project: string; readonly agentName: string; readonly date: string },
): string | null {
  const rendered = renderResponseTemplate(template, vars);
  if (rendered === "") return null;
  return [
    "回复格式要求：每条回复的最后另起一行，原样输出下面这段内容（不要改写、不要省略）：",
    rendered,
  ].join("\n");
}

export function localDate(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
