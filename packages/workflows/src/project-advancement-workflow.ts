import { defineHook } from "workflow";
import {
  projectAdvancementHookPayloadSchema,
  type ProjectAdvancementWorkflowInput,
} from "@chat/contracts";
import { prepareProjectAdvancementCandidateStep } from "./project-advancement-workflow-steps.js";

const projectAdvancementDecisionHook = defineHook({ schema: projectAdvancementHookPayloadSchema });

/**
 * 推进Workflow拥有真实模型节点、候选暂停与恢复；Product事实仍由API/Application事务提交。
 * Hook Token由产品Candidate ID确定性派生，只存在Runtime Binding和Workflow内部。
 */
export async function projectAdvancementWorkflow(input: ProjectAdvancementWorkflowInput): Promise<{
  readonly outcome: "product_decided";
  readonly projectCandidateId: string;
}> {
  "use workflow";

  const prepared = await prepareProjectAdvancementCandidateStep({
    projectCandidateId: input.projectCandidateId,
    expectedRevision: input.expectedCandidateRevision,
  });
  if (prepared.candidate.status !== "under_review") {
    throw new Error("Project Advancement候选未进入审核态");
  }
  using decisionHook = projectAdvancementDecisionHook.create({
    token: `pah-${input.projectCandidateId}`,
  });
  const conflict = await decisionHook.getConflict();
  if (conflict !== null) throw new Error("Project Advancement Hook Token冲突");
  const decision = await decisionHook;
  if (decision.candidateRevision <= prepared.candidate.revision) {
    throw new Error("Project Advancement恢复未携带更新后的Candidate revision");
  }
  return { outcome: "product_decided", projectCandidateId: input.projectCandidateId };
}
