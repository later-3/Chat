import { workflowMemoryWriteNodeConfigV2Schema } from "@chat/contracts";
import {
  commitDirectAgentCandidate,
  runDirectAgentWorkflowCore,
  type DirectAgentWorkflowResult,
} from "./direct-agent-workflow.js";
import {
  directAgentWorkflowInputSchema,
  type DirectAgentWorkflowInput,
} from "./direct-agent-workflow-input.js";
import { loadMemoryDirectRunSpecStep } from "./configurable-planning-steps.js";
import {
  executeWorkflowMemoryQuery,
  executeWorkflowMemoryWrite,
} from "./configurable-planning-resource-executors.js";
import { freezeWorkflowMemoryContextStep } from "./workflow-memory-steps.js";
import { commitRunFailureStep, commitRunOutcomeUnknownStep } from "./workflow-result-steps.js";

const STABLE_ERROR_CODE = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/u;

function failureCode(error: unknown, fallback: string): string {
  return error instanceof Error && STABLE_ERROR_CODE.test(error.message) ? error.message : fallback;
}

async function fail(
  input: DirectAgentWorkflowInput,
  errorCode: string,
  summary: string,
): Promise<DirectAgentWorkflowResult> {
  await commitRunFailureStep({
    productRunId: input.productRunId,
    attemptId: input.workflowAttemptId,
    errorCode,
    summary,
  });
  return { outcome: "failed", productRunId: input.productRunId, errorCode };
}

/**
 * 独立Memory Direct纵向：冻结Query事实与Context → 复用同一Direct Agent核心循环 →
 * 在正式采用候选前写回来源消息。现有Direct Workflow不会进入本函数。
 */
export async function memoryDirectAgentWorkflow(
  rawInput: DirectAgentWorkflowInput,
): Promise<DirectAgentWorkflowResult> {
  "use workflow";
  const input = directAgentWorkflowInputSchema.parse(rawInput);
  let runSpec;
  try {
    runSpec = await loadMemoryDirectRunSpecStep({
      productRunId: input.productRunId,
      workflowRunSpecId: input.workflowRunSpecId,
    });
  } catch (error) {
    return fail(
      input,
      failureCode(error, "memory_direct.run_spec_invalid"),
      "Memory Direct冻结运行定义无效",
    );
  }
  const [queryNode, directNode, writeNode] = runSpec.semanticRoot.elements;
  if (
    queryNode?.kind !== "task" ||
    directNode?.kind !== "composite" ||
    writeNode?.kind !== "task"
  ) {
    return fail(input, "memory_direct.sequence_invalid", "Memory Direct节点序列无效");
  }
  const executionInput = {
    schemaVersion: "configurable-planning-workflow-input.v1" as const,
    productRunId: input.productRunId,
    attemptId: input.workflowAttemptId,
    workflowRunSpecId: input.workflowRunSpecId,
  };
  const queryIdentity = {
    productRunId: input.productRunId,
    workflowRunSpecId: input.workflowRunSpecId,
    definitionNodeId: queryNode.definitionNodeId,
    executionPath: [],
    attemptNumber: 1,
  } as const;
  let queryOutcome;
  try {
    queryOutcome = await executeWorkflowMemoryQuery(executionInput, queryIdentity);
  } catch (error) {
    return fail(
      input,
      failureCode(error, "memory_direct.query_start_failed"),
      "Memory查询未能安全开始",
    );
  }
  if (queryOutcome === "required_unavailable") {
    return fail(input, "memory_direct.query_required_unavailable", "必需Memory查询不可用");
  }
  try {
    const frozen = await freezeWorkflowMemoryContextStep({
      productRunId: input.productRunId,
      workflowRunSpecId: input.workflowRunSpecId,
      workflowAttemptId: input.workflowAttemptId,
    });
    if (frozen.status !== "ready") {
      return fail(input, "memory_direct.context_missing", "Memory查询未形成冻结Context");
    }
  } catch (error) {
    return fail(
      input,
      failureCode(error, "memory_direct.context_freeze_failed"),
      "Memory Context冻结失败",
    );
  }

  const directResult = await runDirectAgentWorkflowCore(input);
  if (directResult.outcome !== "candidate_ready") return directResult;

  const writeResolution = runSpec.nodeResolutions.find(
    (node) => node.definitionNodeId === writeNode.definitionNodeId,
  );
  if (writeNode.schemaVersion !== 2 || writeResolution?.schemaVersion !== 2) {
    return fail(input, "memory_direct.write_schema_invalid", "Memory写回节点版本无效");
  }
  const writeConfig = workflowMemoryWriteNodeConfigV2Schema.safeParse(writeResolution?.config);
  if (!writeConfig.success) {
    return fail(input, "memory_direct.write_config_invalid", "Memory写回冻结配置无效");
  }
  const writeOutcome = await executeWorkflowMemoryWrite(executionInput, {
    productRunId: input.productRunId,
    workflowRunSpecId: input.workflowRunSpecId,
    definitionNodeId: writeNode.definitionNodeId,
    executionPath: [],
    attemptNumber: 1,
  });
  if (writeConfig.data.required && writeOutcome === "outcome_unknown") {
    await commitRunOutcomeUnknownStep({
      productRunId: input.productRunId,
      attemptId: input.workflowAttemptId,
      errorCode: "memory_direct.write_outcome_unknown",
      summary: "Memory写回结果未知，未自动重复写入或提交候选",
    });
    return {
      outcome: "outcome_unknown",
      productRunId: input.productRunId,
      errorCode: "memory_direct.write_outcome_unknown",
    };
  }
  if (writeConfig.data.required && writeOutcome === "failed") {
    return fail(input, "memory_direct.write_failed", "必需Memory写回失败");
  }
  return commitDirectAgentCandidate(input, directResult);
}
