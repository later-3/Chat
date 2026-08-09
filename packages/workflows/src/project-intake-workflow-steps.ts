import { sha256Hex } from "@chat/domain";
import { FatalError } from "workflow";
import { getWorkflowRuntimeContext } from "./runtime-context.js";

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
    // Provider调用和Resource Observe发生在产品事务前；网络未知或服务端失败都不能由
    // Workflow默认重试再次付费。用户可从失败Candidate显式重新发起新建项。
    throw new FatalError(error instanceof Error ? error.message : "Project Intake prepare失败");
  }
}
