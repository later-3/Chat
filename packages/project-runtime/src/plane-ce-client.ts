import { z } from "zod";

export const PLANE_CE_VERSION = "1.4.1";
export const PLANE_CE_API_PREFIX = "/api/v1";
export const PLANE_CE_PAGE_SIZE = 1_000;
const MAX_PLANE_CE_PAGES = 10_000;

const workspaceConfigSchema = z
  .array(
    z
      .object({
        slug: z
          .string()
          .trim()
          .regex(/^[a-z0-9][a-z0-9-]*$/u)
          .max(80),
        displayName: z.string().min(1).max(160),
      })
      .strict(),
  )
  .min(1)
  .max(20);

const responsePageSchema = <T extends z.ZodType>(itemSchema: T) =>
  z
    .object({
      results: z.array(itemSchema),
      next_cursor: z.string().min(1).max(255),
      next_page_results: z.boolean(),
    })
    .loose();

export interface PlaneCeWorkspaceConfig {
  readonly slug: string;
  readonly displayName: string;
}

export interface PlaneCeClientOptions {
  readonly baseUrl: URL;
  readonly apiToken: string;
  readonly workspaces: readonly PlaneCeWorkspaceConfig[];
  readonly fetchFn?: typeof fetch;
}

export interface PlaneCeEnvironmentConfig {
  readonly baseUrl: URL;
  readonly apiToken: string;
  readonly workspaces: readonly PlaneCeWorkspaceConfig[];
}

export class PlaneCeClientError extends Error {
  constructor(
    readonly code: string,
    readonly outcomeUnknown: boolean,
    readonly httpStatus?: number,
  ) {
    // 不带Provider响应、请求正文或Token，避免上层记录Error时泄漏凭据或外部正文。
    super(code);
    this.name = "PlaneCeClientError";
  }
}

/**
 * Plane配置是服务端能力边界：未配置时不启用；半配置、重复Workspace和不安全URL失败关闭。
 */
export function readPlaneCeEnvironmentConfig(
  env: NodeJS.ProcessEnv,
): PlaneCeEnvironmentConfig | undefined {
  const baseUrlValue = env.CHAT_PLANE_CE_BASE_URL;
  const token = env.CHAT_PLANE_CE_API_TOKEN;
  const workspacesValue = env.CHAT_PLANE_CE_WORKSPACES_JSON;
  if (isBlank(baseUrlValue) && isBlank(token) && isBlank(workspacesValue)) {
    return undefined;
  }
  if (isBlank(baseUrlValue) || isBlank(token) || isBlank(workspacesValue)) {
    throw new PlaneCeClientError("plane_ce_config_incomplete", false);
  }

  try {
    const baseUrl = new URL(baseUrlValue);
    assertAllowedPlaneCeBaseUrl(baseUrl);
    const workspaces = workspaceConfigSchema.parse(JSON.parse(workspacesValue));
    if (new Set(workspaces.map((item) => item.slug)).size !== workspaces.length) {
      throw new Error("duplicate workspace");
    }
    return { baseUrl, apiToken: token, workspaces };
  } catch (error) {
    if (error instanceof PlaneCeClientError) throw error;
    throw new PlaneCeClientError("plane_ce_config_invalid", false);
  }
}

/**
 * 只暴露给两个窄Provider的固定HTTP原语。调用者不能传方法字符串，因而没有DELETE或任意REST面。
 */
export class PlaneCeClient {
  readonly #fetchFn: typeof fetch;
  readonly #baseUrl: URL;
  readonly #apiToken: string;
  readonly #workspaces: readonly PlaneCeWorkspaceConfig[];

  constructor(options: PlaneCeClientOptions) {
    assertAllowedPlaneCeBaseUrl(options.baseUrl);
    if (options.apiToken.trim() === "") {
      throw new PlaneCeClientError("plane_ce_config_invalid", false);
    }
    workspaceConfigSchema.parse(options.workspaces);
    if (new Set(options.workspaces.map((item) => item.slug)).size !== options.workspaces.length) {
      throw new PlaneCeClientError("plane_ce_config_invalid", false);
    }
    this.#fetchFn = options.fetchFn ?? fetch;
    this.#baseUrl = new URL(options.baseUrl.href);
    this.#apiToken = options.apiToken;
    this.#workspaces = options.workspaces.map((workspace) => ({ ...workspace }));
  }

  describe() {
    return {
      providerKind: "plane_ce" as const,
      providerVersion: PLANE_CE_VERSION,
      providerWebBaseUrl: this.#baseUrl.origin,
      allowedWorkspaceSlugs: this.#workspaces.map((item) => item.slug),
    };
  }

  /** JSON/结构化日志只能看到无凭据描述；API Token保存在运行时真私有字段。 */
  toJSON() {
    return this.describe();
  }

  requireWorkspace(slug: string): PlaneCeWorkspaceConfig {
    const workspace = this.#workspaces.find((item) => item.slug === slug);
    if (workspace === undefined) {
      throw new PlaneCeClientError("plane_workspace_not_allowed", false);
    }
    return workspace;
  }

  get<T>(path: string, responseSchema: z.ZodType<T>): Promise<T> {
    return this.request(path, { method: "GET", write: false }, responseSchema);
  }

  async getOptional<T>(path: string, responseSchema: z.ZodType<T>): Promise<T | undefined> {
    try {
      return await this.get(path, responseSchema);
    } catch (error) {
      if (error instanceof PlaneCeClientError && error.httpStatus === 404) return undefined;
      throw error;
    }
  }

  post<T>(path: string, body: unknown, responseSchema: z.ZodType<T>): Promise<T> {
    return this.request(path, { method: "POST", body, write: true }, responseSchema);
  }

  patch<T>(path: string, body: unknown, responseSchema: z.ZodType<T>): Promise<T> {
    return this.request(path, { method: "PATCH", body, write: true }, responseSchema);
  }

  async listAll<T>(path: string, itemSchema: z.ZodType<T>): Promise<readonly T[]> {
    const results: T[] = [];
    const visitedCursors = new Set<string>();
    let cursor: string | undefined;

    for (;;) {
      const url = new URL(path, "https://plane-pagination.invalid");
      url.searchParams.set("per_page", String(PLANE_CE_PAGE_SIZE));
      if (cursor !== undefined) url.searchParams.set("cursor", cursor);
      const page = await this.get(`${url.pathname}${url.search}`, responsePageSchema(itemSchema));
      results.push(...page.results);
      if (!page.next_page_results) return results;
      if (visitedCursors.has(page.next_cursor) || visitedCursors.size >= MAX_PLANE_CE_PAGES) {
        throw new PlaneCeClientError("plane_ce_pagination_invalid", false);
      }
      visitedCursors.add(page.next_cursor);
      cursor = page.next_cursor;
    }
  }

  private async request<T>(
    path: string,
    input: {
      readonly method: "GET" | "POST" | "PATCH";
      readonly body?: unknown;
      readonly write: boolean;
    },
    responseSchema: z.ZodType<T>,
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.#fetchFn(this.resolveApiPath(path), {
        method: input.method,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-api-key": this.#apiToken,
        },
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new PlaneCeClientError(
        input.write ? "plane_ce_write_outcome_unknown" : "plane_ce_query_failed",
        input.write,
      );
    }

    if (!response.ok) {
      // 408说明服务端在请求处理窗口内超时；对POST/PATCH而言，响应不能证明副作用未发生，
      // 因而必须进入只读对账，不能把它降级成可安全重发的确定失败。GET没有副作用，仍按查询失败处理。
      const outcomeUnknown = input.write && (response.status === 408 || response.status >= 500);
      throw new PlaneCeClientError(
        outcomeUnknown
          ? "plane_ce_write_outcome_unknown"
          : `plane_ce_http_${String(response.status)}`,
        outcomeUnknown,
        response.status,
      );
    }

    try {
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (!contentType.includes("application/json")) throw new Error("non-json response");
      return responseSchema.parse(await response.json());
    } catch {
      throw new PlaneCeClientError(
        input.write ? "plane_ce_write_outcome_unknown" : "plane_ce_query_response_invalid",
        input.write,
      );
    }
  }

  private resolveApiPath(path: string): URL {
    if (!path.startsWith(`${PLANE_CE_API_PREFIX}/`) || path.startsWith("//")) {
      throw new PlaneCeClientError("plane_ce_path_not_allowed", false);
    }
    const url = new URL(path, this.#baseUrl);
    if (
      url.origin !== this.#baseUrl.origin ||
      !url.pathname.startsWith(`${PLANE_CE_API_PREFIX}/`)
    ) {
      throw new PlaneCeClientError("plane_ce_path_not_allowed", false);
    }
    return url;
  }
}

export function assertAllowedPlaneCeBaseUrl(url: URL): void {
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new PlaneCeClientError("plane_ce_config_invalid", false);
  }
  if (url.username !== "" || url.password !== "") {
    throw new PlaneCeClientError("plane_ce_config_invalid", false);
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new PlaneCeClientError("plane_ce_config_invalid", false);
  }
}

function isBlank(value: string | undefined): value is undefined {
  return value === undefined || value.trim() === "";
}
