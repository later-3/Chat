import { defineHook } from "workflow";
import { projectIntakeHookPayloadSchema, type ProjectIntakeWorkflowInput } from "@chat/contracts";
import { prepareProjectCandidateStep } from "./project-intake-workflow-steps.js";

const projectIntakeDecisionHook = defineHook({ schema: projectIntakeHookPayloadSchema });

/**
 * 建项是独立耐久用户结果：理解与观察完成后暂停，Project事实先由API事务提交，
 * Workflow再被恢复。Hook Token只在Runtime内确定性派生，浏览器永远不可见。
 */
export async function projectIntakeWorkflow(input: ProjectIntakeWorkflowInput): Promise<{
  readonly outcome: "product_decided";
  readonly projectCandidateId: string;
}> {
  "use workflow";

  const prepared = await prepareProjectCandidateStep({
    projectCandidateId: input.projectCandidateId,
    expectedRevision: input.expectedCandidateRevision,
  });
  if (prepared.candidate.status !== "under_review") {
    throw new Error("Project Intake候选未进入审核态");
  }
  using decisionHook = projectIntakeDecisionHook.create({
    token: `pih-${input.projectCandidateId}`,
  });
  const conflict = await decisionHook.getConflict();
  if (conflict !== null) throw new Error("Project Intake Hook Token冲突");
  const decision = await decisionHook;
  if (decision.candidateRevision <= prepared.candidate.revision) {
    throw new Error("Project Intake恢复未携带更新后的Candidate revision");
  }
  return {
    outcome: "product_decided",
    projectCandidateId: input.projectCandidateId,
  };
}
