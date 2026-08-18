import { defineHook, sleep } from "workflow";
import { z } from "zod";
import type { WorkflowRunSpec } from "@chat/contracts";
import {
  claimConfigurableDecisionHookStep,
  expireApprovalStep,
  loadCommittedDecisionStep,
} from "./workflow-decision-steps.js";
import { executeAndPersistApprovedPlanStep } from "./workflow-execution-steps.js";
import { generateAndPublishPlanStep } from "./workflow-planning-steps.js";
import {
  commitExecutionResultStep,
  commitRejectedRunStep,
  validateExecutionStep,
} from "./workflow-result-steps.js";
import type {
  ConfigurablePlanningWorkflowInput,
  PlanningInterpreterState,
  PlanningNodeIdentity,
} from "./configurable-planning-types.js";
import { freezeWorkflowMemoryContextStep } from "./workflow-memory-steps.js";

const planDecisionHook = defineHook({
  schema: z
    .object({
      schemaVersion: z.literal("plan-decision-hook-payload.v1"),
      productRunId: z.string().regex(/^run_[A-Za-z0-9]+$/),
      approvalRequestId: z.string().regex(/^apr_[A-Za-z0-9]+$/),
      decisionId: z.string().regex(/^dec_[A-Za-z0-9]+$/),
    })
    .strict(),
});

export async function executePlanningNode(input: {
  readonly input: ConfigurablePlanningWorkflowInput;
  readonly runSpec: WorkflowRunSpec;
  readonly definitionNodeId: string;
  readonly nodeType: WorkflowRunSpec["nodeResolutions"][number]["nodeType"];
  readonly config: Readonly<Record<string, unknown>>;
  readonly nodeIdentity: PlanningNodeIdentity;
  readonly state: PlanningInterpreterState;
}): Promise<string> {
  switch (input.nodeType) {
    case "memory.query":
      throw new Error("configurable_planning.memory_query_requires_specialized_boundary");
    case "memory.write":
      throw new Error("configurable_planning.memory_write_requires_specialized_boundary");
    case "context.memory":
      throw new Error("configurable_planning.memory_requires_specialized_boundary");
    case "context.project":
      throw new Error("configurable_planning.project_requires_specialized_boundary");
    case "policy.rules":
      throw new Error("configurable_planning.rules_require_specialized_boundary");
    case "capability.skills":
      return unavailableOptionalResource(input.runSpec, input.definitionNodeId, "skill");
    case "agent.research":
      // 当前pi Planner没有独立、可持久的research结果边界；不能为对齐图再调用一次模型。
      return "no_evidence";
    case "agent.plan":
      return executePlan(input.input, input.state, input.config);
    case "human.plan_review":
      return executePlanReview(input.input, input.state);
    case "execute.plan":
      return executeApprovedPlan(input.input, input.state, input.config);
    case "result.validate":
      return validateCandidate(input.input, input.state, input.config);
    case "product.commit":
      return commitCandidate(input.input, input.state);
    case "note.extract":
    case "note.classify":
    case "human.note_review":
    case "note.commit":
      throw new Error("configurable_planning.note_node_not_allowed");
    default: {
      const exhaustive: never = input.nodeType;
      throw new Error(`configurable_planning.unknown_node:${exhaustive}`);
    }
  }
}

function unavailableOptionalResource(
  runSpec: WorkflowRunSpec,
  definitionNodeId: string,
  resourceKind: "project" | "rule" | "skill",
): "optional_unavailable" {
  const resources = runSpec.resourceResolutions.filter(
    (candidate) =>
      candidate.definitionNodeId === definitionNodeId && candidate.resourceKind === resourceKind,
  );
  if (resources.some((candidate) => candidate.resolution === "included")) {
    // 没有独立读取边界时，选中真实资源必须失败关闭，不能把ref冒充已消费正文。
    throw new Error(`configurable_planning.${resourceKind}_boundary_unavailable`);
  }
  return "optional_unavailable";
}

async function executePlan(
  input: ConfigurablePlanningWorkflowInput,
  state: PlanningInterpreterState,
  config: Readonly<Record<string, unknown>>,
): Promise<"planned" | "needs_input"> {
  if (state.workflowMemoryContextRef === undefined) {
    const frozen = await freezeWorkflowMemoryContextStep({
      productRunId: input.productRunId,
      workflowRunSpecId: input.workflowRunSpecId,
      workflowAttemptId: input.attemptId,
    });
    if (frozen.status === "ready") state.workflowMemoryContextRef = frozen.contextRef;
  }
  state.planRevision += 1;
  const maxSteps = config["maxSteps"];
  if (typeof maxSteps !== "number") {
    state.failure = {
      code: "configurable_planning.plan_config_invalid",
      summary: "计划节点缺少有效的maxSteps冻结配置",
    };
    return "needs_input";
  }
  const generated = await generateAndPublishPlanStep({
    productRunId: input.productRunId,
    attemptId: input.attemptId,
    planRevision: state.planRevision,
    ...(state.contextPackageRef !== undefined
      ? { contextPackageRef: state.contextPackageRef }
      : {}),
    ...(state.planningMemorySelectionRef !== undefined
      ? { planningMemorySelectionRef: state.planningMemorySelectionRef }
      : {}),
    ...(state.workflowMemoryContextRef !== undefined
      ? { workflowMemoryContextRef: state.workflowMemoryContextRef }
      : {}),
    ...(state.planningProjectContextRef !== undefined
      ? { planningProjectContextRef: state.planningProjectContextRef }
      : {}),
    ...(state.ruleSelectionRef !== undefined ? { ruleSelectionRef: state.ruleSelectionRef } : {}),
    maxSteps,
  });
  if (generated.status === "failed") {
    state.failure = {
      code: generated.errorCode,
      summary: "计划候选生成失败，请调整输入或稍后重新开始",
    };
    return "needs_input";
  }
  state.currentReview = generated.review;
  delete state.currentDecision;
  return "planned";
}

async function executePlanReview(
  input: ConfigurablePlanningWorkflowInput,
  state: PlanningInterpreterState,
): Promise<"approved" | "request_revision" | "rejected"> {
  const review = state.currentReview;
  if (review === undefined) throw new Error("configurable_planning.review_without_plan");
  using hook = planDecisionHook.create({ token: review.approvalRequestId });
  if ((await hook.getConflict()) !== null) throw new Error("workflow.hook_conflict");
  await claimConfigurableDecisionHookStep({
    productRunId: input.productRunId,
    attemptId: input.attemptId,
    planRevision: review.planRevision,
    approvalRequestId: review.approvalRequestId,
  });
  const waitResult = await Promise.race([
    hook.then((resumeSignal) => ({ kind: "decision" as const, resumeSignal })),
    sleep(new Date(review.approvalExpiresAt)).then(() => ({ kind: "expired" as const })),
  ]);
  let resumeSignal;
  if (waitResult.kind === "expired") {
    const expiry = await expireApprovalStep({
      productRunId: input.productRunId,
      attemptId: input.attemptId,
      approvalRequestId: review.approvalRequestId,
      expectedExpiresAt: review.approvalExpiresAt,
    });
    if (expiry === "expired") throw new Error("approval.expired");
    resumeSignal = await hook;
  } else {
    resumeSignal = waitResult.resumeSignal;
  }
  const decision = await loadCommittedDecisionStep({
    productRunId: input.productRunId,
    attemptId: input.attemptId,
    decisionId: resumeSignal.decisionId,
    expectedPlanId: review.planId,
    expectedPlanRevision: review.planRevision,
    expectedPlanSha256: review.planSha256,
  });
  state.currentDecision = { decisionId: decision.decisionId, kind: decision.kind };
  if (decision.kind === "reject") {
    await commitRejectedRunStep({
      productRunId: input.productRunId,
      attemptId: input.attemptId,
      decisionId: decision.decisionId,
    });
    state.cancelled = true;
    return "rejected";
  }
  return decision.kind === "approve" ? "approved" : "request_revision";
}

async function executeApprovedPlan(
  input: ConfigurablePlanningWorkflowInput,
  state: PlanningInterpreterState,
  config: Readonly<Record<string, unknown>>,
): Promise<"success" | "failed" | "outcome_unknown"> {
  const decision = state.currentDecision;
  if (decision?.kind !== "approve") {
    throw new Error("configurable_planning.execute_without_approval");
  }
  const maxActions = config["maxActions"];
  if (typeof maxActions !== "number") {
    state.failure = {
      code: "configurable_planning.execute_config_invalid",
      summary: "执行节点缺少有效的maxActions冻结配置",
    };
    return "failed";
  }
  const executed = await executeAndPersistApprovedPlanStep({
    productRunId: input.productRunId,
    attemptId: input.attemptId,
    approvalDecisionId: decision.decisionId,
    maxActions,
  });
  if (executed.status !== "persisted") {
    state.failure = {
      code: executed.errorCode,
      summary:
        executed.status === "outcome_unknown"
          ? "执行或候选提交结果未知，已停止自动重试"
          : "执行未完成，已安全停止",
    };
    return executed.status;
  }
  state.execution = executed.refs;
  return "success";
}

async function validateCandidate(
  input: ConfigurablePlanningWorkflowInput,
  state: PlanningInterpreterState,
  config: Readonly<Record<string, unknown>>,
): Promise<"valid" | "invalid"> {
  if (state.execution === undefined) {
    throw new Error("configurable_planning.validate_without_candidate");
  }
  const strictEvidence = config["strictEvidence"];
  if (typeof strictEvidence !== "boolean") {
    throw new Error("configurable_planning.validation_config_invalid");
  }
  const result = await validateExecutionStep({
    productRunId: input.productRunId,
    executionContractId: state.execution.executionContractId,
    executionCandidateId: state.execution.executionCandidateId,
    workflowAttemptId: input.attemptId,
    strictEvidence,
  });
  state.validation = {
    outcome: result.outcome,
    validationResultId: result.validationResultId,
  };
  if (result.outcome === "fail") {
    state.failure = {
      code: "execution.validation_failed",
      summary: "执行结果未通过服务端验证，未提交为正式结果",
    };
    return "invalid";
  }
  return "valid";
}

async function commitCandidate(
  input: ConfigurablePlanningWorkflowInput,
  state: PlanningInterpreterState,
): Promise<"committed" | "failed"> {
  const execution = state.execution;
  const validation = state.validation;
  if (execution === undefined || validation?.outcome !== "pass") {
    throw new Error("configurable_planning.commit_without_validated_candidate");
  }
  await commitExecutionResultStep({
    productRunId: input.productRunId,
    attemptId: input.attemptId,
    executionContractId: execution.executionContractId,
    executionCandidateId: execution.executionCandidateId,
    validationResultId: validation.validationResultId,
    planSha256: execution.approvedPlanSha256,
  });
  state.productCommitted = true;
  return "committed";
}
