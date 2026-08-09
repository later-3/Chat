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
  projectCandidateDecisionPayloadSchema,
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
  type ProjectCandidateDecisionPayload,
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
