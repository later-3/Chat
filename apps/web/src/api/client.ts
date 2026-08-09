import {
  approvalDtoSchema,
  commandEnvelopeSchema,
  createSessionPayloadSchema,
  cursorPageSchema,
  decisionDtoSchema,
  messageDtoSchema,
  memoryBackendProfileDtoSchema,
  planDtoSchema,
  problemDetailSchema,
  runDtoSchema,
  runContextDtoSchema,
  sessionDtoSchema,
  submitDecisionPayloadSchema,
  submitMessagePayloadSchema,
  createMemoryImportPayloadSchema,
  memoryImportDtoSchema,
  type ApprovalDto,
  type CommandId,
  type CursorPage,
  type DecisionDto,
  type MessageDto,
  type MemoryBackendProfileDto,
  type PlanDto,
  type ProblemCode,
  type RecoveryAction,
  type RunDto,
  type RunContextDto,
  type SessionDto,
  type SubmitDecisionPayload,
  type SubmitMessagePayload,
  type CreateMemoryImportPayload,
  type MemoryImportDto,
  beginProjectIntakePayloadSchema,
  beginProjectManagementCandidatePayloadSchema,
  beginProjectAdvancementPayloadSchema,
  projectAdvancementCandidateDecisionPayloadSchema,
  projectCandidateDecisionPayloadSchema,
  projectManagementCandidateDecisionPayloadSchema,
  projectCandidateDtoSchema,
  currentProjectCandidateResponseSchema,
  createProjectActionPayloadSchema,
  assignProjectActionPayloadSchema,
  transitionProjectActionPayloadSchema,
  recordProjectDecisionPayloadSchema,
  recordProjectContributionPayloadSchema,
  setProjectArchiveStatusPayloadSchema,
  projectRootDtoSchema,
  projectSummaryDtoSchema,
  projectWorkspaceDtoSchema,
  projectTimelineItemDtoSchema,
  type BeginProjectIntakePayload,
  type BeginProjectManagementCandidatePayload,
  type BeginProjectAdvancementPayload,
  type ProjectAdvancementCandidateDecisionPayload,
  type ProjectCandidateDecisionPayload,
  type ProjectManagementCandidateDecisionPayload,
  type ProjectCandidateDto,
  type ProjectRootDto,
  type ProjectSummaryDto,
  type ProjectWorkspaceDto,
  type ProjectTimelineItemDto,
  type CreateProjectActionPayload,
  type AssignProjectActionPayload,
  type TransitionProjectActionPayload,
  type RecordProjectDecisionPayload,
  type RecordProjectContributionPayload,
  type SetProjectArchiveStatusPayload,
  workflowNodeDetailDtoSchema,
  workflowRunViewDtoSchema,
  type WorkflowNodeDetailDto,
  type WorkflowNodeDetailInclude,
  type WorkflowRunViewDto,
} from "@chat/contracts/public";
import { z } from "zod";

const sessionResponseSchema = z.object({ session: sessionDtoSchema }).strict();
const runResponseSchema = z.object({ run: runDtoSchema }).strict();
const plansResponseSchema = z.object({ items: z.array(planDtoSchema) }).strict();
const approvalResponseSchema = z.object({ approval: approvalDtoSchema.nullable() }).strict();
const memoryBackendsResponseSchema = z
  .object({ backends: z.array(memoryBackendProfileDtoSchema) })
  .strict();
const runContextResponseSchema = z.object({ context: runContextDtoSchema }).strict();
const submitMessageResponseSchema = z
  .object({ message: messageDtoSchema, run: runDtoSchema })
  .strict();
const submitDecisionResponseSchema = z
  .object({ decision: decisionDtoSchema, run: runDtoSchema })
  .strict();
const memoryImportResponseSchema = z.object({ memoryImport: memoryImportDtoSchema }).strict();
const memoryImportsResponseSchema = z
  .object({
    memoryImports: z.array(memoryImportDtoSchema).max(100),
    nextCursor: z.string().optional(),
  })
  .strict();
const projectRootsResponseSchema = z.object({ roots: z.array(projectRootDtoSchema) }).strict();
const projectCandidateResponseSchema = z.object({ candidate: projectCandidateDtoSchema }).strict();
const projectDecisionResponseSchema = z
  .object({ candidate: projectCandidateDtoSchema, project: projectWorkspaceDtoSchema.optional() })
  .strict();
const projectsResponseSchema = z.object({ projects: z.array(projectSummaryDtoSchema) }).strict();
const projectWorkspaceResponseSchema = z.object({ project: projectWorkspaceDtoSchema }).strict();
const projectTimelineResponseSchema = z
  .object({ items: z.array(projectTimelineItemDtoSchema) })
  .strict();

/**
 * Chat公开API的浏览器客户端。
 *
 * 边界：
 * - 只访问公开Query/Command合同；不接触任何Runtime私有端点或身份。
 * - 错误只暴露稳定code与recoveryAction；不得对错误message字符串做业务判断。
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
async function post<TRes>(
  path: string,
  body: unknown,
  parse: (json: unknown) => TRes,
): Promise<TRes> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
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
async function get<TRes>(path: string, parse: (json: unknown) => TRes): Promise<TRes> {
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
async function getWorkflowProjection<T>(
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

export function apiGetWorkflowRunView(
  productRunId: string,
  signal?: AbortSignal,
): Promise<WorkflowRunViewDto> {
  return getWorkflowProjection(
    `/api/runs/${encodeURIComponent(productRunId)}/workflow-view`,
    (json) => workflowRunViewDtoSchema.parse(json),
    signal,
  );
}

export function apiGetWorkflowNodeDetail(
  productRunId: string,
  workflowNodeRunId: string,
  includes: readonly WorkflowNodeDetailInclude[],
  signal?: AbortSignal,
): Promise<WorkflowNodeDetailDto> {
  const normalizedIncludes = [...new Set(includes)].sort();
  const query = new URLSearchParams({ include: normalizedIncludes.join(",") });
  return getWorkflowProjection(
    `/api/runs/${encodeURIComponent(productRunId)}/workflow-nodes/${encodeURIComponent(workflowNodeRunId)}?${query.toString()}`,
    (json) => workflowNodeDetailDtoSchema.parse(json),
    signal,
  );
}

/** 登录主体或测试隔离变化时只清浏览器投影，不影响任何服务端事实。 */
export function clearWorkflowProjectionTransportCache(): void {
  workflowQueryCache.clear();
}

export function apiCreateSession(commandId: CommandId, title?: string): Promise<SessionDto> {
  return post(
    "/api/sessions",
    commandEnvelopeSchema.parse({
      commandId,
      payload: createSessionPayloadSchema.parse(title !== undefined ? { title } : {}),
    }),
    (json) => sessionResponseSchema.parse(json).session,
  );
}

export function apiSubmitMessage(
  sessionId: string,
  commandId: CommandId,
  payload: SubmitMessagePayload,
): Promise<{ message: MessageDto; run: RunDto }> {
  // 调试导航③：公开HTTP合同边界。CommandEnvelope把可重试的commandId与业务payload分开；
  // 返回的Message/Run是服务端已提交事实，但只表示“消息与Run已受理”，不表示Workflow已完成。
  return post(
    `/api/sessions/${encodeURIComponent(sessionId)}/messages`,
    commandEnvelopeSchema.parse({
      commandId,
      payload: submitMessagePayloadSchema.parse(payload),
    }),
    (json) => {
      const body = submitMessageResponseSchema.parse(json);
      return { message: body.message, run: body.run };
    },
  );
}

export function apiGetMemoryBackends(): Promise<MemoryBackendProfileDto[]> {
  return get("/api/memory-backends", (json) => memoryBackendsResponseSchema.parse(json).backends);
}

export function apiGetRunContext(productRunId: string): Promise<RunContextDto> {
  return get(
    `/api/runs/${encodeURIComponent(productRunId)}/context`,
    (json) => runContextResponseSchema.parse(json).context,
  );
}

export function apiGetMessages(sessionId: string): Promise<CursorPage<MessageDto>> {
  return get(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, (json) =>
    cursorPageSchema(messageDtoSchema).parse(json),
  );
}

export function apiGetRun(productRunId: string): Promise<RunDto> {
  return get(
    `/api/runs/${encodeURIComponent(productRunId)}`,
    (json) => runResponseSchema.parse(json).run,
  );
}

export function apiGetPlans(productRunId: string): Promise<PlanDto[]> {
  return get(
    `/api/runs/${encodeURIComponent(productRunId)}/plans`,
    (json) => plansResponseSchema.parse(json).items,
  );
}

export function apiGetCurrentApproval(productRunId: string): Promise<ApprovalDto | null> {
  return get(
    `/api/runs/${encodeURIComponent(productRunId)}/approvals/current`,
    (json) => approvalResponseSchema.parse(json).approval,
  );
}

export function apiSubmitDecision(input: {
  productRunId: string;
  commandId: CommandId;
  expectedRunRevision: number;
  payload: SubmitDecisionPayload;
}): Promise<{ decision: DecisionDto; run: RunDto }> {
  // Decision同时绑定Run revision（CAS）和Plan三元组（ID/revision/Hash）；
  // API返回Decision/Run仍只代表产品事务成功，Workflow Resume在Outbox中异步发生。
  return post(
    `/api/runs/${encodeURIComponent(input.productRunId)}/decisions`,
    commandEnvelopeSchema.parse({
      commandId: input.commandId,
      expectedRevision: input.expectedRunRevision,
      payload: submitDecisionPayloadSchema.parse(input.payload),
    }),
    (json) => {
      const body = submitDecisionResponseSchema.parse(json);
      return { decision: body.decision, run: body.run };
    },
  );
}

export function apiCreateMemoryImport(input: {
  commandId: CommandId;
  payload: CreateMemoryImportPayload;
}): Promise<MemoryImportDto> {
  return post(
    "/api/memory-imports",
    commandEnvelopeSchema.parse({
      commandId: input.commandId,
      payload: createMemoryImportPayloadSchema.parse(input.payload),
    }),
    (json) => memoryImportResponseSchema.parse(json).memoryImport,
  );
}

export function apiGetSessionMemoryImports(sessionId: string): Promise<MemoryImportDto[]> {
  return get(
    `/api/sessions/${encodeURIComponent(sessionId)}/memory-imports`,
    (json) => memoryImportsResponseSchema.parse(json).memoryImports,
  );
}

export function apiReconcileMemoryImport(input: {
  memoryImportIntentId: string;
  commandId: CommandId;
  expectedResultRevision: number;
}): Promise<MemoryImportDto> {
  return post(
    `/api/memory-imports/${encodeURIComponent(input.memoryImportIntentId)}/reconcile`,
    commandEnvelopeSchema.parse({
      commandId: input.commandId,
      expectedRevision: input.expectedResultRevision,
      payload: {},
    }),
    (json) => memoryImportResponseSchema.parse(json).memoryImport,
  );
}

export function apiGetProjectRoots(): Promise<ProjectRootDto[]> {
  return get("/api/project-roots", (json) => projectRootsResponseSchema.parse(json).roots);
}

export function apiBeginProjectIntake(input: {
  commandId: CommandId;
  payload: BeginProjectIntakePayload;
}): Promise<ProjectCandidateDto> {
  return post(
    "/api/project-intakes",
    commandEnvelopeSchema.parse({
      commandId: input.commandId,
      payload: beginProjectIntakePayloadSchema.parse(input.payload),
    }),
    (json) => projectCandidateResponseSchema.parse(json).candidate,
  );
}

export function apiBeginProjectManagementCandidate(input: {
  commandId: CommandId;
  payload: BeginProjectManagementCandidatePayload;
}): Promise<ProjectCandidateDto> {
  return post(
    "/api/project-management-candidates",
    commandEnvelopeSchema.parse({
      commandId: input.commandId,
      payload: beginProjectManagementCandidatePayloadSchema.parse(input.payload),
    }),
    (json) => projectCandidateResponseSchema.parse(json).candidate,
  );
}

export function apiBeginProjectAdvancement(input: {
  commandId: CommandId;
  payload: BeginProjectAdvancementPayload;
}): Promise<ProjectCandidateDto> {
  return post(
    "/api/project-advancements",
    commandEnvelopeSchema.parse({
      commandId: input.commandId,
      payload: beginProjectAdvancementPayloadSchema.parse(input.payload),
    }),
    (json) => projectCandidateResponseSchema.parse(json).candidate,
  );
}

export function apiGetProjectCandidate(projectCandidateId: string): Promise<ProjectCandidateDto> {
  return get(
    `/api/project-candidates/${encodeURIComponent(projectCandidateId)}`,
    (json) => projectCandidateResponseSchema.parse(json).candidate,
  );
}

export function apiGetCurrentProjectCandidate(
  sessionId: string,
): Promise<ReturnType<typeof currentProjectCandidateResponseSchema.parse>> {
  return get(`/api/sessions/${encodeURIComponent(sessionId)}/project-candidates/current`, (json) =>
    currentProjectCandidateResponseSchema.parse(json),
  );
}

export function apiDecideProjectCandidate(input: {
  projectCandidateId: string;
  commandId: CommandId;
  expectedRevision: number;
  payload: ProjectCandidateDecisionPayload;
}): Promise<{ candidate: ProjectCandidateDto; project?: ProjectWorkspaceDto }> {
  return post(
    `/api/project-candidates/${encodeURIComponent(input.projectCandidateId)}/decisions`,
    commandEnvelopeSchema.parse({
      commandId: input.commandId,
      expectedRevision: input.expectedRevision,
      payload: projectCandidateDecisionPayloadSchema.parse(input.payload),
    }),
    (json) => {
      const body = projectDecisionResponseSchema.parse(json);
      return body.project === undefined
        ? { candidate: body.candidate }
        : { candidate: body.candidate, project: body.project };
    },
  );
}

export function apiDecideProjectManagementCandidate(input: {
  projectCandidateId: string;
  commandId: CommandId;
  expectedRevision: number;
  payload: ProjectManagementCandidateDecisionPayload;
}): Promise<{ candidate: ProjectCandidateDto; project: ProjectWorkspaceDto }> {
  return post(
    `/api/project-management-candidates/${encodeURIComponent(input.projectCandidateId)}/decisions`,
    commandEnvelopeSchema.parse({
      commandId: input.commandId,
      expectedRevision: input.expectedRevision,
      payload: projectManagementCandidateDecisionPayloadSchema.parse(input.payload),
    }),
    (json) => {
      const body = projectDecisionResponseSchema.parse(json);
      if (body.project === undefined) throw new Error("管理Candidate确认响应缺少Project");
      return { candidate: body.candidate, project: body.project };
    },
  );
}

export function apiDecideProjectAdvancementCandidate(input: {
  projectCandidateId: string;
  commandId: CommandId;
  expectedRevision: number;
  payload: ProjectAdvancementCandidateDecisionPayload;
}): Promise<{ candidate: ProjectCandidateDto; project: ProjectWorkspaceDto }> {
  return post(
    `/api/project-advancements/${encodeURIComponent(input.projectCandidateId)}/decisions`,
    commandEnvelopeSchema.parse({
      commandId: input.commandId,
      expectedRevision: input.expectedRevision,
      payload: projectAdvancementCandidateDecisionPayloadSchema.parse(input.payload),
    }),
    (json) => {
      const body = projectDecisionResponseSchema.parse(json);
      if (body.project === undefined) throw new Error("推进Candidate响应缺少Project");
      return { candidate: body.candidate, project: body.project };
    },
  );
}

export function apiListProjects(): Promise<ProjectSummaryDto[]> {
  return get("/api/projects", (json) => projectsResponseSchema.parse(json).projects);
}

export function apiGetProject(projectId: string): Promise<ProjectWorkspaceDto> {
  return get(
    `/api/projects/${encodeURIComponent(projectId)}`,
    (json) => projectWorkspaceResponseSchema.parse(json).project,
  );
}

export function apiGetProjectTimeline(projectId: string): Promise<ProjectTimelineItemDto[]> {
  return get(
    `/api/projects/${encodeURIComponent(projectId)}/timeline`,
    (json) => projectTimelineResponseSchema.parse(json).items,
  );
}

export function apiCreateProjectAction(input: {
  projectId: string;
  commandId: CommandId;
  payload: CreateProjectActionPayload;
}): Promise<ProjectWorkspaceDto> {
  return post(
    `/api/projects/${encodeURIComponent(input.projectId)}/actions`,
    commandEnvelopeSchema.parse({
      commandId: input.commandId,
      payload: createProjectActionPayloadSchema.parse(input.payload),
    }),
    (json) => projectWorkspaceResponseSchema.parse(json).project,
  );
}

export function apiAssignProjectAction(input: {
  actionId: string;
  commandId: CommandId;
  expectedRevision: number;
  payload: AssignProjectActionPayload;
}): Promise<ProjectWorkspaceDto> {
  return post(
    `/api/project-actions/${encodeURIComponent(input.actionId)}/assignments`,
    commandEnvelopeSchema.parse({
      commandId: input.commandId,
      expectedRevision: input.expectedRevision,
      payload: assignProjectActionPayloadSchema.parse(input.payload),
    }),
    (json) => projectWorkspaceResponseSchema.parse(json).project,
  );
}

export function apiTransitionProjectAction(input: {
  actionId: string;
  commandId: CommandId;
  expectedRevision: number;
  payload: TransitionProjectActionPayload;
}): Promise<ProjectWorkspaceDto> {
  return post(
    `/api/project-actions/${encodeURIComponent(input.actionId)}/transitions`,
    commandEnvelopeSchema.parse({
      commandId: input.commandId,
      expectedRevision: input.expectedRevision,
      payload: transitionProjectActionPayloadSchema.parse(input.payload),
    }),
    (json) => projectWorkspaceResponseSchema.parse(json).project,
  );
}

export function apiObserveProjectResource(input: {
  projectId: string;
  resourceId: string;
  commandId: CommandId;
}): Promise<ProjectWorkspaceDto> {
  return post(
    `/api/projects/${encodeURIComponent(input.projectId)}/observations`,
    commandEnvelopeSchema.parse({
      commandId: input.commandId,
      payload: { resourceId: input.resourceId },
    }),
    (json) => projectWorkspaceResponseSchema.parse(json).project,
  );
}

export function apiRecordProjectDecision(input: {
  projectId: string;
  commandId: CommandId;
  expectedRevision: number;
  payload: RecordProjectDecisionPayload;
}): Promise<ProjectWorkspaceDto> {
  return post(
    `/api/projects/${encodeURIComponent(input.projectId)}/decision-candidates`,
    commandEnvelopeSchema.parse({
      commandId: input.commandId,
      expectedRevision: input.expectedRevision,
      payload: recordProjectDecisionPayloadSchema.parse(input.payload),
    }),
    (json) => projectWorkspaceResponseSchema.parse(json).project,
  );
}

export function apiRecordProjectContribution(input: {
  projectId: string;
  commandId: CommandId;
  payload: RecordProjectContributionPayload;
}): Promise<ProjectWorkspaceDto> {
  return post(
    `/api/projects/${encodeURIComponent(input.projectId)}/contribution-candidates`,
    commandEnvelopeSchema.parse({
      commandId: input.commandId,
      payload: recordProjectContributionPayloadSchema.parse(input.payload),
    }),
    (json) => projectWorkspaceResponseSchema.parse(json).project,
  );
}

export function apiSetProjectArchiveStatus(input: {
  projectId: string;
  commandId: CommandId;
  expectedRevision: number;
  payload: SetProjectArchiveStatusPayload;
}): Promise<ProjectWorkspaceDto> {
  return post(
    `/api/projects/${encodeURIComponent(input.projectId)}/archive-status`,
    commandEnvelopeSchema.parse({
      commandId: input.commandId,
      expectedRevision: input.expectedRevision,
      payload: setProjectArchiveStatusPayloadSchema.parse(input.payload),
    }),
    (json) => projectWorkspaceResponseSchema.parse(json).project,
  );
}
