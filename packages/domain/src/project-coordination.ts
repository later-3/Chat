import { hashCanonical } from "./canonical-hash.js";
import { ProjectDomainError } from "./project.js";

export function computeProjectPracticeRevisionSha256(input: {
  readonly projectId: string;
  readonly practiceKey: string;
  readonly version: number;
  readonly title: string;
  readonly applicableWorkKinds: readonly string[];
  readonly artifactEvidenceId: string;
  readonly adoptionDecisionId: string;
  readonly supersedesRevisionId?: string | undefined;
}): string {
  return hashCanonical("project-practice-revision.v1", input);
}

export function computeProjectContextMapSha256(input: {
  readonly projectId: string;
  readonly methodSnapshotId: string;
  readonly selectors: readonly unknown[];
  readonly historyViews: readonly string[];
  readonly authorityPolicyVersion: string;
  readonly evidencePolicyVersion: string;
}): string {
  return hashCanonical("project-context-map.v1", input);
}

export function assertProjectWorkClaimAcquisition(input: {
  readonly workKind: "generic" | "content_delivery" | "workflow_improvement";
  readonly workStatus: string;
  readonly participantKind: "human" | "agent" | "automation" | "external";
  readonly participantStatus: "active" | "inactive";
  readonly activeClaimExists: boolean;
  readonly acquiredAt: string;
  readonly leaseExpiresAt: string;
}): void {
  if (input.participantKind !== "agent" || input.participantStatus !== "active") {
    throw new ProjectDomainError(
      "project_work_claim_participant_invalid",
      "Work Claim只能分配给活动Agent Participant",
    );
  }
  if (
    ["done", "cancelled", "published", "dropped", "adopted", "rejected"].includes(input.workStatus)
  ) {
    throw new ProjectDomainError("project_work_claim_terminal", "终态Work不能再被认领");
  }
  if (input.activeClaimExists) {
    throw new ProjectDomainError("project_work_claim_conflict", "Work已经存在活动Claim");
  }
  if (input.leaseExpiresAt <= input.acquiredAt) {
    throw new ProjectDomainError(
      "project_work_claim_lease_invalid",
      "Claim leaseExpiresAt必须晚于acquiredAt",
    );
  }
}

export function assertProjectWorkHandoff(input: {
  readonly claimStatus: string;
  readonly claimParticipantId: string;
  readonly fromParticipantId: string;
  readonly remaining: readonly string[];
  readonly nextStep: string;
}): void {
  if (input.claimStatus !== "active" || input.claimParticipantId !== input.fromParticipantId) {
    throw new ProjectDomainError(
      "project_work_handoff_claim_invalid",
      "Handoff必须来自当前活动Claim的Agent",
    );
  }
  if (input.remaining.length === 0 || input.nextStep.trim().length === 0) {
    throw new ProjectDomainError(
      "project_work_handoff_context_required",
      "Handoff必须记录剩余工作和下一步",
    );
  }
}
