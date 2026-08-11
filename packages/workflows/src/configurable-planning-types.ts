import { z } from "zod";
import type { ConfigurablePlanningNodeTransition } from "./configurable-planning-steps.js";
import type { ExecutionCheckpointRefs } from "./workflow-execution-steps.js";

export const configurablePlanningWorkflowInputSchema = z
  .object({
    schemaVersion: z.literal("configurable-planning-workflow-input.v1"),
    productRunId: z.string().regex(/^run_[A-Za-z0-9]+$/),
    attemptId: z.string().regex(/^att_[A-Za-z0-9]+$/),
    workflowRunSpecId: z.string().regex(/^wrs_[A-Za-z0-9]+$/),
  })
  .strict();

export type ConfigurablePlanningWorkflowInput = z.infer<
  typeof configurablePlanningWorkflowInputSchema
>;

export interface ConfigurablePlanningWorkflowResult {
  readonly outcome: "product_committed" | "cancelled" | "failed" | "outcome_unknown";
  readonly productRunId: string;
  readonly workflowRunSpecId: string;
  readonly errorCode?: string;
}

export type PlanningNodeIdentity = Pick<
  ConfigurablePlanningNodeTransition,
  "productRunId" | "workflowRunSpecId" | "definitionNodeId" | "executionPath" | "attemptNumber"
>;

interface PlanReviewState {
  readonly planId: string;
  readonly planRevision: number;
  readonly planSha256: string;
  readonly approvalRequestId: string;
  readonly approvalExpiresAt: string;
}

interface ValidationState {
  readonly outcome: "pass" | "fail";
  readonly validationResultId: string;
}

/** Workflow checkpoint只保存产品身份与Hash引用；业务正文始终留在单个Step内部。 */
export interface PlanningInterpreterState {
  contextPackageRef?: {
    contextPackageId: string;
    revision: 1;
    sha256: string;
  };
  planningMemorySelectionRef?: {
    planningMemorySelectionId: string;
    revision: 1;
    sha256: string;
  };
  planningProjectContextRef?: {
    planningProjectContextId: string;
    revision: 1;
    sha256: string;
  };
  ruleSelectionRef?: {
    ruleSelectionId: string;
    revision: 1;
    sha256: string;
  };
  planRevision: number;
  currentReview?: PlanReviewState;
  currentDecision?: {
    readonly decisionId: string;
    readonly kind: "request_revision" | "approve" | "reject";
  };
  execution?: ExecutionCheckpointRefs;
  validation?: ValidationState;
  productCommitted: boolean;
  cancelled: boolean;
  failure?: { readonly code: string; readonly summary: string };
}
