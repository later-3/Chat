import { hashCanonical } from "./canonical-hash.js";

export interface ProjectBootstrapProposalShape {
  readonly name: string;
  readonly objective: string;
  readonly planeWorkspaceSlug: string;
  readonly planeProjectIdentifier: string;
  readonly workspaceRootId: string;
  readonly directoryName: string;
  readonly initializerProfile: "blank" | "ai_learning";
  readonly initialModules: readonly string[];
}

export interface ProjectBootstrapPreviewShape {
  readonly planeProjectLabel: string;
  readonly workspaceLabel: string;
  readonly gitAction: "initialize";
  readonly initialModules: readonly string[];
}

export type ProjectBootstrapCandidateStatusShape =
  | "prepared"
  | "confirmed"
  | "rejected"
  | "executing"
  | "ready"
  | "needs_attention"
  | "outcome_unknown";

export interface ProjectBootstrapCandidateShape {
  readonly projectBootstrapCandidateId: string;
  readonly ownerPrincipalId: string;
  readonly sourceProductSessionId: string;
  readonly sourceProductRunId: string;
  readonly proposal: ProjectBootstrapProposalShape;
  readonly preview: ProjectBootstrapPreviewShape;
  readonly status: ProjectBootstrapCandidateStatusShape;
  readonly sha256: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProjectBootstrapDecisionShape {
  readonly projectBootstrapCandidateId: string;
  readonly candidateRevision: number;
  readonly candidateSha256: string;
  readonly decidedByPrincipalId: string;
}

export function computeProjectBootstrapCandidateSha256(input: {
  readonly ownerPrincipalId: string;
  readonly sourceProductSessionId: string;
  readonly sourceProductRunId: string;
  readonly proposal: ProjectBootstrapProposalShape;
  readonly preview: ProjectBootstrapPreviewShape;
}): string {
  return hashCanonical("project-bootstrap-candidate.v1", {
    ownerPrincipalId: input.ownerPrincipalId,
    sourceProductSessionId: input.sourceProductSessionId,
    sourceProductRunId: input.sourceProductRunId,
    proposal: input.proposal,
    preview: input.preview,
  });
}

const candidateTransitions: Readonly<
  Record<ProjectBootstrapCandidateStatusShape, readonly ProjectBootstrapCandidateStatusShape[]>
> = {
  prepared: ["confirmed", "rejected"],
  confirmed: ["executing"],
  rejected: [],
  executing: ["ready", "needs_attention", "outcome_unknown"],
  ready: [],
  needs_attention: ["executing"],
  outcome_unknown: ["executing"],
};

export function assertProjectBootstrapCandidateTransition(input: {
  readonly current: ProjectBootstrapCandidateShape;
  readonly next: ProjectBootstrapCandidateShape;
}): void {
  if (!candidateTransitions[input.current.status].includes(input.next.status)) {
    throw new Error(
      `非法Project Bootstrap Candidate转换:${input.current.status}->${input.next.status}`,
    );
  }
  if (
    input.next.projectBootstrapCandidateId !== input.current.projectBootstrapCandidateId ||
    input.next.ownerPrincipalId !== input.current.ownerPrincipalId ||
    input.next.sourceProductSessionId !== input.current.sourceProductSessionId ||
    input.next.sourceProductRunId !== input.current.sourceProductRunId ||
    input.next.sha256 !== input.current.sha256 ||
    input.next.createdAt !== input.current.createdAt ||
    input.next.revision !== input.current.revision + 1
  ) {
    throw new Error("Project Bootstrap Candidate不可变字段或revision被破坏");
  }
  const expected = computeProjectBootstrapCandidateSha256(input.next);
  if (expected !== input.next.sha256) {
    throw new Error("Project Bootstrap Candidate Hash不匹配");
  }
}

export function assertProjectBootstrapDecisionBinding(input: {
  readonly candidate: ProjectBootstrapCandidateShape;
  readonly decision: ProjectBootstrapDecisionShape;
}): void {
  if (
    input.candidate.status !== "prepared" ||
    input.decision.projectBootstrapCandidateId !== input.candidate.projectBootstrapCandidateId ||
    input.decision.candidateRevision !== input.candidate.revision ||
    input.decision.candidateSha256 !== input.candidate.sha256 ||
    input.decision.decidedByPrincipalId !== input.candidate.ownerPrincipalId
  ) {
    throw new Error("Project Bootstrap Decision未绑定当前可审核Candidate");
  }
}

export function deriveProjectBootstrapOutcome(input: {
  readonly workspace: "completed" | "failed" | "outcome_unknown";
  readonly plane: "completed" | "failed" | "needs_attention" | "outcome_unknown";
}): "ready" | "failed" | "needs_attention" | "outcome_unknown" {
  if (input.workspace === "completed" && input.plane === "completed") return "ready";
  if (input.workspace === "outcome_unknown" || input.plane === "outcome_unknown") {
    return "outcome_unknown";
  }
  if (
    input.workspace === "completed" ||
    input.plane === "completed" ||
    input.plane === "needs_attention"
  ) {
    return "needs_attention";
  }
  return "failed";
}
