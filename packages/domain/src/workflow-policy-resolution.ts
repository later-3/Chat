import { hashCanonical } from "./canonical-hash.js";

export const NOTE_LOW_RISK_AUTO_POLICY_VERSION = "note-low-risk-auto.v1";
export const NOTE_LOW_RISK_AUTO_POLICY_RESOURCE_ID = "rul_systemnotelowriskv1";
export const NOTE_LOW_RISK_AUTO_POLICY_REVISION = 1;
export const NOTE_LOW_RISK_AUTO_POLICY_LIMITS = Object.freeze({
  maxContentCharacters: 20_000,
  maxTags: 10,
  maxSourceRefs: 5,
});

export const NOTE_LOW_RISK_AUTO_POLICY_SHA256 = hashCanonical("workflow-policy-definition.v1", {
  policyVersion: NOTE_LOW_RISK_AUTO_POLICY_VERSION,
  purpose: "confirm_pure_note_candidate",
  limits: NOTE_LOW_RISK_AUTO_POLICY_LIMITS,
  effects: ["create_note_product_fact"],
  forbiddenEffects: ["external_write", "project_mutation", "human_decision_impersonation"],
});

export type NoteLowRiskPolicyOutcome =
  | { readonly outcome: "allowed"; readonly reasonCode: "note_candidate_within_low_risk_bounds" }
  | { readonly outcome: "denied"; readonly reasonCode: "note_candidate_exceeds_auto_bounds" };

export function evaluateNoteLowRiskAutoPolicy(candidate: {
  readonly proposed: {
    readonly contentMarkdown: string;
    readonly tags: readonly unknown[];
  };
  readonly sourceRefs: readonly unknown[];
}): NoteLowRiskPolicyOutcome {
  return candidate.proposed.contentMarkdown.length <=
    NOTE_LOW_RISK_AUTO_POLICY_LIMITS.maxContentCharacters &&
    candidate.proposed.tags.length <= NOTE_LOW_RISK_AUTO_POLICY_LIMITS.maxTags &&
    candidate.sourceRefs.length <= NOTE_LOW_RISK_AUTO_POLICY_LIMITS.maxSourceRefs
    ? { outcome: "allowed", reasonCode: "note_candidate_within_low_risk_bounds" }
    : { outcome: "denied", reasonCode: "note_candidate_exceeds_auto_bounds" };
}

export interface WorkflowPolicyResolutionShape {
  readonly productRunId: string;
  readonly workflowRunSpecId: string;
  readonly workflowRunSpecSha256: string;
  readonly definitionNodeId: string;
  readonly noteCandidateId: string;
  readonly candidateRevision: number;
  readonly candidateSha256: string;
  readonly reviewMode: "auto_continue_if_policy_allows";
  readonly policyVersion: string;
  readonly policySha256: string;
  readonly outcome: "allowed" | "denied";
  readonly reasonCode:
    "note_candidate_within_low_risk_bounds" | "note_candidate_exceeds_auto_bounds";
  readonly sha256: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function computeWorkflowPolicyResolutionSha256(
  resolution: Omit<WorkflowPolicyResolutionShape, "sha256" | "createdAt" | "updatedAt">,
): string {
  return hashCanonical("workflow-policy-resolution.v1", {
    productRunId: resolution.productRunId,
    workflowRunSpecId: resolution.workflowRunSpecId,
    workflowRunSpecSha256: resolution.workflowRunSpecSha256,
    definitionNodeId: resolution.definitionNodeId,
    noteCandidateId: resolution.noteCandidateId,
    candidateRevision: resolution.candidateRevision,
    candidateSha256: resolution.candidateSha256,
    reviewMode: resolution.reviewMode,
    policyVersion: resolution.policyVersion,
    policySha256: resolution.policySha256,
    outcome: resolution.outcome,
    reasonCode: resolution.reasonCode,
  });
}

export function assertWorkflowPolicyResolutionIntegrity(
  resolution: WorkflowPolicyResolutionShape,
): void {
  if (
    resolution.reviewMode !== "auto_continue_if_policy_allows" ||
    resolution.policyVersion !== NOTE_LOW_RISK_AUTO_POLICY_VERSION ||
    resolution.policySha256 !== NOTE_LOW_RISK_AUTO_POLICY_SHA256 ||
    resolution.createdAt !== resolution.updatedAt ||
    computeWorkflowPolicyResolutionSha256(resolution) !== resolution.sha256
  ) {
    throw new Error("workflow_policy_resolution.integrity_invalid");
  }
  if (
    (resolution.outcome === "allowed" &&
      resolution.reasonCode !== "note_candidate_within_low_risk_bounds") ||
    (resolution.outcome === "denied" &&
      resolution.reasonCode !== "note_candidate_exceeds_auto_bounds")
  ) {
    throw new Error("workflow_policy_resolution.reason_invalid");
  }
}
