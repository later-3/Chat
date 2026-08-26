import { z } from "zod";
import { resolvedCapabilityRefSchema, resolvedCapabilitySnapshotSchema } from "./capability.js";
import { sha256Schema } from "./hash.js";
import {
  agentVersionIdSchema,
  commandIdSchema,
  executionContractIdSchema,
  planIdSchema,
  principalIdSchema,
  productRunIdSchema,
  promptAssemblyIdSchema,
  runAttemptIdSchema,
  supervisedAgentObservationIdSchema,
  supervisedCarryForwardIdSchema,
  supervisedExecutionResultIdSchema,
  supervisedPlannerVerdictIdSchema,
  supervisedPlanningEpochIdSchema,
  supervisedStepCandidateIdSchema,
  supervisedStepDecisionIdSchema,
  supervisedStepEvidenceIdSchema,
  supervisedStepReviewRequestIdSchema,
  supervisedStepStateIdSchema,
  toolExecutionResultIdSchema,
} from "./ids.js";

/**
 * 监督执行v3只描述Chat拥有的产品事实。Pi完整事件继续只写`full-operation.v3`
 * Journal；这里不会保存Pi Session、Operation ID、Provider Payload或隐藏推理。
 */
export const SUPERVISED_PLANNING_V3_FOUNDATION_VERSION =
  "supervised-planning-foundation.v3" as const;

const isoDateTimeSchema = z.iso.datetime();
const stableErrorCodeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$/u)
  .max(96);
const stepIdSchema = z.string().min(1).max(100);
const entityBaseFields = {
  revision: z.number().int().positive(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
} as const;

export const supervisedAgentRoleV3Schema = z.enum(["executor", "reviewer"]);

export const supervisedApprovedPlanRefV3Schema = z
  .object({
    planId: planIdSchema,
    planRevision: z.number().int().positive(),
    sha256: sha256Schema,
  })
  .strict();

export const supervisedExecutionContractRefV3Schema = z
  .object({
    executionContractId: executionContractIdSchema,
    revision: z.number().int().positive(),
    sha256: sha256Schema,
  })
  .strict();

export const supervisedPlanningEpochRefV3Schema = z
  .object({
    planningEpochId: supervisedPlanningEpochIdSchema,
    epochNumber: z.number().int().positive().max(20),
    revision: z.number().int().positive(),
    sha256: sha256Schema,
  })
  .strict();

export const supervisedAgentVersionRefV3Schema = z
  .object({
    agentVersionId: agentVersionIdSchema,
    sha256: sha256Schema,
  })
  .strict();

export const supervisedPromptAssemblyRoleRefV3Schema = z
  .object({
    promptAssemblyId: promptAssemblyIdSchema,
    promptAssemblySha256: sha256Schema,
    roleAssemblySha256: sha256Schema,
    role: supervisedAgentRoleV3Schema,
  })
  .strict();

/**
 * 每轮保存完整有序Capability Snapshot，并用Manifest Hash把顺序、来源、实现与Scope一起冻结。
 * 裸`localName`只能作为Pi本地投影，不能单独成为授权身份。
 */
export const supervisedCapabilityManifestV3Schema = z
  .object({
    schemaVersion: z.literal("supervised-capability-manifest.v3"),
    capabilities: z.array(resolvedCapabilitySnapshotSchema).max(32),
    sha256: sha256Schema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const capabilityIds = new Set<string>();
    const qualifiedRefs = new Set<string>();
    const localNames = new Set<string>();
    value.capabilities.forEach((capability, index) => {
      const qualifiedRef = JSON.stringify(capability.ref);
      if (capabilityIds.has(capability.ref.capabilityId)) {
        ctx.addIssue({
          code: "custom",
          path: ["capabilities", index, "ref", "capabilityId"],
          message: "监督Agent Capability ID不能重复",
        });
      }
      if (qualifiedRefs.has(qualifiedRef)) {
        ctx.addIssue({
          code: "custom",
          path: ["capabilities", index, "ref"],
          message: "监督Agent qualified Capability Ref不能重复",
        });
      }
      if (localNames.has(capability.localName)) {
        ctx.addIssue({
          code: "custom",
          path: ["capabilities", index, "localName"],
          message: "监督Agent Capability localName不能重复",
        });
      }
      capabilityIds.add(capability.ref.capabilityId);
      qualifiedRefs.add(qualifiedRef);
      localNames.add(capability.localName);
    });
  });

export const supervisedStepIdentityV3Schema = z
  .object({
    productRunId: productRunIdSchema,
    planningEpochRef: supervisedPlanningEpochRefV3Schema,
    executionContractRef: supervisedExecutionContractRefV3Schema,
    stepId: stepIdSchema,
    /** Executor返工产生新Step Revision；相同stepId不能掩盖旧纪元或旧Contract。 */
    stepRevision: z.number().int().positive().max(20),
  })
  .strict();

export const supervisedAgentAttemptRefV3Schema = z
  .object({
    attemptId: runAttemptIdSchema,
    role: supervisedAgentRoleV3Schema,
    agentRound: z.number().int().positive().max(20),
    revision: z.number().int().positive(),
    inputManifestSha256: sha256Schema,
    sha256: sha256Schema,
  })
  .strict();

export const supervisedStepEvidenceRefV3Schema = z
  .object({
    evidenceId: supervisedStepEvidenceIdSchema,
    revision: z.number().int().positive(),
    sha256: sha256Schema,
  })
  .strict();

export const supervisedStepCandidateRefV3Schema = z
  .object({
    candidateId: supervisedStepCandidateIdSchema,
    revision: z.number().int().positive(),
    sha256: sha256Schema,
  })
  .strict();

export const supervisedPlannerVerdictKindV3Schema = z.enum([
  "pass",
  "retry_step",
  "replan_remaining",
  "blocked",
]);

export const supervisedPlannerVerdictRefV3Schema = z
  .object({
    verdictId: supervisedPlannerVerdictIdSchema,
    revision: z.number().int().positive(),
    sha256: sha256Schema,
    kind: supervisedPlannerVerdictKindV3Schema,
  })
  .strict();

export const supervisedProductReviewKindV3Schema = z.enum([
  "executor_candidate",
  "reviewer_verdict",
  "outcome_unknown",
]);

/** Product Review使用独立身份域，不能复用Tool Execution Decision。 */
export const supervisedStepReviewRequestRefV3Schema = z
  .object({
    reviewRequestId: supervisedStepReviewRequestIdSchema,
    reviewKind: supervisedProductReviewKindV3Schema,
    revision: z.number().int().positive(),
    sha256: sha256Schema,
  })
  .strict();

export const supervisedStepDecisionRefV3Schema = z
  .object({
    decisionId: supervisedStepDecisionIdSchema,
    revision: z.number().int().positive(),
    sha256: sha256Schema,
  })
  .strict();

/**
 * 阶段1只冻结未来ToolExecution v2需要的监督Subject身份，不让现有Direct专属v1
 * 解释监督Attempt。该引用在v2产品合同落地前不能成为可提交Evidence。
 */
export const supervisedToolExecutionResultRefV2Schema = z
  .object({
    schemaVersion: z.literal("tool-execution-result-ref.v2"),
    toolExecutionResultId: toolExecutionResultIdSchema,
    stepIdentity: supervisedStepIdentityV3Schema,
    attemptRef: supervisedAgentAttemptRefV3Schema,
    resultSha256: sha256Schema,
  })
  .strict();

export const supervisedStepStateVersionRefV3Schema = z
  .object({
    supervisedStepStateId: supervisedStepStateIdSchema,
    revision: z.number().int().positive(),
    stepRevision: z.number().int().positive().max(20),
    sha256: sha256Schema,
  })
  .strict();

export const supervisedAgentOutcomeObservationRefV3Schema = z
  .object({
    observationId: supervisedAgentObservationIdSchema,
    revision: z.number().int().positive(),
    sha256: sha256Schema,
  })
  .strict();

export const supervisedCarryForwardRefV3Schema = z
  .object({
    carryForwardId: supervisedCarryForwardIdSchema,
    stepId: stepIdSchema,
    revision: z.number().int().positive(),
    sha256: sha256Schema,
  })
  .strict();

export const supervisedExecutionLimitsV3Schema = z
  .object({
    maxExecutorRoundsPerStep: z.number().int().positive().max(20),
    maxReviewerRoundsPerStep: z.number().int().positive().max(20),
    maxPlanRevisions: z.number().int().positive().max(20),
  })
  .strict();

const roleBindingSchema = z
  .object({
    role: supervisedAgentRoleV3Schema,
    agentVersionRef: supervisedAgentVersionRefV3Schema,
    promptAssemblyRoleRef: supervisedPromptAssemblyRoleRefV3Schema,
    capabilityManifestSha256: sha256Schema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.role !== value.promptAssemblyRoleRef.role) {
      ctx.addIssue({
        code: "custom",
        path: ["promptAssemblyRoleRef", "role"],
        message: "监督角色与Prompt Assembly角色不一致",
      });
    }
  });

export const supervisedPlanningEpochV3Schema = z
  .object({
    schemaVersion: z.literal("supervised-planning-epoch.v3"),
    planningEpochId: supervisedPlanningEpochIdSchema,
    productRunId: productRunIdSchema,
    epochNumber: z.number().int().positive().max(20),
    productRunRevisionBaseline: z.number().int().positive(),
    approvedPlanRef: supervisedApprovedPlanRefV3Schema,
    executionContractRef: supervisedExecutionContractRefV3Schema,
    roleBindings: z.array(roleBindingSchema).length(2),
    limits: supervisedExecutionLimitsV3Schema,
    lineage: z
      .object({
        supersedesEpochRef: supervisedPlanningEpochRefV3Schema,
        triggerStateRef: supervisedStepStateVersionRefV3Schema,
        triggerVerdictRef: supervisedPlannerVerdictRefV3Schema.extend({
          kind: z.literal("replan_remaining"),
        }),
        triggerDecisionRef: supervisedStepDecisionRefV3Schema,
      })
      .strict()
      .optional(),
    carryForwardRefs: z.array(supervisedCarryForwardRefV3Schema).max(50),
    sha256: sha256Schema,
    ...entityBaseFields,
  })
  .strict()
  .superRefine((value, ctx) => {
    const roles = value.roleBindings.map((binding) => binding.role).sort();
    if (JSON.stringify(roles) !== JSON.stringify(["executor", "reviewer"])) {
      ctx.addIssue({
        code: "custom",
        path: ["roleBindings"],
        message: "每个Planning Epoch必须精确冻结Executor与Reviewer",
      });
    }
    const first = value.epochNumber === 1;
    if (first !== (value.lineage === undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["lineage"],
        message: "首纪元不得有重规划血缘，后继纪元必须绑定前一纪元",
      });
    }
    if (first && value.carryForwardRefs.length !== 0) {
      ctx.addIssue({
        code: "custom",
        path: ["carryForwardRefs"],
        message: "首纪元不能携带旧Step",
      });
    }
    if (
      value.lineage !== undefined &&
      value.lineage.supersedesEpochRef.epochNumber + 1 !== value.epochNumber
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["epochNumber"],
        message: "Planning Epoch必须连续递增",
      });
    }
    if (
      new Set(value.carryForwardRefs.map((ref) => ref.stepId)).size !==
      value.carryForwardRefs.length
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["carryForwardRefs"],
        message: "同一纪元不能重复携带Step",
      });
    }
  });

export const supervisedCarryForwardV3Schema = z
  .object({
    schemaVersion: z.literal("supervised-carry-forward.v3"),
    carryForwardId: supervisedCarryForwardIdSchema,
    productRunId: productRunIdSchema,
    sourcePlanningEpochRef: supervisedPlanningEpochRefV3Schema,
    targetPlanningEpochId: supervisedPlanningEpochIdSchema,
    targetEpochNumber: z.number().int().positive().max(20),
    stepId: stepIdSchema,
    sourceStateRef: supervisedStepStateVersionRefV3Schema,
    candidateRef: supervisedStepCandidateRefV3Schema,
    passVerdictRef: supervisedPlannerVerdictRefV3Schema.extend({ kind: z.literal("pass") }),
    acceptanceDecisionRef: supervisedStepDecisionRefV3Schema,
    priorCarryForwardRef: supervisedCarryForwardRefV3Schema.optional(),
    sha256: sha256Schema,
    ...entityBaseFields,
  })
  .strict()
  .superRefine((value, ctx) => {
    const distance = value.targetEpochNumber - value.sourcePlanningEpochRef.epochNumber;
    if (
      distance < 1 ||
      (distance === 1 && value.priorCarryForwardRef !== undefined) ||
      (distance > 1 && value.priorCarryForwardRef === undefined)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["priorCarryForwardRef"],
        message: "Carry Forward必须逐纪元形成连续血缘",
      });
    }
  });

const supervisedAgentAttemptCommon = {
  schemaVersion: z.literal("supervised-agent-attempt.v3"),
  attemptId: runAttemptIdSchema,
  stepIdentity: supervisedStepIdentityV3Schema,
  supervisedStepStateId: supervisedStepStateIdSchema,
  role: supervisedAgentRoleV3Schema,
  agentRound: z.number().int().positive().max(20),
  inputStateRevision: z.number().int().positive(),
  inputProductRunRevision: z.number().int().positive(),
  agentVersionRef: supervisedAgentVersionRefV3Schema,
  promptAssemblyRoleRef: supervisedPromptAssemblyRoleRefV3Schema,
  capabilityManifest: supervisedCapabilityManifestV3Schema,
  inputManifestSha256: sha256Schema,
  journalIntegrityVersion: z.literal("full-operation.v3"),
  triggerDecisionRef: supervisedStepDecisionRefV3Schema.optional(),
  sha256: sha256Schema,
  ...entityBaseFields,
} as const;

export const supervisedAgentAttemptV3Schema = z
  .discriminatedUnion("outcome", [
    z.object({ ...supervisedAgentAttemptCommon, outcome: z.literal("running") }).strict(),
    z
      .object({
        ...supervisedAgentAttemptCommon,
        outcome: z.literal("success"),
        assistantVisibleTextSha256: sha256Schema,
      })
      .strict(),
    z
      .object({
        ...supervisedAgentAttemptCommon,
        outcome: z.literal("failure"),
        errorCode: stableErrorCodeSchema,
      })
      .strict(),
    z
      .object({
        ...supervisedAgentAttemptCommon,
        outcome: z.literal("outcome_unknown"),
        errorCode: stableErrorCodeSchema,
      })
      .strict(),
  ])
  .superRefine((value, ctx) => {
    if (value.role !== value.promptAssemblyRoleRef.role) {
      ctx.addIssue({
        code: "custom",
        path: ["promptAssemblyRoleRef", "role"],
        message: "Attempt角色与Prompt Assembly角色不一致",
      });
    }
  });

export const supervisedStepCriterionRefV3Schema = z
  .object({
    criterionIndex: z.number().int().nonnegative().max(49),
    sha256: sha256Schema,
  })
  .strict();

const criterionRefsSchema = z
  .array(supervisedStepCriterionRefV3Schema)
  .min(1)
  .max(50)
  .refine(
    (refs) =>
      refs.every((ref, index) => ref.criterionIndex === index) &&
      new Set(refs.map((ref) => ref.criterionIndex)).size === refs.length,
    { message: "成功标准引用必须从0开始连续且不能重复" },
  );

const evidenceRefsSchema = z
  .array(supervisedStepEvidenceRefV3Schema)
  .min(1)
  .max(100)
  .refine((refs) => new Set(refs.map((ref) => ref.evidenceId)).size === refs.length, {
    message: "Evidence引用不能重复",
  });

/**
 * Evidence只能由通过统一Validator的`full-operation.v3` Tool Result派生。模型可提出
 * Candidate正文，但不能自己制造“测试通过”证据或私有Operation引用。
 */
export const supervisedStepEvidenceV3Schema = z
  .object({
    schemaVersion: z.literal("supervised-step-evidence.v3"),
    evidenceId: supervisedStepEvidenceIdSchema,
    stepIdentity: supervisedStepIdentityV3Schema,
    attemptRef: supervisedAgentAttemptRefV3Schema,
    criterionRefs: z.array(supervisedStepCriterionRefV3Schema).min(1).max(50),
    derivation: z.literal("verified_pi_full_operation_v3"),
    source: z
      .object({
        toolCallId: z.string().min(1).max(160),
        localName: z.string().min(1).max(160),
        capabilityRef: resolvedCapabilityRefSchema,
        inputSha256: sha256Schema,
        resultSha256: sha256Schema,
        journalResultSha256: sha256Schema,
        /** 阶段2由ToolExecution v2交叉核对；v24基础层不接受Direct v1 Result。 */
        productToolResultRef: supervisedToolExecutionResultRefV2Schema.optional(),
      })
      .strict(),
    displaySummary: z.string().trim().min(1).max(1_000),
    sha256: sha256Schema,
    ...entityBaseFields,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      new Set(value.criterionRefs.map((ref) => ref.criterionIndex)).size !==
      value.criterionRefs.length
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["criterionRefs"],
        message: "Evidence成功标准引用不能重复",
      });
    }
  });

export const supervisedStepCandidateV3Schema = z
  .object({
    schemaVersion: z.literal("supervised-step-candidate.v3"),
    candidateId: supervisedStepCandidateIdSchema,
    stepIdentity: supervisedStepIdentityV3Schema,
    executorAttemptRef: supervisedAgentAttemptRefV3Schema.extend({ role: z.literal("executor") }),
    assistantVisibleTextSha256: sha256Schema,
    output: z
      .object({ format: z.literal("markdown"), text: z.string().trim().min(1).max(100_000) })
      .strict(),
    evidenceRefs: evidenceRefsSchema,
    warnings: z.array(z.string().trim().min(1).max(500)).max(50),
    sha256: sha256Schema,
    ...entityBaseFields,
  })
  .strict();

const verdictCommon = {
  schemaVersion: z.literal("supervised-reviewer-verdict.v3"),
  verdictId: supervisedPlannerVerdictIdSchema,
  stepIdentity: supervisedStepIdentityV3Schema,
  candidateRef: supervisedStepCandidateRefV3Schema,
  reviewerAttemptRef: supervisedAgentAttemptRefV3Schema.extend({ role: z.literal("reviewer") }),
  assistantVisibleTextSha256: sha256Schema,
  assistantVisibleText: z.string().trim().min(1).max(100_000),
  reviewedEvidenceRefs: evidenceRefsSchema,
  summary: z.string().trim().min(1).max(2_000),
  findings: z.array(z.string().trim().min(1).max(1_000)).max(50),
  sha256: sha256Schema,
  ...entityBaseFields,
} as const;

export const supervisedPlannerVerdictV3Schema = z.discriminatedUnion("kind", [
  z
    .object({ ...verdictCommon, kind: z.literal("pass"), verifiedCriteria: criterionRefsSchema })
    .strict(),
  z
    .object({
      ...verdictCommon,
      kind: z.literal("retry_step"),
      failedCriteria: z.array(supervisedStepCriterionRefV3Schema).min(1).max(50),
      retryInstruction: z.string().trim().min(1).max(4_000),
    })
    .strict(),
  z
    .object({
      ...verdictCommon,
      kind: z.literal("replan_remaining"),
      invalidatedRemainingStepIds: z
        .array(stepIdSchema)
        .min(1)
        .max(50)
        .refine((ids) => new Set(ids).size === ids.length, {
          message: "待重规划Step ID不能重复",
        }),
      replanInstruction: z.string().trim().min(1).max(4_000),
    })
    .strict(),
  z
    .object({
      ...verdictCommon,
      kind: z.literal("blocked"),
      blocker: z.string().trim().min(1).max(2_000),
      requiredResolution: z.string().trim().min(1).max(2_000),
    })
    .strict(),
]);

const reviewDecisionStateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("open") }).strict(),
  z.object({ status: z.literal("decided"), decisionId: supervisedStepDecisionIdSchema }).strict(),
  z
    .object({
      status: z.literal("expired"),
      reasonCode: stableErrorCodeSchema,
      expiredAt: isoDateTimeSchema,
    })
    .strict(),
]);

const reviewRequestCommon = {
  schemaVersion: z.literal("supervised-step-review-request.v3"),
  reviewRequestId: supervisedStepReviewRequestIdSchema,
  decisionBoundary: z.literal("product_review"),
  stepIdentity: supervisedStepIdentityV3Schema,
  decisionState: reviewDecisionStateSchema,
  sha256: sha256Schema,
  ...entityBaseFields,
} as const;

export const supervisedStepReviewRequestV3Schema = z.discriminatedUnion("reviewKind", [
  z
    .object({
      ...reviewRequestCommon,
      reviewKind: z.literal("executor_candidate"),
      candidateRef: supervisedStepCandidateRefV3Schema,
    })
    .strict(),
  z
    .object({
      ...reviewRequestCommon,
      reviewKind: z.literal("reviewer_verdict"),
      candidateRef: supervisedStepCandidateRefV3Schema,
      verdictRef: supervisedPlannerVerdictRefV3Schema,
    })
    .strict(),
  z
    .object({
      ...reviewRequestCommon,
      reviewKind: z.literal("outcome_unknown"),
      agentRole: supervisedAgentRoleV3Schema,
      stateRef: supervisedStepStateVersionRefV3Schema,
      attemptRef: supervisedAgentAttemptRefV3Schema,
      outcomeObservationRef: supervisedAgentOutcomeObservationRefV3Schema,
    })
    .strict(),
]);

const candidateReviewActionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("send_to_reviewer"),
      comment: z.string().trim().min(1).max(2_000).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("retry_executor"),
      instruction: z.string().trim().min(1).max(4_000),
    })
    .strict(),
  z.object({ kind: z.literal("block"), reason: z.string().trim().min(1).max(2_000) }).strict(),
]);

const verdictReviewActionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("accept_verdict"),
      comment: z.string().trim().min(1).max(2_000).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("retry_reviewer"),
      instruction: z.string().trim().min(1).max(4_000),
    })
    .strict(),
  z.object({ kind: z.literal("block"), reason: z.string().trim().min(1).max(2_000) }).strict(),
]);

const outcomeUnknownReviewActionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("retry_agent"),
      acknowledgement: z.literal("journal_and_product_facts_checked"),
      instruction: z.string().trim().min(1).max(4_000),
    })
    .strict(),
  z.object({ kind: z.literal("block"), reason: z.string().trim().min(1).max(2_000) }).strict(),
]);

const humanDecisionCommon = {
  schemaVersion: z.literal("supervised-step-human-decision.v3"),
  decisionId: supervisedStepDecisionIdSchema,
  decisionBoundary: z.literal("product_review"),
  stepIdentity: supervisedStepIdentityV3Schema,
  principalId: principalIdSchema,
  commandId: commandIdSchema,
  sha256: sha256Schema,
  ...entityBaseFields,
} as const;

export const supervisedStepHumanDecisionV3Schema = z.discriminatedUnion("reviewKind", [
  z
    .object({
      ...humanDecisionCommon,
      reviewKind: z.literal("executor_candidate"),
      reviewRequestRef: supervisedStepReviewRequestRefV3Schema.extend({
        reviewKind: z.literal("executor_candidate"),
      }),
      candidateRef: supervisedStepCandidateRefV3Schema,
      action: candidateReviewActionSchema,
    })
    .strict(),
  z
    .object({
      ...humanDecisionCommon,
      reviewKind: z.literal("reviewer_verdict"),
      reviewRequestRef: supervisedStepReviewRequestRefV3Schema.extend({
        reviewKind: z.literal("reviewer_verdict"),
      }),
      candidateRef: supervisedStepCandidateRefV3Schema,
      verdictRef: supervisedPlannerVerdictRefV3Schema,
      action: verdictReviewActionSchema,
    })
    .strict(),
  z
    .object({
      ...humanDecisionCommon,
      reviewKind: z.literal("outcome_unknown"),
      reviewRequestRef: supervisedStepReviewRequestRefV3Schema.extend({
        reviewKind: z.literal("outcome_unknown"),
      }),
      agentRole: supervisedAgentRoleV3Schema,
      stateRef: supervisedStepStateVersionRefV3Schema,
      attemptRef: supervisedAgentAttemptRefV3Schema,
      outcomeObservationRef: supervisedAgentOutcomeObservationRefV3Schema,
      action: outcomeUnknownReviewActionSchema,
    })
    .strict(),
]);

const stepStateCommon = {
  schemaVersion: z.literal("supervised-step-state.v3"),
  supervisedStepStateId: supervisedStepStateIdSchema,
  previousStateRef: supervisedStepStateVersionRefV3Schema.optional(),
  stepIdentity: supervisedStepIdentityV3Schema,
  productRunRevisionBaseline: z.number().int().positive(),
  limits: supervisedExecutionLimitsV3Schema,
  successCriteriaRefs: criterionRefsSchema,
  dependencyStepIds: z.array(stepIdSchema).max(50),
  remainingStepIds: z.array(stepIdSchema).max(50),
  executorRound: z.number().int().positive().max(20),
  reviewerRound: z.number().int().nonnegative().max(20),
  lastDecisionRef: supervisedStepDecisionRefV3Schema.optional(),
  sha256: sha256Schema,
  ...entityBaseFields,
} as const;

export const supervisedStepStateV3Schema = z
  .discriminatedUnion("status", [
    z.object({ ...stepStateCommon, status: z.literal("executor_ready") }).strict(),
    z
      .object({
        ...stepStateCommon,
        status: z.literal("executor_running"),
        attemptRef: supervisedAgentAttemptRefV3Schema.extend({ role: z.literal("executor") }),
      })
      .strict(),
    z
      .object({
        ...stepStateCommon,
        status: z.literal("waiting_candidate_review"),
        candidateRef: supervisedStepCandidateRefV3Schema,
        evidenceRefs: evidenceRefsSchema,
        reviewRequestRef: supervisedStepReviewRequestRefV3Schema.extend({
          reviewKind: z.literal("executor_candidate"),
        }),
      })
      .strict(),
    z
      .object({
        ...stepStateCommon,
        status: z.literal("reviewer_ready"),
        candidateRef: supervisedStepCandidateRefV3Schema,
        evidenceRefs: evidenceRefsSchema,
      })
      .strict(),
    z
      .object({
        ...stepStateCommon,
        status: z.literal("reviewer_running"),
        candidateRef: supervisedStepCandidateRefV3Schema,
        evidenceRefs: evidenceRefsSchema,
        attemptRef: supervisedAgentAttemptRefV3Schema.extend({ role: z.literal("reviewer") }),
      })
      .strict(),
    z
      .object({
        ...stepStateCommon,
        status: z.literal("waiting_verdict_review"),
        candidateRef: supervisedStepCandidateRefV3Schema,
        evidenceRefs: evidenceRefsSchema,
        verdictRef: supervisedPlannerVerdictRefV3Schema,
        reviewRequestRef: supervisedStepReviewRequestRefV3Schema.extend({
          reviewKind: z.literal("reviewer_verdict"),
        }),
      })
      .strict(),
    z
      .object({
        ...stepStateCommon,
        status: z.literal("step_passed"),
        candidateRef: supervisedStepCandidateRefV3Schema,
        evidenceRefs: evidenceRefsSchema,
        verdictRef: supervisedPlannerVerdictRefV3Schema.extend({ kind: z.literal("pass") }),
        acceptanceDecisionRef: supervisedStepDecisionRefV3Schema,
      })
      .strict(),
    z
      .object({
        ...stepStateCommon,
        status: z.literal("replan_required"),
        candidateRef: supervisedStepCandidateRefV3Schema,
        verdictRef: supervisedPlannerVerdictRefV3Schema.extend({
          kind: z.literal("replan_remaining"),
        }),
        acceptanceDecisionRef: supervisedStepDecisionRefV3Schema,
      })
      .strict(),
    z
      .object({
        ...stepStateCommon,
        status: z.literal("blocked"),
        blockerDecisionRef: supervisedStepDecisionRefV3Schema,
        candidateRef: supervisedStepCandidateRefV3Schema.optional(),
        verdictRef: supervisedPlannerVerdictRefV3Schema.optional(),
      })
      .strict(),
    z
      .object({
        ...stepStateCommon,
        status: z.literal("failed"),
        failure: z
          .object({
            role: supervisedAgentRoleV3Schema,
            attemptRef: supervisedAgentAttemptRefV3Schema,
            errorCode: stableErrorCodeSchema,
            summary: z.string().trim().min(1).max(1_000),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        ...stepStateCommon,
        status: z.literal("outcome_unknown"),
        attemptRef: supervisedAgentAttemptRefV3Schema,
        outcomeObservationRef: supervisedAgentOutcomeObservationRefV3Schema,
        reviewRequestRef: supervisedStepReviewRequestRefV3Schema.extend({
          reviewKind: z.literal("outcome_unknown"),
        }),
      })
      .strict(),
  ])
  .superRefine((state, ctx) => {
    const initial = state.previousStateRef === undefined;
    if (
      initial !==
      (state.status === "executor_ready" &&
        state.revision === 1 &&
        state.stepIdentity.stepRevision === 1 &&
        state.executorRound === 1 &&
        state.reviewerRound === 0 &&
        state.lastDecisionRef === undefined)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["previousStateRef"],
        message: "监督Step初态必须是唯一executor_ready@1，后续状态必须绑定前态",
      });
    }
    if (
      state.executorRound !== state.stepIdentity.stepRevision ||
      state.executorRound > state.limits.maxExecutorRoundsPerStep ||
      state.reviewerRound > state.limits.maxReviewerRoundsPerStep ||
      state.stepIdentity.planningEpochRef.epochNumber > state.limits.maxPlanRevisions
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["limits"],
        message: "监督Step轮次与Planning Epoch上限不一致",
      });
    }
    const beforeReviewer =
      new Set(["executor_ready", "executor_running", "waiting_candidate_review"]).has(
        state.status,
      ) ||
      (state.status === "blocked" && state.verdictRef === undefined) ||
      (state.status === "failed" && state.failure.role === "executor") ||
      (state.status === "outcome_unknown" && state.attemptRef.role === "executor");
    if (
      (beforeReviewer && state.reviewerRound !== 0) ||
      (!beforeReviewer && state.reviewerRound < 1)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["reviewerRound"],
        message: "Reviewer轮次与Step状态不一致",
      });
    }
    if (new Set(state.dependencyStepIds).size !== state.dependencyStepIds.length) {
      ctx.addIssue({
        code: "custom",
        path: ["dependencyStepIds"],
        message: "依赖Step不能重复",
      });
    }
    if (new Set(state.remainingStepIds).size !== state.remainingStepIds.length) {
      ctx.addIssue({
        code: "custom",
        path: ["remainingStepIds"],
        message: "剩余Step不能重复",
      });
    }
  });

export const supervisedAgentOutcomeObservationV3Schema = z
  .object({
    schemaVersion: z.literal("supervised-agent-outcome-observation.v3"),
    observationId: supervisedAgentObservationIdSchema,
    stepIdentity: supervisedStepIdentityV3Schema,
    attemptRef: supervisedAgentAttemptRefV3Schema,
    kind: z.literal("outcome_unknown"),
    errorCode: stableErrorCodeSchema,
    summary: z.string().trim().min(1).max(1_000),
    operationSummary: z
      .object({
        journalIntegrityVersion: z.literal("full-operation.v3"),
        status: z.enum(["running", "failed", "outcome_unknown", "unreachable"]),
        lastEventSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
        observedAt: isoDateTimeSchema,
      })
      .strict(),
    sha256: sha256Schema,
    ...entityBaseFields,
  })
  .strict();

const executionResultStepSchema = z
  .object({
    stepIdentity: supervisedStepIdentityV3Schema,
    stateRef: supervisedStepStateVersionRefV3Schema,
    candidateRef: supervisedStepCandidateRefV3Schema,
    passVerdictRef: supervisedPlannerVerdictRefV3Schema.extend({ kind: z.literal("pass") }),
    acceptanceDecisionRef: supervisedStepDecisionRefV3Schema,
    evidenceRefs: evidenceRefsSchema,
    carryForwardRef: supervisedCarryForwardRefV3Schema.optional(),
    sha256: sha256Schema,
  })
  .strict();

export const supervisedExecutionResultV3Schema = z
  .object({
    schemaVersion: z.literal("supervised-execution-result.v3"),
    supervisedExecutionResultId: supervisedExecutionResultIdSchema,
    productRunId: productRunIdSchema,
    terminalPlanningEpochRef: supervisedPlanningEpochRefV3Schema,
    planningEpochRefs: z.array(supervisedPlanningEpochRefV3Schema).min(1).max(20),
    orderedStepResults: z.array(executionResultStepSchema).min(1).max(50),
    finalOutput: z
      .object({ format: z.literal("markdown"), text: z.string().trim().min(1).max(200_000) })
      .strict(),
    sha256: sha256Schema,
    ...entityBaseFields,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.planningEpochRefs.some((ref, index) => ref.epochNumber !== index + 1) ||
      new Set(value.planningEpochRefs.map((ref) => ref.planningEpochId)).size !==
        value.planningEpochRefs.length
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["planningEpochRefs"],
        message: "最终结果的Planning Epoch必须连续且不能重复",
      });
    }
    if (
      new Set(value.orderedStepResults.map((result) => result.stepIdentity.stepId)).size !==
      value.orderedStepResults.length
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["orderedStepResults"],
        message: "最终结果不能重复包含同一Step",
      });
    }
  });

export type SupervisedAgentRoleV3 = z.infer<typeof supervisedAgentRoleV3Schema>;
export type SupervisedStepIdentityV3 = z.infer<typeof supervisedStepIdentityV3Schema>;
export type SupervisedCapabilityManifestV3 = z.infer<typeof supervisedCapabilityManifestV3Schema>;
export type SupervisedPlanningEpochV3 = z.infer<typeof supervisedPlanningEpochV3Schema>;
export type SupervisedCarryForwardV3 = z.infer<typeof supervisedCarryForwardV3Schema>;
export type SupervisedAgentAttemptV3 = z.infer<typeof supervisedAgentAttemptV3Schema>;
export type SupervisedStepEvidenceV3 = z.infer<typeof supervisedStepEvidenceV3Schema>;
export type SupervisedStepCandidateV3 = z.infer<typeof supervisedStepCandidateV3Schema>;
export type SupervisedPlannerVerdictV3 = z.infer<typeof supervisedPlannerVerdictV3Schema>;
export type SupervisedStepReviewRequestV3 = z.infer<typeof supervisedStepReviewRequestV3Schema>;
export type SupervisedStepHumanDecisionV3 = z.infer<typeof supervisedStepHumanDecisionV3Schema>;
export type SupervisedStepStateV3 = z.infer<typeof supervisedStepStateV3Schema>;
export type SupervisedAgentOutcomeObservationV3 = z.infer<
  typeof supervisedAgentOutcomeObservationV3Schema
>;
export type SupervisedExecutionResultV3 = z.infer<typeof supervisedExecutionResultV3Schema>;
