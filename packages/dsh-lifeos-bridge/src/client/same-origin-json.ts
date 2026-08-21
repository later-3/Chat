export function browserCommandId(): string {
  return `cmd_${crypto.randomUUID().replaceAll("-", "")}`;
}

async function responseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  return text === "" ? undefined : (JSON.parse(text) as unknown);
}

/** DSH只访问Bridge同源窄路由；Chat产品合同仍由响应Schema再次校验。 */
export async function requestSameOriginJson<T>(
  path: string,
  schema: { parse(value: unknown): T },
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { accept: "application/json", "content-type": "application/json", ...init?.headers },
  });
  const value = await responseJson(response);
  if (!response.ok) {
    const problem =
      typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
    throw new Error(
      `${String(problem["code"] ?? "lifeos_request_failed")}: ${String(problem["title"] ?? `HTTP ${String(response.status)}`)}`,
    );
  }
  return schema.parse(value);
}
