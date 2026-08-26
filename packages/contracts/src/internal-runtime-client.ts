import {
  commitExecutionResultResponseSchema,
  commitRejectedRunRequestSchema,
  commitRunFailureRequestSchema,
  completeRunAttemptRequestSchema,
  beginRunAttemptRequestSchema,
  beginRunAttemptResponseSchema,
  authorizeExecutorOperationRequestSchema,
  authorizeExecutorOperationResponseSchema,
  expireApprovalRequestSchema,
  expireApprovalResponseSchema,
  compileExecutionContractResponseSchema,
  loadCommittedDecisionResponseSchema,
  persistExecutionCandidateResponseSchema,
  persistValidationResultResponseSchema,
  planningInputDtoSchema,
  beginPlanningContextResponseSchema,
  preparePlanningContextResponseSchema,
  persistPlanningContextResultRequestSchema,
  publishPlanReviewResponseSchema,
  problemDetailSchema,
  runRevisionResponseSchema,
  loadMemoryImportResponseSchema,
  memoryImportResultResponseSchema,
  markMemoryImportDispatchingRequestSchema,
  commitMemoryImportAcceptedRequestSchema,
  commitMemoryImportMaterializedRequestSchema,
  commitMemoryImportFailedRequestSchema,
  commitMemoryImportOutcomeUnknownRequestSchema,
  loadMemoryWriteResponseSchema,
  beginWorkflowMemoryWriteRequestSchema,
  beginWorkflowMemoryWriteResponseSchema,
  memoryWriteResultResponseSchema,
  loadMemoryWriteRequestSchema,
  markMemoryWriteDispatchingRequestSchema,
  commitMemoryWriteAcceptedRequestSchema,
  commitMemoryWriteMaterializedRequestSchema,
  commitMemoryWriteFailedRequestSchema,
  commitMemoryWriteOutcomeUnknownRequestSchema,
  INTERNAL_RUNTIME_SCHEMA_VERSION,
  MEMORY_IMPORT_WORKFLOW_DEFINITION_VERSION,
  MEMORY_WRITE_WORKFLOW_DEFINITION_VERSION,
  type CompilePlanningInputRequest,
  type AuthorizeExecutorOperationRequest,
  type CommitExecutionResultRequest,
  type CompileExecutionContractRequest,
  type LoadCommittedDecisionRequest,
  type PersistExecutionCandidateRequest,
  type PersistValidationResultRequest,
  type PreparePlanningContextRequest,
  type PersistPlanningContextResultRequest,
  type PublishPlanReviewRequest,
  type LoadMemoryImportRequest,
  type LoadMemoryWriteRequest,
  prepareProjectCandidateRequestSchema,
  prepareProjectAdvancementCandidateRequestSchema,
  projectCandidateDtoSchema,
  loadWorkflowRunSpecRequestSchema,
  loadWorkflowRunSpecResponseSchema,
  transitionConfigurablePlanningNodeRequestSchema,
  preparePlanningMemoryContextRequestSchema,
  preparePlanningMemoryContextResponseSchema,
  preparePlanningProjectContextRequestSchema,
  preparePlanningProjectContextResponseSchema,
  preparePlanningRulesContextRequestSchema,
  preparePlanningRulesContextResponseSchema,
  prepareGovernanceReviewInputRequestSchema,
  prepareGovernanceReviewInputResponseSchema,
  commitRunOutcomeUnknownRuntimeRequestSchema,
  publishNoteCandidateRuntimeRequestSchema,
  publishNoteCandidateRuntimeResponseSchema,
  prepareNoteCaptureInputRuntimeRequestSchema,
  prepareNoteCaptureInputRuntimeResponseSchema,
  loadNoteDecisionRuntimeRequestSchema,
  loadNoteDecisionRuntimeResponseSchema,
  commitConfirmedNoteRuntimeRequestSchema,
  commitConfirmedNoteRuntimeResponseSchema,
  beginWorkflowMemoryQueryRequestSchema,
  beginWorkflowMemoryQueryResponseSchema,
  persistWorkflowMemoryQueryResultRequestSchema,
  persistWorkflowMemoryQueryResultResponseSchema,
  freezeWorkflowMemoryContextRequestSchema,
  freezeWorkflowMemoryContextResponseSchema,
  DIRECT_AGENT_INTERNAL_RUNTIME_SCHEMA_VERSION,
  DIRECT_AGENT_RUNTIME_PATHS,
  beginDirectAgentAttemptRuntimeRequestSchema,
  beginDirectAgentAttemptRuntimeResponseSchema,
  loadPromptReviewDecisionRuntimeRequestSchema,
  loadPromptReviewDecisionRuntimeResponseSchema,
  commitDirectAgentResultRuntimeRequestSchema,
  commitDirectAgentResultRuntimeResponseSchema,
  type LoadWorkflowRunSpecRequest,
  type TransitionConfigurablePlanningNodeRequest,
  type PreparePlanningMemoryContextRequest,
  type PreparePlanningProjectContextRequest,
  type PreparePlanningRulesContextRequest,
  type PrepareGovernanceReviewInputRequest,
  type PublishNoteCandidateRuntimeRequest,
  type PrepareNoteCaptureInputRuntimeRequest,
  type LoadNoteDecisionRuntimeRequest,
  type CommitConfirmedNoteRuntimeRequest,
  type BeginWorkflowMemoryQueryRequest,
  type BeginWorkflowMemoryWriteRequest,
  type PersistWorkflowMemoryQueryResultRequest,
  type FreezeWorkflowMemoryContextRequest,
  type BeginDirectAgentAttemptRuntimeRequest,
  type LoadPromptReviewDecisionRuntimeRequest,
  type CommitDirectAgentResultRuntimeRequest,
} from "./internal-runtime-client-dependencies.js";
import { z, type ZodType } from "zod";

/**
 * Workflow Runtime -> API私有Runtime Router的类型化客户端。
 *
 * 边界：
 * - 只调用后端私有Application Command；不直接读写Product Store。
 * - 凭据只在服务端内存中使用；所有请求/响应经Zod校验。
 * - 网络未知结果与业务冲突是不同错误族：unknown不自动重试付费路径。
 */

export class ApiClientError extends Error {
  readonly code: string;
  readonly httpStatus: number | undefined;
  readonly retryable: boolean;
  constructor(options: {
    code: string;
    message: string;
    httpStatus?: number;
    retryable?: boolean;
  }) {
    super(options.message);
    this.name = "ApiClientError";
    this.code = options.code;
    this.httpStatus = options.httpStatus;
    this.retryable = options.retryable ?? false;
  }
}

export interface RuntimeApiClientOptions {
  readonly baseUrl: string;
  readonly credential: string;
}

/**
 * Workflow Step到API私有Application Router的传输边界。
 *
 * 这里与浏览器客户端不同：调用方是可重放的耐久Step，但网络结果未知仍不能在本层随意重试。
 * 请求是否可重放由具体Step的稳定commandId和副作用语义决定；本函数只负责凭据、超时、
 * Problem Detail分类以及请求/响应Schema校验，不把HTTP成功等同于产品终态。
 */
async function call<TReq, TRes>(
  options: RuntimeApiClientOptions,
  path: string,
  body: TReq,
  responseSchema: ZodType<TRes>,
  timeoutMs = 30_000,
): Promise<TRes> {
  let response: Response;
  try {
    response = await fetch(`${options.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-chat-runtime-key": options.credential,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new ApiClientError({
      code: "dispatch.outcome_unknown",
      message: `私有命令网络结果未知:${path}`,
      retryable: true,
    });
  }
  if (!response.ok) {
    let problem: ReturnType<typeof problemDetailSchema.parse>;
    try {
      problem = problemDetailSchema.parse(await response.json());
    } catch {
      throw new ApiClientError({
        code: "internal_error",
        message: `私有命令错误响应合同损坏:${path}`,
        httpStatus: response.status,
        retryable: response.status >= 500,
      });
    }
    throw new ApiClientError({
      code: problem.code,
      message: `私有命令被拒绝:${path}:${problem.code}:${problem.title}`,
      httpStatus: response.status,
      retryable: problem.retryable,
    });
  }
  try {
    return responseSchema.parse(await response.json());
  } catch {
    throw new ApiClientError({
      code: "dispatch.outcome_unknown",
      message: `私有命令成功响应合同损坏:${path}`,
      retryable: true,
    });
  }
}

export function createRuntimeApiClient(options: RuntimeApiClientOptions) {
  return {
    /** 加载工作流运行规格：读取本轮运行的workflow定义、配置和身份（工作流启动时调用）。 */
    loadWorkflowRunSpec(input: Omit<LoadWorkflowRunSpecRequest, "schemaVersion">) {
      return call(
        options,
        "/internal/runtime/v1/load-workflow-run-spec",
        loadWorkflowRunSpecRequestSchema.parse({
          schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
          ...input,
        }),
        loadWorkflowRunSpecResponseSchema,
      );
    },
    /**
     * Direct Workflow创建唯一Direct Attempt。正文不进入请求；Application从冻结的
     * Product Run/Message/RunSpec重建并返回仅含Attempt与Manifest Hash的引用。
     */
    beginDirectAgentAttempt(input: Omit<BeginDirectAgentAttemptRuntimeRequest, "schemaVersion">) {
      return call(
        options,
        `/internal/runtime/v1${DIRECT_AGENT_RUNTIME_PATHS.beginAttempt}`,
        beginDirectAgentAttemptRuntimeRequestSchema.parse({
          schemaVersion: DIRECT_AGENT_INTERNAL_RUNTIME_SCHEMA_VERSION,
          ...input,
        }),
        beginDirectAgentAttemptRuntimeResponseSchema,
      );
    },
    /** Hook恢复后只读校验已提交Decision；该响应永远不包含Provider Payload正文。 */
    loadPromptReviewDecision(input: Omit<LoadPromptReviewDecisionRuntimeRequest, "schemaVersion">) {
      return call(
        options,
        `/internal/runtime/v1${DIRECT_AGENT_RUNTIME_PATHS.loadPromptReviewDecision}`,
        loadPromptReviewDecisionRuntimeRequestSchema.parse({
          schemaVersion: DIRECT_AGENT_INTERNAL_RUNTIME_SCHEMA_VERSION,
          ...input,
        }),
        loadPromptReviewDecisionRuntimeResponseSchema,
      );
    },
    /** Executor已持久化Candidate后，由Workflow提交正式Assistant Message与Run终态。 */
    commitDirectAgentResult(input: Omit<CommitDirectAgentResultRuntimeRequest, "schemaVersion">) {
      return call(
        options,
        `/internal/runtime/v1${DIRECT_AGENT_RUNTIME_PATHS.commitResult}`,
        commitDirectAgentResultRuntimeRequestSchema.parse({
          schemaVersion: DIRECT_AGENT_INTERNAL_RUNTIME_SCHEMA_VERSION,
          ...input,
        }),
        commitDirectAgentResultRuntimeResponseSchema,
      );
    },
    /** 冻结可组合memory.query节点意图；不越过外部Provider边界。 */
    beginWorkflowMemoryQuery(input: Omit<BeginWorkflowMemoryQueryRequest, "schemaVersion">) {
      return call(
        options,
        "/internal/runtime/v1/begin-workflow-memory-query",
        beginWorkflowMemoryQueryRequestSchema.parse({
          schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
          ...input,
        }),
        beginWorkflowMemoryQueryResponseSchema,
      );
    },
    /** 独立Memory Planning中的write节点创建稳定Intent；普通Planning永远不会调用。 */
    beginWorkflowMemoryWrite(input: Omit<BeginWorkflowMemoryWriteRequest, "schemaVersion">) {
      return call(
        options,
        "/internal/runtime/v1/memory-write/begin-workflow-node",
        beginWorkflowMemoryWriteRequestSchema.parse({
          schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
          ...input,
        }),
        beginWorkflowMemoryWriteResponseSchema,
      );
    },
    /** 提交已checkpoint的Provider结果，并原子完成query节点。 */
    persistWorkflowMemoryQueryResult(
      input: Omit<PersistWorkflowMemoryQueryResultRequest, "schemaVersion">,
    ) {
      return call(
        options,
        "/internal/runtime/v1/persist-workflow-memory-query-result",
        persistWorkflowMemoryQueryResultRequestSchema.parse({
          schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
          ...input,
        }),
        persistWorkflowMemoryQueryResultResponseSchema,
      );
    },
    /** 在Planner前冻结本轮所有query为唯一Workflow Memory Context。 */
    freezeWorkflowMemoryContext(input: Omit<FreezeWorkflowMemoryContextRequest, "schemaVersion">) {
      return call(
        options,
        "/internal/runtime/v1/freeze-workflow-memory-context",
        freezeWorkflowMemoryContextRequestSchema.parse({
          schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
          ...input,
        }),
        freezeWorkflowMemoryContextResponseSchema,
      );
    },
    /** 准备规划Memory上下文：为可配置规划工作流预读Memory层上下文。 */
    preparePlanningMemoryContext(
      input: Omit<PreparePlanningMemoryContextRequest, "schemaVersion">,
    ) {
      return call(
        options,
        "/internal/runtime/v1/prepare-planning-memory-context",
        preparePlanningMemoryContextRequestSchema.parse({
          schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
          ...input,
        }),
        preparePlanningMemoryContextResponseSchema,
      );
    },
    /** 准备规划Project上下文：为可配置规划工作流预读Project层上下文。 */
    preparePlanningProjectContext(
      input: Omit<PreparePlanningProjectContextRequest, "schemaVersion">,
    ) {
      return call(
        options,
        "/internal/runtime/v1/prepare-planning-project-context",
        preparePlanningProjectContextRequestSchema.parse({
          schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
          ...input,
        }),
        preparePlanningProjectContextResponseSchema,
      );
    },
    /** 准备规划规则上下文：为可配置规划工作流预读用户规则集上下文。 */
    preparePlanningRulesContext(input: Omit<PreparePlanningRulesContextRequest, "schemaVersion">) {
      return call(
        options,
        "/internal/runtime/v1/prepare-planning-rules-context",
        preparePlanningRulesContextRequestSchema.parse({
          schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
          ...input,
        }),
        preparePlanningRulesContextResponseSchema,
      );
    },
    /** 准备笔记捕获输入：NoteCapture工作流组装捕获请求的不可变输入。 */
    prepareNoteCaptureInput(input: Omit<PrepareNoteCaptureInputRuntimeRequest, "schemaVersion">) {
      return call(
        options,
        "/internal/runtime/v1/prepare-note-capture-input",
        prepareNoteCaptureInputRuntimeRequestSchema.parse({
          schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
          ...input,
        }),
        prepareNoteCaptureInputRuntimeResponseSchema,
      );
    },
    /** 发布笔记候选：NoteCapture工作流把模型输出提交为待审核候选。 */
    publishNoteCandidate(input: Omit<PublishNoteCandidateRuntimeRequest, "schemaVersion">) {
      return call(
        options,
        "/internal/runtime/v1/publish-note-candidate",
        publishNoteCandidateRuntimeRequestSchema.parse({
          schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
          ...input,
        }),
        publishNoteCandidateRuntimeResponseSchema,
      );
    },
    /** 加载笔记决定：NoteCapture工作流读取用户对笔记候选的确认/拒绝决定。 */
    loadNoteDecision(input: Omit<LoadNoteDecisionRuntimeRequest, "schemaVersion">) {
      return call(
        options,
        "/internal/runtime/v1/load-note-decision",
        loadNoteDecisionRuntimeRequestSchema.parse({
          schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
          ...input,
        }),
        loadNoteDecisionRuntimeResponseSchema,
      );
    },
    /** 提交确认笔记：NoteCapture工作流把用户确认的笔记提交为产品终态。 */
    commitConfirmedNote(input: Omit<CommitConfirmedNoteRuntimeRequest, "schemaVersion">) {
      return call(
        options,
        "/internal/runtime/v1/commit-confirmed-note",
        commitConfirmedNoteRuntimeRequestSchema.parse({
          schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
          ...input,
        }),
        commitConfirmedNoteRuntimeResponseSchema,
      );
    },
    /** 转换可配置规划节点：ConfigurablePlanning工作流推进单个规划节点的状态。 */
    transitionConfigurablePlanningNode(
      input: Omit<TransitionConfigurablePlanningNodeRequest, "schemaVersion">,
    ) {
      return call(
        options,
        "/internal/runtime/v1/transition-configurable-planning-node",
        transitionConfigurablePlanningNodeRequestSchema.parse({
          schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
          ...input,
        }),
        z
          .object({
            workflowNodeRunId: z.string().regex(/^wnr_[A-Za-z0-9]+$/),
            revision: z.number().int().positive(),
          })
          .strict(),
      );
    },
    /** 提交运行结果未知：副作用网络未知时的安全收敛，不重试付费路径。 */
    commitRunOutcomeUnknown(input: {
      commandId: string;
      productRunId: string;
      errorCode: string;
      summary: string;
    }) {
      return call(
        options,
        "/internal/runtime/v1/commit-run-outcome-unknown",
        commitRunOutcomeUnknownRuntimeRequestSchema.parse({
          schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
          ...input,
        }),
        z
          .object({
            schemaVersion: z.literal(INTERNAL_RUNTIME_SCHEMA_VERSION),
            status: z.literal("committed"),
          })
          .strict(),
      );
    },
    /** 准备项目候选：ProjectIntake工作流为项目接入生成待审核候选（90秒Provider超时）。 */
    prepareProjectCandidate(input: {
      commandId: string;
      projectCandidateId: string;
      expectedRevision: number;
    }) {
      return call(
        options,
        "/internal/runtime/v1/prepare-project-candidate",
        prepareProjectCandidateRequestSchema.parse({
          schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
          ...input,
        }),
        // 私有响应仍使用公开Candidate投影，避免出现第二套候选合同。
        z.object({ candidate: projectCandidateDtoSchema }).strict(),
        // Project理解节点本身有90秒Provider硬超时；HTTP边界必须留出提交响应余量。
        120_000,
      );
    },
    /** 准备项目推进候选：ProjectAdvancement工作流为项目推进生成待审核候选（90秒Provider超时）。 */
    prepareProjectAdvancementCandidate(input: {
      commandId: string;
      projectCandidateId: string;
      expectedRevision: number;
    }) {
      return call(
        options,
        "/internal/runtime/v1/prepare-project-advancement-candidate",
        prepareProjectAdvancementCandidateRequestSchema.parse({
          schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
          ...input,
        }),
        z.object({ candidate: projectCandidateDtoSchema }).strict(),
        120_000,
      );
    },
    /**
     * 开始准备规划上下文：Workflow 阶段 A 的第一个耐久节点调用此方法，
     * POST 到后端 /internal/runtime/v1/begin-planning-context。
     *
     * 这是 createRuntimeApiClient 返回对象上的一个方法（不是独立函数），
     * 每个方法对应一个后端私有 Application Command 端点。
     *
     * 参数 input：
     * - 类型 Omit<PreparePlanningContextRequest, "schemaVersion"> 表示调用方
     *   不需要（也不应该）传 schemaVersion，由本方法用 INTERNAL_RUNTIME_SCHEMA_VERSION
     *   统一填充，保证合同版本一致。调用方只需传 commandId、productRunId、
     *   attemptId、planRevision。
     *
     * 请求体 { schemaVersion, ...input }：
     * - ...input 是展开运算符，把调用方传入的字段平铺出来，
     *   再和 schemaVersion 合并成完整请求体。
     *
     * call(...) 是同文件 L112 定义的通用 HTTP 函数，负责：
     * POST + 凭据头 + 超时 + Zod 响应校验 + 错误分类（网络未知/业务拒绝/合同损坏）。
     *
     * 响应 beginPlanningContextResponseSchema 按 status 分三支：
     * - none：本轮不需要上下文
     * - dispatch_required：需要先查 Memory（query 字段给出查询派发信息）
     * - ready / optional_failed：上下文已就绪（contextPackageRef 指向不可变上下文包）
     * 对应 planning-execution-workflow.ts L106 的分支判断。
     */
    beginPlanningContext(input: Omit<PreparePlanningContextRequest, "schemaVersion">) {
      return call(
        options,
        "/internal/runtime/v1/begin-planning-context",
        { schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION, ...input },
        beginPlanningContextResponseSchema,
      );
    },
    /** 持久化规划上下文结果：把Memory查询结果存为不可变上下文包（阶段A，Plan v2+复用）。 */
    persistPlanningContextResult(
      input: Omit<PersistPlanningContextResultRequest, "schemaVersion">,
    ) {
      return call(
        options,
        "/internal/runtime/v1/persist-planning-context-result",
        persistPlanningContextResultRequestSchema.parse({
          schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
          ...input,
        }),
        preparePlanningContextResponseSchema,
      );
    },
    /** 编译规划输入：组装发给Planner模型的完整输入（阶段B，每个planRevision调一次）。 */
    compilePlanningInput(input: Omit<CompilePlanningInputRequest, "schemaVersion">) {
      return call(
        options,
        "/internal/runtime/v1/compile-planning-input",
        { schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION, ...input },
        planningInputDtoSchema,
      );
    },
    /** 发布计划评审：把Plan候选提交为under_review事实并创建审批请求（阶段B）。 */
    publishPlanReview(input: Omit<PublishPlanReviewRequest, "schemaVersion">) {
      return call(
        options,
        "/internal/runtime/v1/publish-plan-review",
        { schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION, ...input },
        publishPlanReviewResponseSchema,
      );
    },
    /** 加载已提交决定：读取用户approve/reject/request_revision决定（阶段B，Hook恢复后调用）。 */
    loadCommittedDecision(input: Omit<LoadCommittedDecisionRequest, "schemaVersion">) {
      return call(
        options,
        "/internal/runtime/v1/load-committed-decision",
        { schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION, ...input },
        loadCommittedDecisionResponseSchema,
      );
    },
    /** 编译执行合同：从已批准Plan编译不可变执行步骤和依赖顺序（阶段C入口）。 */
    compileExecutionContract(input: Omit<CompileExecutionContractRequest, "schemaVersion">) {
      return call(
        options,
        "/internal/runtime/v1/compile-execution-contract",
        { schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION, ...input },
        compileExecutionContractResponseSchema,
      );
    },
    /** 开始运行尝试：为执行单个plan step创建attempt记录并冻结输入清单（阶段C，逐步执行）。 */
    beginRunAttempt(input: {
      commandId: string;
      productRunId: string;
      kind: "execution";
      executionContractId: string;
      stepId: string;
      dependencyRefs: readonly {
        stepId: string;
        executionAttemptId: string;
        sha256: string;
      }[];
      promptTemplateVersion: string;
      modelConfigVersion: string;
    }) {
      return call(
        options,
        "/internal/runtime/v1/begin-run-attempt",
        beginRunAttemptRequestSchema.parse({
          schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
          ...input,
        }),
        beginRunAttemptResponseSchema,
      );
    },
    /** Executor开工前回查Product Store权威Contract、Context和依赖血缘。 */
    authorizeExecutorOperation(input: Omit<AuthorizeExecutorOperationRequest, "schemaVersion">) {
      return call(
        options,
        "/internal/runtime/v1/authorize-executor-operation",
        authorizeExecutorOperationRequestSchema.parse({
          schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
          ...input,
        }),
        authorizeExecutorOperationResponseSchema,
      );
    },
    /** 完成运行尝试：标记单个plan step的attempt成功或失败（阶段C，每个step执行完调）。 */
    completeRunAttempt(input: {
      commandId: string;
      attemptId: string;
      outcome: "success" | "failure";
      errorCode?: string;
    }) {
      return call(
        options,
        "/internal/runtime/v1/complete-run-attempt",
        completeRunAttemptRequestSchema.parse({
          schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
          ...input,
        }),
        runRevisionResponseSchema,
      );
    },
    /** 持久化执行候选：把Executor输出保存为待验证候选（阶段C，全部step执行完后调）。 */
    persistExecutionCandidate(input: Omit<PersistExecutionCandidateRequest, "schemaVersion">) {
      return call(
        options,
        "/internal/runtime/v1/persist-execution-candidate",
        { schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION, ...input },
        persistExecutionCandidateResponseSchema,
      );
    },
    /** 读取治理检查所需的冻结候选、节点Prompt与证据键；正文只在本次Step内消费。 */
    prepareGovernanceReviewInput(
      input: Omit<PrepareGovernanceReviewInputRequest, "schemaVersion">,
    ) {
      return call(
        options,
        "/internal/runtime/v1/prepare-governance-review-input",
        prepareGovernanceReviewInputRequestSchema.parse({
          schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
          ...input,
        }),
        prepareGovernanceReviewInputResponseSchema,
      );
    },
    /** 持久化验证结果：保存服务端对执行候选的验证结论（阶段C，persist后调）。 */
    persistValidationResult(input: Omit<PersistValidationResultRequest, "schemaVersion">) {
      return call(
        options,
        "/internal/runtime/v1/persist-validation-result",
        { schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION, ...input },
        persistValidationResultResponseSchema,
      );
    },
    /** 提交执行结果：把验证通过的候选提交为产品终态（阶段C终点，product_committed）。 */
    commitExecutionResult(input: Omit<CommitExecutionResultRequest, "schemaVersion">) {
      return call(
        options,
        "/internal/runtime/v1/commit-execution-result",
        { schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION, ...input },
        commitExecutionResultResponseSchema,
      );
    },
    /** 提交拒绝运行：用户reject后把Run标记为cancelled（阶段B，reject分支）。 */
    commitRejectedRun(input: { commandId: string; productRunId: string; decisionId: string }) {
      return call(
        options,
        "/internal/runtime/v1/commit-rejected-run",
        commitRejectedRunRequestSchema.parse({
          schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
          ...input,
        }),
        runRevisionResponseSchema,
      );
    },
    /** 提交运行失败：失败收敛，把Run标记为failed（所有阶段异常分支的统一出口，幂等）。 */
    commitRunFailure(input: {
      commandId: string;
      productRunId: string;
      errorCode: string;
      summary: string;
    }) {
      return call(
        options,
        "/internal/runtime/v1/commit-run-failure",
        commitRunFailureRequestSchema.parse({
          schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
          ...input,
        }),
        runRevisionResponseSchema,
      );
    },
    /** 过期审批：审批超时后尝试把Run标记为failed（阶段B，与decisionHook竞态）。 */
    expireApproval(input: {
      commandId: string;
      productRunId: string;
      approvalRequestId: string;
      expectedExpiresAt: string;
    }) {
      return call(
        options,
        "/internal/runtime/v1/expire-approval",
        expireApprovalRequestSchema.parse({
          schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
          ...input,
        }),
        expireApprovalResponseSchema,
      );
    },
    /** 加载记忆导入：MemoryImport工作流读取导入意图和冻结请求清单。 */
    loadMemoryImport(
      input: Omit<LoadMemoryImportRequest, "schemaVersion" | "workflowDefinitionVersion">,
    ) {
      return call(
        options,
        "/internal/runtime/v1/memory-import/load",
        {
          schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
          workflowDefinitionVersion: MEMORY_IMPORT_WORKFLOW_DEFINITION_VERSION,
          ...input,
        },
        loadMemoryImportResponseSchema,
      );
    },
    loadMemoryWrite(
      input: Omit<LoadMemoryWriteRequest, "schemaVersion" | "workflowDefinitionVersion">,
    ) {
      return call(
        options,
        "/internal/runtime/v1/memory-write/load",
        loadMemoryWriteRequestSchema.parse({
          schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
          workflowDefinitionVersion: MEMORY_WRITE_WORKFLOW_DEFINITION_VERSION,
          ...input,
        }),
        loadMemoryWriteResponseSchema,
      );
    },
    markMemoryWriteDispatching(input: {
      commandId: string;
      memoryWriteIntentId: string;
      memoryWriteResultId: string;
      requestSha256: string;
      expectedRevision: number;
    }) {
      return call(
        options,
        "/internal/runtime/v1/memory-write/mark-dispatching",
        markMemoryWriteDispatchingRequestSchema.parse({
          schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
          workflowDefinitionVersion: MEMORY_WRITE_WORKFLOW_DEFINITION_VERSION,
          ...input,
        }),
        memoryWriteResultResponseSchema,
      );
    },
    commitMemoryWriteAccepted(input: {
      commandId: string;
      memoryWriteIntentId: string;
      memoryWriteResultId: string;
      requestSha256: string;
      expectedRevision: number;
      accepted: {
        externalObjectId: string;
        externalObjectVersion?: string;
        externalStatus?: string;
        responseSha256: string;
      };
      reconciled?: boolean;
    }) {
      return call(
        options,
        "/internal/runtime/v1/memory-write/commit-accepted",
        commitMemoryWriteAcceptedRequestSchema.parse({
          schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
          workflowDefinitionVersion: MEMORY_WRITE_WORKFLOW_DEFINITION_VERSION,
          ...input,
        }),
        memoryWriteResultResponseSchema,
      );
    },
    commitMemoryWriteMaterialized(input: {
      commandId: string;
      memoryWriteIntentId: string;
      memoryWriteResultId: string;
      requestSha256: string;
      expectedRevision: number;
      accepted: {
        externalObjectId: string;
        externalObjectVersion?: string;
        externalStatus?: string;
        responseSha256: string;
      };
      verificationKind: string;
      verificationSha256: string;
      reconciled?: boolean;
    }) {
      return call(
        options,
        "/internal/runtime/v1/memory-write/commit-materialized",
        commitMemoryWriteMaterializedRequestSchema.parse({
          schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
          workflowDefinitionVersion: MEMORY_WRITE_WORKFLOW_DEFINITION_VERSION,
          ...input,
        }),
        memoryWriteResultResponseSchema,
      );
    },
    commitMemoryWriteFailed(input: {
      commandId: string;
      memoryWriteIntentId: string;
      memoryWriteResultId: string;
      requestSha256: string;
      expectedRevision: number;
      errorCode: string;
      summary: string;
      reconciled?: boolean;
    }) {
      return call(
        options,
        "/internal/runtime/v1/memory-write/commit-failed",
        commitMemoryWriteFailedRequestSchema.parse({
          schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
          workflowDefinitionVersion: MEMORY_WRITE_WORKFLOW_DEFINITION_VERSION,
          ...input,
        }),
        memoryWriteResultResponseSchema,
      );
    },
    commitMemoryWriteOutcomeUnknown(input: {
      commandId: string;
      memoryWriteIntentId: string;
      memoryWriteResultId: string;
      requestSha256: string;
      expectedRevision: number;
      errorCode: string;
      reconciled?: boolean;
    }) {
      return call(
        options,
        "/internal/runtime/v1/memory-write/commit-outcome-unknown",
        commitMemoryWriteOutcomeUnknownRequestSchema.parse({
          schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
          workflowDefinitionVersion: MEMORY_WRITE_WORKFLOW_DEFINITION_VERSION,
          ...input,
        }),
        memoryWriteResultResponseSchema,
      );
    },
    /** 标记记忆导入派发中：记录外部Memory请求已发出（结果未知，等待对账）。 */
    markMemoryImportDispatching(input: {
      commandId: string;
      memoryImportIntentId: string;
      memoryImportResultId: string;
      requestSha256: string;
      expectedRevision: number;
    }) {
      return call(
        options,
        "/internal/runtime/v1/memory-import/mark-dispatching",
        markMemoryImportDispatchingRequestSchema.parse({
          schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
          workflowDefinitionVersion: MEMORY_IMPORT_WORKFLOW_DEFINITION_VERSION,
          ...input,
        }),
        memoryImportResultResponseSchema,
      );
    },
    /** 提交记忆导入已接受：外部Memory接受了导入请求（尚未物化，待查询对账）。 */
    commitMemoryImportAccepted(input: {
      commandId: string;
      memoryImportIntentId: string;
      memoryImportResultId: string;
      requestSha256: string;
      expectedRevision: number;
      accepted: {
        externalObjectId: string;
        externalObjectVersion?: string;
        externalStatus?: string;
        responseSha256: string;
      };
      reconciled?: boolean;
    }) {
      return call(
        options,
        "/internal/runtime/v1/memory-import/commit-accepted",
        commitMemoryImportAcceptedRequestSchema.parse({
          schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
          workflowDefinitionVersion: MEMORY_IMPORT_WORKFLOW_DEFINITION_VERSION,
          ...input,
        }),
        memoryImportResultResponseSchema,
      );
    },
    /** 提交记忆导入已物化：导入对象已在外部Memory可查（验证通过，导入成功终态）。 */
    commitMemoryImportMaterialized(input: {
      commandId: string;
      memoryImportIntentId: string;
      memoryImportResultId: string;
      requestSha256: string;
      expectedRevision: number;
      accepted: {
        externalObjectId: string;
        externalObjectVersion?: string;
        externalStatus?: string;
        responseSha256: string;
      };
      verificationKind: "read_by_id_and_search" | "l0_and_session_l1";
      verificationSha256: string;
      reconciled?: boolean;
    }) {
      return call(
        options,
        "/internal/runtime/v1/memory-import/commit-materialized",
        commitMemoryImportMaterializedRequestSchema.parse({
          schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
          workflowDefinitionVersion: MEMORY_IMPORT_WORKFLOW_DEFINITION_VERSION,
          ...input,
        }),
        memoryImportResultResponseSchema,
      );
    },
    /** 提交记忆导入失败：外部Memory拒绝或出错（确定失败终态）。 */
    commitMemoryImportFailed(input: {
      commandId: string;
      memoryImportIntentId: string;
      memoryImportResultId: string;
      requestSha256: string;
      expectedRevision: number;
      errorCode: string;
      summary: string;
      reconciled?: boolean;
    }) {
      return call(
        options,
        "/internal/runtime/v1/memory-import/commit-failed",
        commitMemoryImportFailedRequestSchema.parse({
          schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
          workflowDefinitionVersion: MEMORY_IMPORT_WORKFLOW_DEFINITION_VERSION,
          ...input,
        }),
        memoryImportResultResponseSchema,
      );
    },
    /** 提交记忆导入结果未知：网络未知的安全收敛，留待人工对账。 */
    commitMemoryImportOutcomeUnknown(input: {
      commandId: string;
      memoryImportIntentId: string;
      memoryImportResultId: string;
      requestSha256: string;
      expectedRevision: number;
      errorCode: string;
      reconciled?: boolean;
    }) {
      return call(
        options,
        "/internal/runtime/v1/memory-import/commit-outcome-unknown",
        commitMemoryImportOutcomeUnknownRequestSchema.parse({
          schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
          workflowDefinitionVersion: MEMORY_IMPORT_WORKFLOW_DEFINITION_VERSION,
          ...input,
        }),
        memoryImportResultResponseSchema,
      );
    },
  };
}

export type RuntimeApiClient = ReturnType<typeof createRuntimeApiClient>;
