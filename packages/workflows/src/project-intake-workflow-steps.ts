import { sha256Hex } from "@chat/domain";
import { getWorkflowRuntimeContext } from "./runtime-context.js";
import { wrapApiError } from "./workflow-step-support.js";

export async function prepareProjectCandidateStep(input: {
  readonly projectCandidateId: string;
  readonly expectedRevision: number;
}) {
  "use step";
  try {
    return await getWorkflowRuntimeContext().api.prepareProjectCandidate({
      commandId: `cmd_${sha256Hex(`prepare-project:${input.projectCandidateId}:${String(input.expectedRevision)}`).slice(0, 32)}`,
      projectCandidateId: input.projectCandidateId,
      expectedRevision: input.expectedRevision,
    });
  } catch (error) {
    wrapApiError(error);
  }
}
