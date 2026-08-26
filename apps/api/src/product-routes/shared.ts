/**
 * 公开Product Router共享件：上下文类型、ProblemDetail映射、请求解析与
 * 命令受理Trace。Router只终止协议；产品事务由Application拥有。
 */
import { type Context } from "hono";
import { ZodError } from "zod";
import {
  commandIdSchema,
  cursorPageRequestSchema,
  problemDetailSchema,
  productRunIdSchema,
  workflowNodeDetailIncludeSchema,
  promptWorkspaceRootIdSchema,
  productSessionIdSchema,
  type PrincipalId,
  type ProblemDetail,
  type RequestId,
} from "@chat/contracts";
import {
  ApplicationError,
  CommandIdReusedError,
  StoreCorruptedError,
  newSpanId,
  runTraceId,
  type ApplicationDeps,
} from "@chat/application";
import { hashCanonical } from "@chat/domain";
import type { Hono } from "hono";

export type ProductRouter = Hono<{ Variables: Variables }>;

export interface ProductRouteContext {
  readonly deps: ApplicationDeps;
  readonly principalId: PrincipalId;
  readonly planeEnabled: boolean;
  readonly planeCoordinationCredential?: string;
}

export type Variables = { requestId: RequestId };

export function problem(
  c: { json: (body: unknown, status: number) => Response; get: (key: "requestId") => RequestId },
  options: {
    status: number;
    code: ProblemDetail["code"];
    title: string;
    retryable: boolean;
    recoveryAction: ProblemDetail["recoveryAction"];
  },
): Response {
  const body: ProblemDetail = {
    type: `https://chat.dev/problems/${options.code.replaceAll("_", "-")}`,
    title: options.title,
    status: options.status,
    code: options.code,
    requestId: c.get("requestId"),
    retryable: options.retryable,
    recoveryAction: options.recoveryAction,
  };
  return c.json(problemDetailSchema.parse(body), options.status);
}

export function mapError(
  c: { json: (body: unknown, status: number) => Response; get: (key: "requestId") => RequestId },
  error: unknown,
): Response {
  if (error instanceof ApplicationError) {
    return problem(c, {
      status: error.httpStatus,
      code: error.code,
      title: error.message,
      retryable: error.retryable,
      recoveryAction: error.recoveryAction,
    });
  }
  if (error instanceof CommandIdReusedError) {
    return problem(c, {
      status: 409,
      code: "command_id_reused",
      title: "commandId已被不同请求使用",
      retryable: false,
      recoveryAction: "none",
    });
  }
  if (error instanceof StoreCorruptedError) {
    return problem(c, {
      status: 500,
      code: "store_corrupted",
      title: "Product Store不可用",
      retryable: false,
      recoveryAction: "contact_support",
    });
  }
  if (error instanceof ZodError) {
    return problem(c, {
      status: 400,
      code: "validation_failed",
      title: "请求不符合合同",
      retryable: false,
      recoveryAction: "none",
    });
  }
  // 未知异常属于产品API失败边界：只记录错误类别与消息，禁止把请求Payload、
  // Provider内容或Prompt正文写入常规日志。requestId用于关联按模块开启的Trace。
  console.error("[chat-api] request_failed", {
    requestId: c.get("requestId"),
    errorName: error instanceof Error ? error.name : "UnknownError",
    errorMessage: error instanceof Error ? error.message : "unknown error",
  });
  return problem(c, {
    status: 500,
    code: "internal_error",
    title: "内部错误",
    retryable: false,
    recoveryAction: "none",
  });
}

export async function parseJsonBody(c: {
  req: { json: () => Promise<unknown> };
}): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new ApplicationError({
      code: "validation_failed",
      httpStatus: 400,
      message: "请求体不是合法JSON",
    });
  }
}

export function parseMessagePageQuery(url: string): {
  cursor?: string | undefined;
  limit?: number | undefined;
} {
  const params = new URL(url).searchParams;
  for (const key of params.keys()) {
    if (key !== "cursor" && key !== "limit") {
      throw new ApplicationError({
        code: "validation_failed",
        httpStatus: 400,
        message: "消息分页查询包含未知参数",
      });
    }
  }
  const cursors = params.getAll("cursor");
  const limits = params.getAll("limit");
  if (cursors.length > 1 || limits.length > 1) {
    throw new ApplicationError({
      code: "validation_failed",
      httpStatus: 400,
      message: "消息分页参数不得重复",
    });
  }
  const cursor = cursors[0];
  const limitRaw = limits[0];
  if (limitRaw !== undefined && !/^[0-9]+$/u.test(limitRaw)) {
    throw new ApplicationError({
      code: "validation_failed",
      httpStatus: 400,
      message: "limit必须是1到200的整数",
    });
  }
  const limit = limitRaw !== undefined ? Number(limitRaw) : undefined;
  return cursorPageRequestSchema.parse({
    ...(cursor !== undefined ? { cursor } : {}),
    ...(limit !== undefined ? { limit } : {}),
  });
}

export function assertNoQuery(url: string): void {
  if ([...new URL(url).searchParams.keys()].length !== 0) {
    throw new ApplicationError({
      code: "validation_failed",
      httpStatus: 400,
      message: "该查询不接受Query参数",
    });
  }
}

export function parseAgentProfilesQuery(url: string): { workspaceRootId?: string | undefined } {
  const params = strictQueryParams(url, ["workspaceRootId"], "Agent Profile查询");
  const workspaceRootId = promptWorkspaceRootIdSchema
    .optional()
    .parse(params.get("workspaceRootId") ?? undefined);
  return workspaceRootId === undefined ? {} : { workspaceRootId };
}

export function parseWorkflowResourcesQuery(url: string): {
  resourceKind?: "memory" | "project" | "rule" | "skill" | undefined;
} {
  const params = new URL(url).searchParams;
  if ([...params.keys()].some((key) => key !== "kind") || params.getAll("kind").length > 1) {
    throw new ApplicationError({
      code: "validation_failed",
      httpStatus: 400,
      message: "Workflow资源查询包含未知或重复参数",
    });
  }
  const kind = params.get("kind");
  if (kind === null) return {};
  if (kind !== "memory" && kind !== "project" && kind !== "rule" && kind !== "skill") {
    throw new ApplicationError({
      code: "validation_failed",
      httpStatus: 400,
      message: "Workflow资源kind非法",
    });
  }
  return { resourceKind: kind };
}

export function strictQueryParams(
  url: string,
  allowedKeys: readonly string[],
  label: string,
): URLSearchParams {
  const params = new URL(url).searchParams;
  const allowed = new Set(allowedKeys);
  for (const key of params.keys()) {
    if (!allowed.has(key) || params.getAll(key).length > 1) {
      throw new ApplicationError({
        code: "validation_failed",
        httpStatus: 400,
        message: `${label}包含未知或重复参数`,
      });
    }
  }
  return params;
}

export function parseOptionalPositiveInteger(
  params: URLSearchParams,
  key: string,
  label: string,
): number | undefined {
  const raw = params.get(key);
  if (raw === null) return undefined;
  if (!/^[1-9][0-9]*$/u.test(raw)) {
    throw new ApplicationError({
      code: "validation_failed",
      httpStatus: 400,
      message: `${label}必须是正整数`,
    });
  }
  return Number(raw);
}

export function parseWorkflowNodeIncludes(url: string) {
  const params = new URL(url).searchParams;
  if ([...params.keys()].some((key) => key !== "include") || params.getAll("include").length > 1) {
    throw new ApplicationError({
      code: "validation_failed",
      httpStatus: 400,
      message: "Workflow Node查询包含未知或重复参数",
    });
  }
  const raw = params.get("include");
  if (raw === null) return undefined;
  if (raw.length === 0) {
    throw new ApplicationError({
      code: "validation_failed",
      httpStatus: 400,
      message: "include不能为空",
    });
  }
  return raw.split(",").map((value) => workflowNodeDetailIncludeSchema.parse(value));
}

export function matchesEtag(ifNoneMatch: string | undefined, etag: string): boolean {
  if (ifNoneMatch === undefined) return false;
  return ifNoneMatch
    .split(",")
    .map((value) => value.trim())
    .some((value) => value === "*" || value === etag);
}

export function privateEtagJson(
  c: Context<{ Variables: Variables }>,
  namespace: string,
  value: object,
): Response {
  const etag = `"${hashCanonical(`http.query.${namespace}.v1`, value)}"`;
  c.header("ETag", etag);
  c.header("Cache-Control", "private, no-cache");
  c.header("Vary", "Authorization");
  if (matchesEtag(c.req.header("If-None-Match"), etag)) return c.body(null, 304);
  return c.json(value, 200);
}

export function emitCommandAccepted(
  ctx: ProductRouteContext,
  c: { get: (key: "requestId") => RequestId },
  input: {
    commandId: string;
    routeTemplate: string;
    statusCode: number;
    productRunId?: string;
    productSessionId?: string;
  },
): void {
  if (ctx.deps.trace === undefined) return;
  try {
    const productRunId =
      input.productRunId === undefined ? undefined : productRunIdSchema.parse(input.productRunId);
    const productSessionId =
      input.productSessionId === undefined
        ? undefined
        : productSessionIdSchema.parse(input.productSessionId);
    ctx.deps.trace({
      level: "info",
      eventName: "http.command.accepted",
      outcome: "success",
      traceId: productRunId !== undefined ? runTraceId(productRunId) : c.get("requestId"),
      spanId: newSpanId(),
      requestId: c.get("requestId"),
      httpMethod: "POST",
      routeTemplate: input.routeTemplate,
      statusCode: input.statusCode,
      commandId: commandIdSchema.parse(input.commandId),
      ...(productRunId !== undefined ? { productRunId } : {}),
      ...(productSessionId !== undefined ? { productSessionId } : {}),
    });
  } catch {
    // Trace故障不能把已经提交的产品命令改写成HTTP失败。
  }
}
