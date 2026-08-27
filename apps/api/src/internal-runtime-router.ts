import { Hono, type Context } from "hono";
import { ZodError } from "zod";
import {
  compileExecutionContractRequestSchema,
  authorizeExecutorOperationRequestSchema,
  authorizeExecutorOperationResponseSchema,
  beginRunAttemptRequestSchema,
  commitConfirmedNoteRuntimeRequestSchema,
  commitConfirmedNoteRuntimeResponseSchema,
  loadCommittedDecisionRequestSchema,
  persistExecutionCandidateRequestSchema,
  persistValidationResultRequestSchema,
  commitExecutionResultRequestSchema,
  commitRejectedRunRequestSchema,
  commitRunFailureRequestSchema,
  commitRunOutcomeUnknownRuntimeRequestSchema,
  compilePlanningInputRequestSchema,
  completeRunAttemptRequestSchema,
  expireApprovalRequestSchema,
  publishPlanReviewRequestSchema,
  preparePlanningContextRequestSchema,
  persistPlanningContextResultRequestSchema,
  loadMemoryImportRequestSchema,
  markMemoryImportDispatchingRequestSchema,
  commitMemoryImportAcceptedRequestSchema,
  commitMemoryImportMaterializedRequestSchema,
  commitMemoryImportFailedRequestSchema,
  commitMemoryImportOutcomeUnknownRequestSchema,
  loadMemoryWriteRequestSchema,
  beginWorkflowMemoryWriteRequestSchema,
  beginWorkflowMemoryWriteResponseSchema,
  markMemoryWriteDispatchingRequestSchema,
  commitMemoryWriteAcceptedRequestSchema,
  commitMemoryWriteMaterializedRequestSchema,
  commitMemoryWriteFailedRequestSchema,
  commitMemoryWriteOutcomeUnknownRequestSchema,
  loadNoteDecisionRuntimeRequestSchema,
  loadNoteDecisionRuntimeResponseSchema,
  prepareNoteCaptureInputRuntimeRequestSchema,
  prepareNoteCaptureInputRuntimeResponseSchema,
  loadWorkflowRunSpecRequestSchema,
  loadWorkflowRunSpecResponseSchema,
  publishNoteCandidateRuntimeRequestSchema,
  publishNoteCandidateRuntimeResponseSchema,
  transitionConfigurablePlanningNodeRequestSchema,
  preparePlanningMemoryContextRequestSchema,
  preparePlanningMemoryContextResponseSchema,
  preparePlanningRulesContextRequestSchema,
  preparePlanningRulesContextResponseSchema,
  prepareGovernanceReviewInputRequestSchema,
  prepareGovernanceReviewInputResponseSchema,
  beginWorkflowMemoryQueryRequestSchema,
  beginWorkflowMemoryQueryResponseSchema,
  persistWorkflowMemoryQueryResultRequestSchema,
  persistWorkflowMemoryQueryResultResponseSchema,
  freezeWorkflowMemoryContextRequestSchema,
  freezeWorkflowMemoryContextResponseSchema,
  prepareMemoryWriteAgentInputRequestSchema,
  prepareMemoryWriteAgentInputResponseSchema,
  persistMemoryWriteAgentCandidateRequestSchema,
  persistMemoryWriteAgentCandidateResponseSchema,
  beginMemoryAgentOperationRequestSchema,
  beginMemoryAgentOperationResponseSchema,
  completeMemoryAgentOperationRequestSchema,
  markMemoryAgentOperationOutcomeUnknownRequestSchema,
  memoryAgentOperationResponseSchema,
  INTERNAL_RUNTIME_SCHEMA_VERSION,
  DIRECT_AGENT_INTERNAL_RUNTIME_SCHEMA_VERSION,
  DIRECT_AGENT_RUNTIME_PATHS,
  beginDirectAgentAttemptRuntimeRequestSchema,
  beginDirectAgentAttemptRuntimeResponseSchema,
  authorizeDirectAgentOperationRuntimeRequestSchema,
  authorizeDirectAgentOperationRuntimeResponseSchema,
  publishPromptReviewRuntimeRequestSchema,
  publishPromptReviewRuntimeResponseSchema,
  loadPromptReviewDecisionRuntimeRequestSchema,
  loadPromptReviewDecisionRuntimeResponseSchema,
  consumePromptReviewDecisionRuntimeRequestSchema,
  consumePromptReviewDecisionRuntimeResponseSchema,
  commitPromptReviewDispatchOutcomeRuntimeRequestSchema,
  commitPromptReviewDispatchOutcomeRuntimeResponseSchema,
  persistDirectAgentCandidateRuntimeRequestSchema,
  persistDirectAgentCandidateRuntimeResponseSchema,
  commitDirectAgentResultRuntimeRequestSchema,
  commitDirectAgentResultRuntimeResponseSchema,
  publishToolExecutionIntentRuntimeRequestSchema,
  publishToolExecutionIntentRuntimeResponseSchema,
  claimToolExecutionDecisionRuntimeRequestSchema,
  claimToolExecutionDecisionRuntimeResponseSchema,
  commitToolExecutionResultRuntimeRequestSchema,
  commitToolExecutionResultRuntimeResponseSchema,
  type ProblemDetail,
  type RequestId,
} from "@chat/contracts";
import {
  ApplicationError,
  CommandIdReusedError,
  StoreCorruptedError,
  compileExecutionContract,
  authorizeExecutorOperation,
  compilePlanningInput,
  commitExecutionResult,
  commitConfirmedNote,
  commitRejectedRun,
  commitRunFailure,
  commitRunOutcomeUnknown,
  completeRunAttempt,
  expireApproval,
  loadCommittedDecision,
  persistExecutionCandidate,
  prepareGovernanceReviewInput,
  persistValidationResult,
  publishPlanForReview,
  beginRunAttempt,
  beginPlanningContext,
  persistPlanningContextResult,
  loadMemoryImportForRuntime,
  markMemoryImportDispatching,
  commitMemoryImportAccepted,
  commitMemoryImportMaterialized,
  commitMemoryImportFailed,
  commitMemoryImportOutcomeUnknown,
  loadMemoryWriteForRuntime,
  beginWorkflowMemoryWrite,
  markMemoryWriteDispatching,
  commitMemoryWriteAccepted,
  commitMemoryWriteMaterialized,
  commitMemoryWriteFailed,
  commitMemoryWriteOutcomeUnknown,
  getWorkflowRunSpecForRuntime,
  loadNoteDecisionForRuntime,
  prepareNoteCaptureInputForRuntime,
  publishNoteCandidate,
  transitionConfigurablePlanningNode,
  preparePlanningMemoryContext,
  preparePlanningRulesContext,
  beginWorkflowMemoryQuery,
  persistWorkflowMemoryQueryResult,
  freezeWorkflowMemoryContext,
  prepareMemoryWriteAgentInput,
  persistMemoryWriteAgentCandidate,
  beginMemoryAgentOperation,
  completeMemoryAgentOperation,
  markMemoryAgentOperationOutcomeUnknown,
  beginDirectAgentAttempt,
  authorizeDirectAgentOperation,
  publishPromptReviewRequest,
  loadPromptReviewDecisionForRuntime,
  consumePromptReviewDecision,
  commitPromptReviewDispatchOutcome,
  persistDirectAgentCandidate,
  commitDirectAgentResult,
  publishToolExecutionIntent,
  claimToolExecutionDecision,
  commitToolExecutionResult,
  type ApplicationDeps,
} from "@chat/application";

/**
 * 后端私有Runtime Router（任务书§12.4）。
 *
 * 不变量：
 * - 只接受产品对象引用和稳定命令身份；不接受浏览器原始决定。
 * - 仅服务端持有的Runtime凭据；与公开API分Router、分DTO、分授权测试。
 * - 所有写命令仍经过strict Zod、Application Coordinator、CAS、Trace与幂等；
 *   本Router不是直接写Store的后门。
 */

type Variables = { requestId: RequestId };

function internalProblem(
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
  return c.json(body, options.status);
}

function mapInternalError(
  c: { json: (body: unknown, status: number) => Response; get: (key: "requestId") => RequestId },
  error: unknown,
): Response {
  if (error instanceof ApplicationError) {
    return internalProblem(c, {
      status: error.httpStatus,
      code: error.code,
      title: error.message,
      retryable: error.retryable,
      recoveryAction: error.recoveryAction,
    });
  }
  if (error instanceof CommandIdReusedError) {
    return internalProblem(c, {
      status: 409,
      code: "command_id_reused",
      title: "commandId已被不同请求使用",
      retryable: false,
      recoveryAction: "none",
    });
  }
  if (error instanceof StoreCorruptedError) {
    return internalProblem(c, {
      status: 500,
      code: "store_corrupted",
      title: "Product Store不可用",
      retryable: false,
      recoveryAction: "contact_support",
    });
  }
  if (error instanceof ZodError) {
    return internalProblem(c, {
      status: 400,
      code: "validation_failed",
      title: "请求不符合合同",
      retryable: false,
      recoveryAction: "none",
    });
  }
  return internalProblem(c, {
    status: 500,
    code: "internal_error",
    title: "内部错误",
    retryable: false,
    recoveryAction: "none",
  });
}

type Ctx = Context<{ Variables: Variables }>;

async function parseInternalBody(c: Ctx): Promise<unknown> {
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

function handle<S extends 200 | 201, T>(status: S, fn: (c: Ctx) => Promise<T>) {
  return async (c: Ctx): Promise<Response> => {
    try {
      return c.json(await fn(c), status);
    } catch (error) {
      return mapInternalError(c, error);
    }
  };
}

export interface InternalRuntimeRouterOptions {
  readonly deps: ApplicationDeps;
  readonly credential: string;
}

export function createInternalRuntimeRouter(
  options: InternalRuntimeRouterOptions,
): Hono<{ Variables: Variables }> {
  const router = new Hono<{ Variables: Variables }>();

  router.use("*", async (c, next) => {
    if (c.req.header("x-chat-runtime-key") !== options.credential) {
      return internalProblem(c, {
        status: 403,
        code: "forbidden",
        title: "Runtime凭据无效",
        retryable: false,
        recoveryAction: "none",
      });
    }
    await next();
  });

  /**
   * 调试导航：以下路由是Workflow Step回到Application的唯一数据通道。
   *
   * 主链顺序为：准备Context → 编译Planning Input → 发布Plan/Approval → 读取已提交Decision
   * → 编译Execution Contract → 创建/完成执行Attempt → 持久化候选 → Validation → Product Commit。
   * Workflow进程不能打开Product Store；即使是私有路由，每个写入仍需strict Schema、稳定
   * commandId、CAS和Application事务。这里传递产品引用与结构化候选，不传SDK Workflow对象。
   */
  router.post(
    "/load-workflow-run-spec",
    handle(200, async (c) => {
      const request = loadWorkflowRunSpecRequestSchema.parse(await parseInternalBody(c));
      const { runSpec } = await getWorkflowRunSpecForRuntime(options.deps, {
        productRunId: request.productRunId,
        workflowRunSpecId: request.workflowRunSpecId,
      });
      return loadWorkflowRunSpecResponseSchema.parse({
        schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
        productRunId: request.productRunId,
        workflowRunSpecId: request.workflowRunSpecId,
        workflowDefinitionRevisionId: runSpec.definitionRef.workflowDefinitionRevisionId,
        runSpec,
      });
    }),
  );

  router.post(
    DIRECT_AGENT_RUNTIME_PATHS.beginAttempt,
    handle(201, async (c) => {
      const request = beginDirectAgentAttemptRuntimeRequestSchema.parse(await parseInternalBody(c));
      const result = await beginDirectAgentAttempt(options.deps, request);
      return beginDirectAgentAttemptRuntimeResponseSchema.parse({
        schemaVersion: DIRECT_AGENT_INTERNAL_RUNTIME_SCHEMA_VERSION,
        ...result,
      });
    }),
  );

  router.post(
    DIRECT_AGENT_RUNTIME_PATHS.authorizeOperation,
    handle(200, async (c) => {
      const request = authorizeDirectAgentOperationRuntimeRequestSchema.parse(
        await parseInternalBody(c),
      );
      return authorizeDirectAgentOperationRuntimeResponseSchema.parse({
        schemaVersion: DIRECT_AGENT_INTERNAL_RUNTIME_SCHEMA_VERSION,
        ...(await authorizeDirectAgentOperation(options.deps, request)),
      });
    }),
  );

  router.post(
    DIRECT_AGENT_RUNTIME_PATHS.publishPromptReview,
    handle(201, async (c) => {
      const request = publishPromptReviewRuntimeRequestSchema.parse(await parseInternalBody(c));
      const result = await publishPromptReviewRequest(options.deps, request);
      return publishPromptReviewRuntimeResponseSchema.parse({
        schemaVersion: DIRECT_AGENT_INTERNAL_RUNTIME_SCHEMA_VERSION,
        promptReviewRequestId: result.promptReview.promptReviewRequestId,
        productRunId: result.promptReview.productRunId,
        requestRevision: result.promptReview.requestRevision,
        requestIndex: result.promptReview.requestIndex,
        payloadSha256: result.promptReview.payloadSha256,
        reviewSha256: result.promptReview.reviewSha256,
        status: result.promptReview.status,
        revision: result.promptReview.revision,
        runRevision: result.runRevision,
      });
    }),
  );

  router.post(
    DIRECT_AGENT_RUNTIME_PATHS.consumePromptReviewDecision,
    handle(200, async (c) => {
      const request = consumePromptReviewDecisionRuntimeRequestSchema.parse(
        await parseInternalBody(c),
      );
      return consumePromptReviewDecisionRuntimeResponseSchema.parse(
        await consumePromptReviewDecision(options.deps, request),
      );
    }),
  );

  router.post(
    DIRECT_AGENT_RUNTIME_PATHS.loadPromptReviewDecision,
    handle(200, async (c) => {
      const request = loadPromptReviewDecisionRuntimeRequestSchema.parse(
        await parseInternalBody(c),
      );
      return loadPromptReviewDecisionRuntimeResponseSchema.parse({
        schemaVersion: DIRECT_AGENT_INTERNAL_RUNTIME_SCHEMA_VERSION,
        ...(await loadPromptReviewDecisionForRuntime(options.deps, request)),
      });
    }),
  );

  router.post(
    DIRECT_AGENT_RUNTIME_PATHS.commitPromptReviewDispatchOutcome,
    handle(200, async (c) => {
      const request = commitPromptReviewDispatchOutcomeRuntimeRequestSchema.parse(
        await parseInternalBody(c),
      );
      const result = await commitPromptReviewDispatchOutcome(options.deps, request);
      return commitPromptReviewDispatchOutcomeRuntimeResponseSchema.parse({
        schemaVersion: DIRECT_AGENT_INTERNAL_RUNTIME_SCHEMA_VERSION,
        promptReviewRequestId: result.promptReview.promptReviewRequestId,
        productRunId: result.promptReview.productRunId,
        status: result.promptReview.status,
        revision: result.promptReview.revision,
      });
    }),
  );

  router.post(
    DIRECT_AGENT_RUNTIME_PATHS.publishToolExecutionIntent,
    handle(201, async (c) => {
      const request = publishToolExecutionIntentRuntimeRequestSchema.parse(
        await parseInternalBody(c),
      );
      const intent = await publishToolExecutionIntent(options.deps, request);
      return publishToolExecutionIntentRuntimeResponseSchema.parse({
        schemaVersion: DIRECT_AGENT_INTERNAL_RUNTIME_SCHEMA_VERSION,
        toolExecutionIntentId: intent.toolExecutionIntentId,
        revision: intent.revision,
        status: intent.status,
      });
    }),
  );

  router.post(
    DIRECT_AGENT_RUNTIME_PATHS.claimToolExecutionDecision,
    handle(200, async (c) => {
      const request = claimToolExecutionDecisionRuntimeRequestSchema.parse(
        await parseInternalBody(c),
      );
      return claimToolExecutionDecisionRuntimeResponseSchema.parse(
        await claimToolExecutionDecision(options.deps, request),
      );
    }),
  );

  router.post(
    DIRECT_AGENT_RUNTIME_PATHS.commitToolExecutionResult,
    handle(200, async (c) => {
      const request = commitToolExecutionResultRuntimeRequestSchema.parse(
        await parseInternalBody(c),
      );
      return commitToolExecutionResultRuntimeResponseSchema.parse({
        schemaVersion: DIRECT_AGENT_INTERNAL_RUNTIME_SCHEMA_VERSION,
        ...(await commitToolExecutionResult(options.deps, request)),
      });
    }),
  );

  router.post(
    DIRECT_AGENT_RUNTIME_PATHS.persistCandidate,
    handle(201, async (c) => {
      const request = persistDirectAgentCandidateRuntimeRequestSchema.parse(
        await parseInternalBody(c),
      );
      const result = await persistDirectAgentCandidate(options.deps, request);
      return persistDirectAgentCandidateRuntimeResponseSchema.parse({
        schemaVersion: DIRECT_AGENT_INTERNAL_RUNTIME_SCHEMA_VERSION,
        productRunId: request.productRunId,
        ...result,
      });
    }),
  );

  router.post(
    DIRECT_AGENT_RUNTIME_PATHS.commitResult,
    handle(200, async (c) => {
      const request = commitDirectAgentResultRuntimeRequestSchema.parse(await parseInternalBody(c));
      const result = await commitDirectAgentResult(options.deps, request);
      return commitDirectAgentResultRuntimeResponseSchema.parse({
        schemaVersion: DIRECT_AGENT_INTERNAL_RUNTIME_SCHEMA_VERSION,
        productRunId: request.productRunId,
        directAgentCandidateId: request.directAgentCandidateId,
        messageId: result.message.messageId,
      });
    }),
  );

  router.post(
    "/begin-workflow-memory-query",
    handle(200, async (c) => {
      const request = beginWorkflowMemoryQueryRequestSchema.parse(await parseInternalBody(c));
      return beginWorkflowMemoryQueryResponseSchema.parse(
        await beginWorkflowMemoryQuery(options.deps, request),
      );
    }),
  );

  router.post(
    "/persist-workflow-memory-query-result",
    handle(200, async (c) => {
      const request = persistWorkflowMemoryQueryResultRequestSchema.parse(
        await parseInternalBody(c),
      );
      return persistWorkflowMemoryQueryResultResponseSchema.parse(
        await persistWorkflowMemoryQueryResult(options.deps, request),
      );
    }),
  );

  router.post(
    "/freeze-workflow-memory-context",
    handle(200, async (c) => {
      const request = freezeWorkflowMemoryContextRequestSchema.parse(await parseInternalBody(c));
      return freezeWorkflowMemoryContextResponseSchema.parse(
        await freezeWorkflowMemoryContext(options.deps, request),
      );
    }),
  );

  router.post(
    "/prepare-memory-write-agent-input",
    handle(200, async (c) => {
      const request = prepareMemoryWriteAgentInputRequestSchema.parse(await parseInternalBody(c));
      return prepareMemoryWriteAgentInputResponseSchema.parse(
        await prepareMemoryWriteAgentInput(options.deps, request),
      );
    }),
  );

  router.post(
    "/persist-memory-write-agent-candidate",
    handle(200, async (c) => {
      const request = persistMemoryWriteAgentCandidateRequestSchema.parse(
        await parseInternalBody(c),
      );
      return persistMemoryWriteAgentCandidateResponseSchema.parse(
        await persistMemoryWriteAgentCandidate(options.deps, request),
      );
    }),
  );

  router.post(
    "/begin-memory-agent-operation",
    handle(200, async (c) => {
      const request = beginMemoryAgentOperationRequestSchema.parse(await parseInternalBody(c));
      return beginMemoryAgentOperationResponseSchema.parse(
        await beginMemoryAgentOperation(options.deps, request),
      );
    }),
  );

  router.post(
    "/complete-memory-agent-operation",
    handle(200, async (c) => {
      const request = completeMemoryAgentOperationRequestSchema.parse(await parseInternalBody(c));
      return memoryAgentOperationResponseSchema.parse(
        await completeMemoryAgentOperation(options.deps, request),
      );
    }),
  );

  router.post(
    "/mark-memory-agent-operation-outcome-unknown",
    handle(200, async (c) => {
      const request = markMemoryAgentOperationOutcomeUnknownRequestSchema.parse(
        await parseInternalBody(c),
      );
      return memoryAgentOperationResponseSchema.parse(
        await markMemoryAgentOperationOutcomeUnknown(options.deps, request),
      );
    }),
  );

  router.post(
    "/prepare-planning-memory-context",
    handle(200, async (c) => {
      const request = preparePlanningMemoryContextRequestSchema.parse(await parseInternalBody(c));
      return preparePlanningMemoryContextResponseSchema.parse(
        await preparePlanningMemoryContext(options.deps, request),
      );
    }),
  );

  router.post(
    "/prepare-planning-rules-context",
    handle(200, async (c) => {
      const request = preparePlanningRulesContextRequestSchema.parse(await parseInternalBody(c));
      return preparePlanningRulesContextResponseSchema.parse(
        await preparePlanningRulesContext(options.deps, request),
      );
    }),
  );

  router.post(
    "/publish-note-candidate",
    handle(201, async (c) => {
      const request = publishNoteCandidateRuntimeRequestSchema.parse(await parseInternalBody(c));
      const result = await publishNoteCandidate(options.deps, {
        commandId: request.commandId,
        productRunId: request.productRunId,
        proposed: request.proposed,
      });
      return publishNoteCandidateRuntimeResponseSchema.parse({
        schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
        candidate: result.candidate,
        review: result.review,
      });
    }),
  );

  router.post(
    "/prepare-note-capture-input",
    handle(200, async (c) => {
      const request = prepareNoteCaptureInputRuntimeRequestSchema.parse(await parseInternalBody(c));
      const prepared = await prepareNoteCaptureInputForRuntime(options.deps, {
        productRunId: request.productRunId,
        workflowRunSpecId: request.workflowRunSpecId,
      });
      return prepareNoteCaptureInputRuntimeResponseSchema.parse({
        schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
        productRunId: request.productRunId,
        workflowRunSpecId: request.workflowRunSpecId,
        ...prepared,
      });
    }),
  );

  router.post(
    "/load-note-decision",
    handle(200, async (c) => {
      const request = loadNoteDecisionRuntimeRequestSchema.parse(await parseInternalBody(c));
      const result = await loadNoteDecisionForRuntime(options.deps, {
        productRunId: request.productRunId,
        workflowRunSpecId: request.workflowRunSpecId,
        noteCandidateId: request.noteCandidateId,
        noteDecisionId: request.noteDecisionId,
      });
      return loadNoteDecisionRuntimeResponseSchema.parse({
        schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
        candidate: result.candidate,
        decision: result.decision,
      });
    }),
  );

  router.post(
    "/commit-confirmed-note",
    handle(200, async (c) => {
      const request = commitConfirmedNoteRuntimeRequestSchema.parse(await parseInternalBody(c));
      await commitConfirmedNote(options.deps, {
        commandId: request.commandId,
        productRunId: request.productRunId,
        noteCandidateId: request.noteCandidateId,
      });
      return commitConfirmedNoteRuntimeResponseSchema.parse({
        schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
        status: "committed",
      });
    }),
  );

  router.post(
    "/transition-configurable-planning-node",
    handle(200, async (c) => {
      const request = transitionConfigurablePlanningNodeRequestSchema.parse(
        await parseInternalBody(c),
      );
      return transitionConfigurablePlanningNode(options.deps, {
        commandId: request.commandId,
        productRunId: request.productRunId,
        workflowRunSpecId: request.workflowRunSpecId,
        definitionNodeId: request.definitionNodeId,
        executionPath: request.executionPath,
        attemptNumber: request.attemptNumber,
        toStatus: request.toStatus,
        ...(request.outcomeCode !== undefined ? { outcomeCode: request.outcomeCode } : {}),
        ...(request.publicSummary !== undefined ? { publicSummary: request.publicSummary } : {}),
      });
    }),
  );

  router.post(
    "/commit-run-outcome-unknown",
    handle(200, async (c) => {
      const request = commitRunOutcomeUnknownRuntimeRequestSchema.parse(await parseInternalBody(c));
      await commitRunOutcomeUnknown(options.deps, {
        commandId: request.commandId,
        productRunId: request.productRunId,
        errorCode: request.errorCode,
        summary: request.summary,
      });
      return { schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION, status: "committed" as const };
    }),
  );

  router.post(
    "/begin-planning-context",
    handle(200, async (c) => {
      const request = preparePlanningContextRequestSchema.parse(await parseInternalBody(c));
      return beginPlanningContext(options.deps, request);
    }),
  );

  router.post(
    "/persist-planning-context-result",
    handle(200, async (c) => {
      const request = persistPlanningContextResultRequestSchema.parse(await parseInternalBody(c));
      return persistPlanningContextResult(options.deps, request);
    }),
  );

  router.post(
    "/compile-planning-input",
    handle(200, async (c) => {
      const request = compilePlanningInputRequestSchema.parse(await parseInternalBody(c));
      return compilePlanningInput(options.deps, request);
    }),
  );

  router.post(
    "/publish-plan-review",
    handle(201, async (c) => {
      // Plan Candidate在这里越过“模型候选 → 产品审核事实”边界；
      // publishPlanForReview会计算/校验Hash并原子提交Plan、Approval和Run状态。
      const request = publishPlanReviewRequestSchema.parse(await parseInternalBody(c));
      const result = await publishPlanForReview(options.deps, {
        productRunId: request.productRunId,
        commandId: request.commandId,
        content: request.content,
        attemptId: request.attemptId,
        expectedRunRevision: request.expectedRunRevision,
        inputManifestSha256: request.inputManifestSha256,
      });
      return {
        schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
        planId: result.plan.planId,
        planRevision: result.plan.planRevision,
        planSha256: result.plan.sha256,
        approvalRequestId: result.approval.approvalRequestId,
        approvalExpiresAt: result.approval.expiresAt,
      };
    }),
  );

  router.post(
    "/load-committed-decision",
    handle(200, async (c) => {
      const request = loadCommittedDecisionRequestSchema.parse(await parseInternalBody(c));
      return loadCommittedDecision(options.deps, request);
    }),
  );

  router.post(
    "/compile-execution-contract",
    handle(201, async (c) => {
      const request = compileExecutionContractRequestSchema.parse(await parseInternalBody(c));
      const result = await compileExecutionContract(options.deps, request);
      return { schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION, contract: result.contract };
    }),
  );

  router.post(
    "/begin-run-attempt",
    handle(201, async (c) => {
      const request = beginRunAttemptRequestSchema.parse(await parseInternalBody(c));
      const result = await beginRunAttempt(options.deps, request);
      return {
        schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
        attemptId: result.attemptId,
        inputManifestSha256: result.inputManifestSha256,
        contextItems: result.contextItems,
        ...(result.promptAssemblyRef === undefined
          ? {}
          : { promptAssemblyRef: result.promptAssemblyRef }),
      };
    }),
  );

  router.post(
    "/authorize-executor-operation",
    handle(200, async (c) => {
      const request = authorizeExecutorOperationRequestSchema.parse(await parseInternalBody(c));
      return authorizeExecutorOperationResponseSchema.parse(
        await authorizeExecutorOperation(options.deps, request),
      );
    }),
  );

  router.post(
    "/complete-run-attempt",
    handle(200, async (c) => {
      const request = completeRunAttemptRequestSchema.parse(await parseInternalBody(c));
      const result = await completeRunAttempt(options.deps, request);
      return { schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION, revision: result.revision };
    }),
  );

  router.post(
    "/persist-execution-candidate",
    handle(201, async (c) => {
      const request = persistExecutionCandidateRequestSchema.parse(await parseInternalBody(c));
      const result = await persistExecutionCandidate(options.deps, request);
      return {
        schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
        executionCandidateId: result.executionCandidateId,
        sha256: result.sha256,
      };
    }),
  );

  router.post(
    "/prepare-governance-review-input",
    handle(200, async (c) => {
      const request = prepareGovernanceReviewInputRequestSchema.parse(await parseInternalBody(c));
      const reviewInput = await prepareGovernanceReviewInput(options.deps, request);
      return prepareGovernanceReviewInputResponseSchema.parse({
        schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
        reviewInput,
      });
    }),
  );

  router.post(
    "/persist-validation-result",
    handle(201, async (c) => {
      const request = persistValidationResultRequestSchema.parse(await parseInternalBody(c));
      const result = await persistValidationResult(options.deps, request);
      return {
        schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
        validationResultId: result.validationResultId,
        outcome: result.outcome,
        failures: result.failures,
      };
    }),
  );

  router.post(
    "/commit-execution-result",
    handle(201, async (c) => {
      // 只有已经持久化且Validation通过的候选才能到达Product Commit；
      // commitExecutionResult原子生成正式Assistant Message并推进Run终态。
      const request = commitExecutionResultRequestSchema.parse(await parseInternalBody(c));
      const result = await commitExecutionResult(options.deps, request);
      return {
        schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
        finalMessageId: result.finalMessageId,
        revision: result.revision,
      };
    }),
  );

  router.post(
    "/commit-rejected-run",
    handle(200, async (c) => {
      const request = commitRejectedRunRequestSchema.parse(await parseInternalBody(c));
      const result = await commitRejectedRun(options.deps, request);
      return { schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION, revision: result.revision };
    }),
  );

  router.post(
    "/expire-approval",
    handle(200, async (c) => {
      const request = expireApprovalRequestSchema.parse(await parseInternalBody(c));
      const result = await expireApproval(options.deps, request);
      return {
        schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
        status: result.status,
        revision: result.revision,
      };
    }),
  );

  router.post(
    "/commit-run-failure",
    handle(200, async (c) => {
      const request = commitRunFailureRequestSchema.parse(await parseInternalBody(c));
      const result = await commitRunFailure(options.deps, request);
      return { schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION, revision: result.revision };
    }),
  );

  router.post(
    "/memory-write/begin-workflow-node",
    handle(200, async (c) => {
      const request = beginWorkflowMemoryWriteRequestSchema.parse(await parseInternalBody(c));
      return beginWorkflowMemoryWriteResponseSchema.parse(
        await beginWorkflowMemoryWrite(options.deps, request),
      );
    }),
  );

  router.post(
    "/memory-write/load",
    handle(200, async (c) => {
      const request = loadMemoryWriteRequestSchema.parse(await parseInternalBody(c));
      const loaded = await loadMemoryWriteForRuntime(options.deps, request);
      return { schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION, ...loaded };
    }),
  );

  router.post(
    "/memory-write/mark-dispatching",
    handle(200, async (c) => {
      const request = markMemoryWriteDispatchingRequestSchema.parse(await parseInternalBody(c));
      const result = await markMemoryWriteDispatching(options.deps, request);
      return { schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION, result };
    }),
  );

  router.post(
    "/memory-write/commit-accepted",
    handle(200, async (c) => {
      const request = commitMemoryWriteAcceptedRequestSchema.parse(await parseInternalBody(c));
      const result = await commitMemoryWriteAccepted(options.deps, {
        commandId: request.commandId,
        memoryWriteIntentId: request.memoryWriteIntentId,
        memoryWriteResultId: request.memoryWriteResultId,
        requestSha256: request.requestSha256,
        expectedRevision: request.expectedRevision,
        accepted: {
          externalObjectId: request.accepted.externalObjectId,
          responseSha256: request.accepted.responseSha256,
          ...(request.accepted.externalObjectVersion !== undefined
            ? { externalObjectVersion: request.accepted.externalObjectVersion }
            : {}),
          ...(request.accepted.externalStatus !== undefined
            ? { externalStatus: request.accepted.externalStatus }
            : {}),
        },
        ...(request.reconciled !== undefined ? { reconciled: request.reconciled } : {}),
      });
      return { schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION, result };
    }),
  );

  router.post(
    "/memory-write/commit-materialized",
    handle(200, async (c) => {
      const request = commitMemoryWriteMaterializedRequestSchema.parse(await parseInternalBody(c));
      const result = await commitMemoryWriteMaterialized(options.deps, {
        commandId: request.commandId,
        memoryWriteIntentId: request.memoryWriteIntentId,
        memoryWriteResultId: request.memoryWriteResultId,
        requestSha256: request.requestSha256,
        expectedRevision: request.expectedRevision,
        verificationKind: request.verificationKind,
        verificationSha256: request.verificationSha256,
        accepted: {
          externalObjectId: request.accepted.externalObjectId,
          responseSha256: request.accepted.responseSha256,
          ...(request.accepted.externalObjectVersion !== undefined
            ? { externalObjectVersion: request.accepted.externalObjectVersion }
            : {}),
          ...(request.accepted.externalStatus !== undefined
            ? { externalStatus: request.accepted.externalStatus }
            : {}),
        },
        ...(request.reconciled !== undefined ? { reconciled: request.reconciled } : {}),
      });
      return { schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION, result };
    }),
  );

  router.post(
    "/memory-write/commit-failed",
    handle(200, async (c) => {
      const request = commitMemoryWriteFailedRequestSchema.parse(await parseInternalBody(c));
      const result = await commitMemoryWriteFailed(options.deps, {
        commandId: request.commandId,
        memoryWriteIntentId: request.memoryWriteIntentId,
        memoryWriteResultId: request.memoryWriteResultId,
        requestSha256: request.requestSha256,
        expectedRevision: request.expectedRevision,
        errorCode: request.errorCode,
        summary: request.summary,
        ...(request.reconciled !== undefined ? { reconciled: request.reconciled } : {}),
      });
      return { schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION, result };
    }),
  );

  router.post(
    "/memory-write/commit-outcome-unknown",
    handle(200, async (c) => {
      const request = commitMemoryWriteOutcomeUnknownRequestSchema.parse(
        await parseInternalBody(c),
      );
      const result = await commitMemoryWriteOutcomeUnknown(options.deps, {
        commandId: request.commandId,
        memoryWriteIntentId: request.memoryWriteIntentId,
        memoryWriteResultId: request.memoryWriteResultId,
        requestSha256: request.requestSha256,
        expectedRevision: request.expectedRevision,
        errorCode: request.errorCode,
        ...(request.reconciled !== undefined ? { reconciled: request.reconciled } : {}),
      });
      return { schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION, result };
    }),
  );

  router.post(
    "/memory-import/load",
    handle(200, async (c) => {
      const request = loadMemoryImportRequestSchema.parse(await parseInternalBody(c));
      const loaded = await loadMemoryImportForRuntime(options.deps, request);
      return { schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION, ...loaded };
    }),
  );

  router.post(
    "/memory-import/mark-dispatching",
    handle(200, async (c) => {
      const request = markMemoryImportDispatchingRequestSchema.parse(await parseInternalBody(c));
      const result = await markMemoryImportDispatching(options.deps, {
        commandId: request.commandId,
        memoryImportIntentId: request.memoryImportIntentId,
        memoryImportResultId: request.memoryImportResultId,
        requestSha256: request.requestSha256,
        expectedRevision: request.expectedRevision,
      });
      return { schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION, result };
    }),
  );

  router.post(
    "/memory-import/commit-accepted",
    handle(200, async (c) => {
      const request = commitMemoryImportAcceptedRequestSchema.parse(await parseInternalBody(c));
      const result = await commitMemoryImportAccepted(options.deps, {
        commandId: request.commandId,
        memoryImportIntentId: request.memoryImportIntentId,
        memoryImportResultId: request.memoryImportResultId,
        requestSha256: request.requestSha256,
        expectedRevision: request.expectedRevision,
        ...(request.reconciled !== undefined ? { reconciled: request.reconciled } : {}),
        accepted: {
          externalObjectId: request.accepted.externalObjectId,
          responseSha256: request.accepted.responseSha256,
          ...(request.accepted.externalObjectVersion !== undefined
            ? { externalObjectVersion: request.accepted.externalObjectVersion }
            : {}),
          ...(request.accepted.externalStatus !== undefined
            ? { externalStatus: request.accepted.externalStatus }
            : {}),
        },
      });
      return { schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION, result };
    }),
  );

  router.post(
    "/memory-import/commit-materialized",
    handle(200, async (c) => {
      const request = commitMemoryImportMaterializedRequestSchema.parse(await parseInternalBody(c));
      const result = await commitMemoryImportMaterialized(options.deps, {
        commandId: request.commandId,
        memoryImportIntentId: request.memoryImportIntentId,
        memoryImportResultId: request.memoryImportResultId,
        requestSha256: request.requestSha256,
        expectedRevision: request.expectedRevision,
        verificationKind: request.verificationKind,
        verificationSha256: request.verificationSha256,
        ...(request.reconciled !== undefined ? { reconciled: request.reconciled } : {}),
        accepted: {
          externalObjectId: request.accepted.externalObjectId,
          responseSha256: request.accepted.responseSha256,
          ...(request.accepted.externalObjectVersion !== undefined
            ? { externalObjectVersion: request.accepted.externalObjectVersion }
            : {}),
          ...(request.accepted.externalStatus !== undefined
            ? { externalStatus: request.accepted.externalStatus }
            : {}),
        },
      });
      return { schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION, result };
    }),
  );

  router.post(
    "/memory-import/commit-failed",
    handle(200, async (c) => {
      const request = commitMemoryImportFailedRequestSchema.parse(await parseInternalBody(c));
      const result = await commitMemoryImportFailed(options.deps, {
        commandId: request.commandId,
        memoryImportIntentId: request.memoryImportIntentId,
        memoryImportResultId: request.memoryImportResultId,
        requestSha256: request.requestSha256,
        expectedRevision: request.expectedRevision,
        errorCode: request.errorCode,
        summary: request.summary,
        ...(request.reconciled !== undefined ? { reconciled: request.reconciled } : {}),
      });
      return { schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION, result };
    }),
  );

  router.post(
    "/memory-import/commit-outcome-unknown",
    handle(200, async (c) => {
      const request = commitMemoryImportOutcomeUnknownRequestSchema.parse(
        await parseInternalBody(c),
      );
      const result = await commitMemoryImportOutcomeUnknown(options.deps, {
        commandId: request.commandId,
        memoryImportIntentId: request.memoryImportIntentId,
        memoryImportResultId: request.memoryImportResultId,
        requestSha256: request.requestSha256,
        expectedRevision: request.expectedRevision,
        errorCode: request.errorCode,
        ...(request.reconciled !== undefined ? { reconciled: request.reconciled } : {}),
      });
      return { schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION, result };
    }),
  );

  return router;
}
