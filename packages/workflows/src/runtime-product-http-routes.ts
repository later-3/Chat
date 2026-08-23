import { z } from "zod";
import { getHookByToken, getRun, resumeHook, start } from "workflow/api";
import {
  WORKFLOW_DEFINITION_ID,
  WORKFLOW_DEFINITION_VERSION,
  workflowResumeRequestSchema,
  workflowStartRequestSchema,
  type TraceEventInput,
} from "@chat/contracts";
import { configurablePlanningWorkflowInputSchema } from "./configurable-planning-workflow.js";
import { directAgentWorkflowInputSchema } from "./direct-agent-workflow-input.js";
import { noteCaptureWorkflowInputSchema } from "./note-capture-workflow.js";
import { planningExecutionWorkflowInputSchema } from "./workflow-input.js";
import {
  CONFIGURABLE_PLANNING_RUNNER_FAMILY,
  DIRECT_AGENT_RUNNER_FAMILY,
  LEGACY_PLANNING_RUNNER_FAMILY,
  NOTE_CAPTURE_RUNNER_FAMILY,
} from "./definition-kernel-executor-registry.js";
import {
  isSupportedPlanningRunnerFamily,
  resolveProductWorkflowRunnerDispatch,
} from "./planning-runner-dispatch.js";
import { captureRunVersionEvidence } from "./runtime-version-evidence.js";
import { workflowRunTraceId, workflowSpanId } from "./runtime-context.js";
import type { WorkflowRuntimeHttpRouteContext } from "./runtime-http-route-context.js";

function normalizedTerminalOutcome(value: unknown) {
  const record =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const terminal =
    typeof record["terminal"] === "object" && record["terminal"] !== null
      ? (record["terminal"] as Record<string, unknown>)
      : undefined;
  const outcome = record["outcome"] ?? terminal?.["outcome"];
  if (outcome === "failed") return "failed" as const;
  if (outcome === "cancelled" || outcome === "rejected") return "cancelled" as const;
  if (outcome === "product_committed" || outcome === "note_committed") {
    return "succeeded" as const;
  }
  return "outcome_unknown" as const;
}

async function readSafeRuntimeRunEvidence(
  bindings: WorkflowRuntimeHttpRouteContext["bindings"],
  productRunId: string,
) {
  try {
    const binding = bindings.getWorkflowBinding(productRunId as never);
    if (binding === undefined) return { state: "unknown" as const };
    const run = getRun(binding.workflowRunId);
    if (!(await run.exists)) return { state: "unknown" as const };
    const status = String(await run.status);
    if (status === "pending" || status === "running") return { state: "active" as const };
    if (status === "failed") {
      return { state: "terminal" as const, outcome: "failed" as const };
    }
    if (status === "cancelled") {
      return { state: "terminal" as const, outcome: "cancelled" as const };
    }
    if (status === "completed") {
      return {
        state: "terminal" as const,
        outcome: normalizedTerminalOutcome(await run.returnValue),
      };
    }
    return { state: "unknown" as const };
  } catch {
    return { state: "unknown" as const };
  }
}

/** 注册Planning/Note正式Runner的start、resume与只读对账端点。 */
export function registerProductWorkflowHttpRoutes(context: WorkflowRuntimeHttpRouteContext): void {
  const options = context;
  const { app, bindings, world, buildEvidence, trace } = context;
  /**
   * 调试导航⑧：API Dispatcher与Vercel Workflow SDK之间的适配边界。
   *
   * 请求仍使用Chat身份，不包含SDK workflowRunId。RuntimeBindingStore先以
   * productRunId+outboxId认领Start意图，再调用SDK；这样HTTP响应丢失后的重复请求
   * 会返回already_started/outcome_unknown，而不是创建第二个Workflow Run。
   * SDK runId只写入Runtime自己的Binding Store，不能回流成浏览器授权或产品身份。
   */
  app.post("/internal/workflow/v1/start", async (c) => {
    const parsed = workflowStartRequestSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ code: "validation_failed", title: "请求不符合合同" }, 400);
    }
    const request = parsed.data;
    let runnerDispatch;
    try {
      runnerDispatch = resolveProductWorkflowRunnerDispatch(request);
    } catch {
      return c.json({ code: "revision_conflict", title: "Product Workflow Runner绑定不一致" }, 409);
    }
    // 在启动SDK Run之前冻结构建/Workflow版本证据，后续恢复先证明仍是同一份可执行定义。
    await captureRunVersionEvidence({
      workflowDataDir: options.workflowDataDir,
      productRunId: request.productRunId,
      buildEvidence,
      now: new Date().toISOString(),
    });
    let startClaim;
    try {
      startClaim = await bindings.claimStartIntent({
        productRunId: request.productRunId,
        outboxId: request.outboxId as never,
        workflowDefinitionVersion: request.workflowDefinitionVersion,
        ...runnerDispatch,
        now: new Date().toISOString(),
      });
    } catch {
      return c.json({ code: "revision_conflict", title: "Planning Runner绑定冲突" }, 409);
    }
    if (startClaim === "already_started") {
      return c.json({ schemaVersion: "chat-workflow-dispatch.v1", status: "already_started" }, 200);
    }
    if (startClaim === "outcome_unknown") {
      return c.json({ schemaVersion: "chat-workflow-dispatch.v1", status: "outcome_unknown" }, 202);
    }
    try {
      // 传给耐久Workflow的输入只含Chat Product Run、Attempt和修订上限；
      // 完整Message/Context由Step通过内部API按版本读取，避免复制多份事实。
      const run =
        runnerDispatch.runnerFamily === CONFIGURABLE_PLANNING_RUNNER_FAMILY
          ? await start({ workflowId: world.configurablePlanningWorkflowId }, [
              configurablePlanningWorkflowInputSchema.parse({
                schemaVersion: "configurable-planning-workflow-input.v1",
                productRunId: request.productRunId,
                attemptId: request.attemptId,
                workflowRunSpecId: runnerDispatch.workflowRunSpecId,
              }),
            ])
          : runnerDispatch.runnerFamily === NOTE_CAPTURE_RUNNER_FAMILY
            ? await start({ workflowId: world.noteCaptureWorkflowId }, [
                noteCaptureWorkflowInputSchema.parse({
                  schemaVersion: "note-capture-workflow-input.v1",
                  productRunId: request.productRunId,
                  attemptId: request.attemptId,
                  workflowRunSpecId: runnerDispatch.workflowRunSpecId,
                }),
              ])
            : runnerDispatch.runnerFamily === DIRECT_AGENT_RUNNER_FAMILY
              ? await start({ workflowId: world.directAgentWorkflowId }, [
                  directAgentWorkflowInputSchema.parse({
                    schemaVersion: "direct-agent-workflow-input.v1",
                    productRunId: request.productRunId,
                    workflowAttemptId: request.attemptId,
                    workflowRunSpecId: runnerDispatch.workflowRunSpecId,
                  }),
                ])
              : await start({ workflowId: world.workflowId }, [
                  planningExecutionWorkflowInputSchema.parse({
                    schemaVersion: "planning-execution-workflow-input.v1",
                    productRunId: request.productRunId,
                    attemptId: request.attemptId,
                    maxPlanRevisions: 5,
                  }),
                ]);
      await bindings.claimWorkflowBinding({
        productRunId: request.productRunId,
        outboxId: request.outboxId as never,
        workflowRunId: run.runId,
        workflowDefinitionVersion: request.workflowDefinitionVersion,
        ...runnerDispatch,
        now: new Date().toISOString(),
      });
      trace({
        level: "info",
        eventName: "workflow.start.started",
        outcome: "unknown",
        traceId: workflowRunTraceId(request.productRunId),
        spanId: workflowSpanId(),
        productRunId: request.productRunId,
        attemptId: request.attemptId,
        workflowDefinitionVersion: WORKFLOW_DEFINITION_VERSION,
        workflowDefinitionId: WORKFLOW_DEFINITION_ID,
        runMappingRef: `map_${request.productRunId.slice(4)}`,
      } as TraceEventInput);
      return c.json({ schemaVersion: "chat-workflow-dispatch.v1", status: "started" }, 201);
    } catch {
      await bindings.markStartOutcomeUnknown(request.productRunId, new Date().toISOString());
      trace({
        level: "warn",
        eventName: "workflow.start.failed",
        outcome: "failure",
        traceId: workflowRunTraceId(request.productRunId),
        spanId: workflowSpanId(),
        productRunId: request.productRunId,
        attemptId: request.attemptId,
        workflowDefinitionVersion: WORKFLOW_DEFINITION_VERSION,
        workflowDefinitionId: WORKFLOW_DEFINITION_ID,
        error: { code: "workflow.start_failed", type: "WorkflowStartError" },
      } as TraceEventInput);
      return c.json({ schemaVersion: "chat-workflow-dispatch.v1", status: "outcome_unknown" }, 202);
    }
  });

  app.post("/internal/workflow/v1/resume", async (c) => {
    const parsed = workflowResumeRequestSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ code: "validation_failed", title: "请求不符合合同" }, 400);
    }
    const request = parsed.data;
    const isNoteResume = "hookNoteCandidateId" in request;
    const isPromptReviewResume = "promptReviewRequestId" in request;
    // 产品Decision先成为可见事实，Workflow随后提交Hook绑定；Decision可能落在这段窄窗口。
    // 只等待绑定出现，不把超时猜成终态；Hook注册已由getConflict在绑定Step之前耐久提交。
    let binding = isNoteResume
      ? bindings.getNoteHookBinding(request.hookNoteCandidateId)
      : isPromptReviewResume
        ? bindings.getPromptReviewHookBinding(request.promptReviewRequestId)
        : bindings.getHookBinding(request.approvalRequestId);
    if (binding === undefined) {
      const deadline = Date.now() + 5_000;
      while (binding === undefined && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        binding = isNoteResume
          ? bindings.getNoteHookBinding(request.hookNoteCandidateId)
          : isPromptReviewResume
            ? bindings.getPromptReviewHookBinding(request.promptReviewRequestId)
            : bindings.getHookBinding(request.approvalRequestId);
      }
    }
    if (binding === undefined || binding.productRunId !== request.productRunId) {
      // Decision可能先于Workflow完成Hook绑定；没有映射证明不了终态，等待对账后重派。
      return c.json({ schemaVersion: "chat-workflow-dispatch.v1", status: "outcome_unknown" }, 202);
    }
    const workflowBinding = bindings.getWorkflowBinding(request.productRunId);
    if (
      workflowBinding === undefined ||
      (isNoteResume
        ? workflowBinding.runnerFamily !== NOTE_CAPTURE_RUNNER_FAMILY
        : isPromptReviewResume
          ? workflowBinding.runnerFamily !== DIRECT_AGENT_RUNNER_FAMILY
          : !isSupportedPlanningRunnerFamily(workflowBinding.runnerFamily))
    ) {
      return c.json({ code: "revision_conflict", title: "Workflow Runner绑定缺失" }, 409);
    }
    if (binding.resumeDispatchState === "dispatched") {
      return c.json({ schemaVersion: "chat-workflow-dispatch.v1", status: "already_resumed" }, 200);
    }
    if (
      binding.resumeDispatchState === "dispatching" ||
      binding.resumeDispatchState === "outcome_unknown"
    ) {
      return c.json({ schemaVersion: "chat-workflow-dispatch.v1", status: "outcome_unknown" }, 202);
    }
    if (binding.resumeDispatchState === "failed_terminal") {
      return c.json({ code: "workflow_resume_unknown", title: "Hook恢复已终止" }, 409);
    }
    try {
      await getHookByToken(binding.hookToken);
    } catch {
      // 绑定只应在Hook注册后出现；恢复中的短暂不可见保持未知，不作终态猜测。
      return c.json({ schemaVersion: "chat-workflow-dispatch.v1", status: "outcome_unknown" }, 202);
    }
    if (isNoteResume) {
      await bindings.markNoteResumeDispatching(
        request.hookNoteCandidateId,
        new Date().toISOString(),
      );
    } else if (!isPromptReviewResume) {
      await bindings.markResumeDispatching(request.approvalRequestId, new Date().toISOString());
    } else {
      let claim;
      try {
        claim = await bindings.claimPromptReviewResumeDispatch({
          promptReviewRequestId: request.promptReviewRequestId,
          promptReviewDecisionId: request.promptReviewDecisionId,
          requestRevision: request.requestRevision,
          reviewSha256: request.reviewSha256,
          now: new Date().toISOString(),
        });
      } catch {
        return c.json({ code: "revision_conflict", title: "Prompt Review Hook绑定冲突" }, 409);
      }
      if (claim === "already_dispatched") {
        return c.json(
          { schemaVersion: "chat-workflow-dispatch.v1", status: "already_resumed" },
          200,
        );
      }
      if (claim === "outcome_unknown") {
        return c.json(
          { schemaVersion: "chat-workflow-dispatch.v1", status: "outcome_unknown" },
          202,
        );
      }
      if (claim === "failed_terminal") {
        return c.json({ code: "workflow_resume_unknown", title: "Hook恢复已终止" }, 409);
      }
    }
    try {
      const payload = isNoteResume
        ? {
            schemaVersion: "note-decision-hook-payload.v1",
            productRunId: request.productRunId,
            hookNoteCandidateId: request.hookNoteCandidateId,
            noteCandidateId: request.noteCandidateId,
            noteDecisionId: request.noteDecisionId,
          }
        : isPromptReviewResume
          ? {
              schemaVersion: "prompt-review-decision-hook-payload.v1",
              productRunId: request.productRunId,
              promptReviewRequestId: request.promptReviewRequestId,
              promptReviewDecisionId: request.promptReviewDecisionId,
              requestRevision: request.requestRevision,
              reviewSha256: request.reviewSha256,
              payloadSha256: request.payloadSha256,
            }
          : {
              schemaVersion: "plan-decision-hook-payload.v1",
              productRunId: request.productRunId,
              approvalRequestId: request.approvalRequestId,
              decisionId: request.decisionId,
            };
      // Hook Token已经绑定创建它的Workflow；family分支在这里仍显式穷尽，禁止恢复时
      // 根据当前默认开关猜Runner。两代Planning暂时共享最小decision-ref payload合同。
      if (
        !isNoteResume &&
        !isPromptReviewResume &&
        workflowBinding.runnerFamily !== LEGACY_PLANNING_RUNNER_FAMILY &&
        workflowBinding.runnerFamily !== CONFIGURABLE_PLANNING_RUNNER_FAMILY
      ) {
        return c.json({ code: "revision_conflict", title: "Planning Runner版本不受支持" }, 409);
      }
      await resumeHook(binding.hookToken, payload);
      if (!isNoteResume && !isPromptReviewResume) {
        // Plan审核同时耐久等待Hook与到期sleep。Hook事件已先写入SDK事件日志后，唤醒
        // 同一Run的sleep，既保持确定的“决定优先”顺序，也避免每轮审核留下悬空操作。
        await getRun(workflowBinding.workflowRunId).wakeUp();
      }
      if (isNoteResume) {
        await bindings.markNoteResumeDispatched(
          request.hookNoteCandidateId,
          new Date().toISOString(),
        );
      } else if (isPromptReviewResume) {
        await bindings.markPromptReviewResumeDispatched({
          promptReviewRequestId: request.promptReviewRequestId,
          promptReviewDecisionId: request.promptReviewDecisionId,
          now: new Date().toISOString(),
        });
      } else {
        await bindings.markResumeDispatched(request.approvalRequestId, new Date().toISOString());
      }
      trace({
        level: "info",
        eventName: "workflow.hook.resume_dispatched",
        outcome: "success",
        traceId: workflowRunTraceId(request.productRunId),
        spanId: workflowSpanId(),
        productRunId: request.productRunId,
        attemptId: request.attemptId,
        workflowDefinitionVersion: WORKFLOW_DEFINITION_VERSION,
        resumeAttempt: 1,
      } as TraceEventInput);
      return c.json({ schemaVersion: "chat-workflow-dispatch.v1", status: "resumed" }, 200);
    } catch (resumeError) {
      void resumeError;
      if (isNoteResume) {
        await bindings.markNoteResumeOutcomeUnknown(
          request.hookNoteCandidateId,
          new Date().toISOString(),
        );
      } else if (isPromptReviewResume) {
        await bindings.markPromptReviewResumeOutcomeUnknown({
          promptReviewRequestId: request.promptReviewRequestId,
          promptReviewDecisionId: request.promptReviewDecisionId,
          now: new Date().toISOString(),
        });
      } else {
        await bindings.markResumeOutcomeUnknown(
          request.approvalRequestId,
          new Date().toISOString(),
        );
      }
      console.error("[workflow-runtime] resumeHook失败，结果=outcome_unknown");
      trace({
        level: "warn",
        eventName: "workflow.hook.resume_failed",
        outcome: "failure",
        traceId: workflowRunTraceId(request.productRunId),
        spanId: workflowSpanId(),
        productRunId: request.productRunId,
        attemptId: request.attemptId,
        workflowDefinitionVersion: WORKFLOW_DEFINITION_VERSION,
        resumeAttempt: 1,
        error: { code: "workflow.hook_resume_failed", type: "HookResumeError" },
      } as TraceEventInput);
      return c.json({ schemaVersion: "chat-workflow-dispatch.v1", status: "outcome_unknown" }, 202);
    }
  });

  const reconcileQuerySchema = z
    .object({
      productRunId: z.string().min(1),
      approvalRequestId: z.string().min(1).optional(),
      hookNoteCandidateId: z.string().min(1).optional(),
      promptReviewRequestId: z.string().min(1).optional(),
    })
    .strict()
    .refine(
      (value) =>
        [value.approvalRequestId, value.hookNoteCandidateId, value.promptReviewRequestId].filter(
          (item) => item !== undefined,
        ).length <= 1,
      { message: "只能提供一种Hook身份" },
    );
  app.get("/internal/workflow/v1/reconcile", async (c) => {
    const query = reconcileQuerySchema.safeParse(c.req.query());
    if (!query.success) {
      return c.json({ code: "validation_failed", title: "请求不符合合同" }, 400);
    }
    const startBinding = bindings.getStartState(query.data.productRunId as never);
    const hookBinding =
      query.data.approvalRequestId !== undefined
        ? bindings.getHookBinding(query.data.approvalRequestId as never)
        : query.data.hookNoteCandidateId !== undefined
          ? bindings.getNoteHookBinding(query.data.hookNoteCandidateId as never)
          : query.data.promptReviewRequestId !== undefined
            ? bindings.getPromptReviewHookBinding(query.data.promptReviewRequestId as never)
            : undefined;
    const runtimeRun =
      startBinding === "exists"
        ? await readSafeRuntimeRunEvidence(bindings, query.data.productRunId)
        : undefined;
    return c.json({
      schemaVersion: "chat-workflow-dispatch.v1",
      productRunId: query.data.productRunId,
      startBinding,
      ...(runtimeRun === undefined ? {} : { runtimeRun }),
      ...(query.data.approvalRequestId !== undefined ||
      query.data.hookNoteCandidateId !== undefined ||
      query.data.promptReviewRequestId !== undefined
        ? {
            hookResumeState:
              hookBinding === undefined ? "missing" : hookBinding.resumeDispatchState,
          }
        : {}),
    });
  });
}
