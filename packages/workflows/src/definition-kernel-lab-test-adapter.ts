import { getRun, resumeHook, start, type Run } from "workflow/api";
import type {
  DefinitionKernelLabWorkflowInput,
  DefinitionKernelLabWorkflowResult,
} from "./definition-kernel-lab-workflow.js";

/** 仅供S3真实Local World黑盒门使用；产品Runtime Server没有对应公开/私有路由。 */
export function startDefinitionKernelLabRun(
  workflowId: string,
  input: DefinitionKernelLabWorkflowInput,
): Promise<Run<DefinitionKernelLabWorkflowResult>> {
  return start({ workflowId }, [input]);
}

export async function resumeDefinitionKernelLabReview(
  hookToken: string,
  decisionRef: string,
): Promise<void> {
  await resumeHook(hookToken, { decisionRef });
}

export function getDefinitionKernelLabRun(
  workflowRunId: string,
): Run<DefinitionKernelLabWorkflowResult> {
  return getRun<DefinitionKernelLabWorkflowResult>(workflowRunId);
}
