import { problemDetailSchema, type ProblemCode, type RecoveryAction } from "@chat/contracts/public";

/**
 * Chat公开HTTP传输边界。这里只处理网络、Problem Detail、严格响应解析和ETag缓存；
 * 领域路径及DTO分别由对应client模块拥有。
 */
export class ApiProblemError extends Error {
  readonly code: ProblemCode | "network_unknown";
  readonly httpStatus: number | undefined;
  readonly retryable: boolean;
  readonly recoveryAction: RecoveryAction;

  constructor(options: {
    code: ProblemCode | "network_unknown";
    httpStatus?: number;
    retryable: boolean;
    recoveryAction: RecoveryAction;
  }) {
    super(options.code);
    this.name = "ApiProblemError";
    this.code = options.code;
    this.httpStatus = options.httpStatus;
    this.retryable = options.retryable;
    this.recoveryAction = options.recoveryAction;
  }
}

async function parseProblem(res: Response): Promise<never> {
  try {
    const problem = problemDetailSchema.parse(await res.json());
    throw new ApiProblemError({
      code: problem.code,
      httpStatus: problem.status,
      retryable: problem.retryable,
      recoveryAction: problem.recoveryAction,
    });
  } catch (error) {
    if (error instanceof ApiProblemError) throw error;
    throw new ApiProblemError({
      code: "internal_error",
      httpStatus: res.status,
      retryable: false,
      recoveryAction: "none",
    });
  }
}

/**
 * 公开Command传输边界。HTTP非2xx是服务端已分类失败；fetch异常或2xx响应无法通过Schema时，
 * 服务端可能已经提交，因此统一归为network_unknown，由上层复用原commandId人工重试。
 * 本函数不做自动重试，避免把一次用户意图变成两次写命令。
 */
export async function post<TRes>(
  path: string,
  body: unknown,
  parse: (json: unknown) => TRes,
  signal?: AbortSignal,
): Promise<TRes> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    // 网络结果未知：调用方必须保留相同commandId供用户手动重试
    throw new ApiProblemError({
      code: "network_unknown",
      retryable: true,
      recoveryAction: "retry_same_command",
    });
  }
  if (!res.ok) return parseProblem(res);
  try {
    return parse(await res.json());
  } catch {
    // 2xx已经越过服务端命令边界；响应截断/合同损坏时结果未知，必须保留同一commandId。
    throw new ApiProblemError({
      code: "network_unknown",
      retryable: true,
      recoveryAction: "retry_same_command",
    });
  }
}

/**
 * 公开Query传输边界。Query无产品副作用，可以由TanStack Query按页面可见性和Run状态重新读取；
 * 即使HTTP 200也必须通过对应DTO Schema，防止损坏或越界字段进入React状态。
 */
export async function get<TRes>(path: string, parse: (json: unknown) => TRes): Promise<TRes> {
  let res: Response;
  try {
    res = await fetch(path);
  } catch {
    throw new ApiProblemError({
      code: "network_unknown",
      retryable: true,
      recoveryAction: "retry_same_command",
    });
  }
  if (!res.ok) return parseProblem(res);
  return parse(await res.json());
}

interface WorkflowQueryCacheEntry<T> {
  readonly etag: string;
  readonly value: T;
}

const workflowQueryCache = new Map<string, WorkflowQueryCacheEntry<unknown>>();

/**
 * Workflow详情可能被短轮询频繁读取，因此在传输边界使用ETag；304只复用同URL、
 * 已通过公开Schema校验的内存快照。缓存不是产品事实，刷新或切Principal后可安全丢弃。
 */
export async function getWorkflowProjection<T>(
  path: string,
  parse: (json: unknown) => T,
  signal?: AbortSignal,
): Promise<T> {
  const cached = workflowQueryCache.get(path) as WorkflowQueryCacheEntry<T> | undefined;
  let response: Response;
  try {
    response = await fetch(path, {
      ...(cached === undefined ? {} : { headers: { "If-None-Match": cached.etag } }),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiProblemError({
      code: "network_unknown",
      retryable: true,
      recoveryAction: "retry_same_command",
    });
  }
  if (response.status === 304) {
    if (cached !== undefined) return cached.value;
    throw new ApiProblemError({
      code: "internal_error",
      httpStatus: 304,
      retryable: true,
      recoveryAction: "none",
    });
  }
  if (!response.ok) return parseProblem(response);
  let value: T;
  try {
    value = parse(await response.json());
  } catch {
    throw new ApiProblemError({
      code: "internal_error",
      httpStatus: response.status,
      retryable: true,
      recoveryAction: "none",
    });
  }
  const etag = response.headers.get("ETag");
  if (etag !== null) workflowQueryCache.set(path, { etag, value });
  return value;
}

export function clearWorkflowProjectionTransportCache(): void {
  workflowQueryCache.clear();
}
