import { sha256Hex } from "@chat/domain";
import { FatalError } from "workflow";
import { getWorkflowRuntimeContext } from "./runtime-context.js";

export async function prepareProjectAdvancementCandidateStep(input: {
  readonly projectCandidateId: string;
  readonly expectedRevision: number;
}) {
  "use step";
  try {
    return await getWorkflowRuntimeContext().api.prepareProjectAdvancementCandidate({
      commandId: `cmd_${sha256Hex(`prepare-project-advancement:${input.projectCandidateId}:${String(input.expectedRevision)}`).slice(0, 32)}`,
      projectCandidateId: input.projectCandidateId,
      expectedRevision: input.expectedRevision,
    });
  } catch (error) {
    // 同一Candidate Revision禁止Workflow默认重试真实模型付费调用；用户显式重发才产生新调用。
    throw new FatalError(
      error instanceof Error ? error.message : "Project Advancement prepare失败",
    );
  }
}
