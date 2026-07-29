/** 后端统一Problem Detail合同：稳定code、脱敏message、请求关联ID与可恢复标记。 */
export interface ApiProblem {
  code: string;
  message: string;
  request_id: string;
  retryable: boolean;
  details: Record<string, unknown> | null;
}

export type ApiRecoveryAction =
  | "refresh"
  | "retry"
  | "review"
  | "expired"
  | "authenticate"
  | "contact_support";

function isApiProblem(value: unknown): value is ApiProblem {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ApiProblem>;
  return (
    typeof candidate.code === "string" &&
    typeof candidate.message === "string" &&
    typeof candidate.request_id === "string" &&
    typeof candidate.retryable === "boolean" &&
    (candidate.details === null ||
      (typeof candidate.details === "object" && !Array.isArray(candidate.details)))
  );
}

/** 状态码到恢复动作的映射：401/403重新认证、409刷新、410过期、422审查输入。 */
function recoveryAction(problem: ApiProblem, status: number): ApiRecoveryAction {
  if (status === 401 || status === 403) return "authenticate";
  if (status === 409) return "refresh";
  if (status === 410) return "expired";
  if (status === 422) return "review";
  if (problem.retryable) return "retry";
  return "contact_support";
}

/** 携带Problem Detail的API错误；UI按recoveryAction呈现恢复入口，而不是裸状态码。 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | null;
  readonly recoveryAction: ApiRecoveryAction;

  constructor(status: number, problem: ApiProblem) {
    super(problem.message);
    this.name = "ApiError";
    this.status = status;
    this.code = problem.code;
    this.requestId = problem.request_id;
    this.retryable = problem.retryable;
    this.details = problem.details;
    this.recoveryAction = recoveryAction(problem, status);
  }
}

/** 旧格式错误响应的兼容投影：统一收敛为Problem Detail，新代码不再产生该格式。 */
function legacyProblem(payload: unknown, response: Response, fallback: string): ApiProblem {
  const detail =
    payload && typeof payload === "object"
      ? (payload as { detail?: string | { message?: string; code?: string } }).detail
      : null;
  const message =
    typeof detail === "string"
      ? detail
      : (detail?.message ?? fallback ?? `请求失败：HTTP ${response.status}`);
  return {
    code:
      typeof detail === "object" && typeof detail?.code === "string"
        ? detail.code
        : `HTTP_${response.status}`,
    message,
    request_id: response.headers.get("x-request-id") ?? "unknown",
    retryable: [429, 502, 503, 504].includes(response.status),
    details: null,
  };
}

export async function apiErrorFromResponse(
  response: Response,
  fallback = `请求失败：HTTP ${response.status}`,
): Promise<ApiError> {
  const payload = (await response.json().catch(() => null)) as unknown;
  const problem = isApiProblem(payload) ? payload : legacyProblem(payload, response, fallback);
  return new ApiError(response.status, problem);
}

export async function checkedJson<T>(response: Response, fallback?: string): Promise<T> {
  if (!response.ok) throw await apiErrorFromResponse(response, fallback);
  return response.json() as Promise<T>;
}
