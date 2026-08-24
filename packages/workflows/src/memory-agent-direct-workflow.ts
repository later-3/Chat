import {
  commitDirectAgentCandidate,
  runDirectAgentWorkflowCore,
  type DirectAgentWorkflowResult,
} from "./direct-agent-workflow.js";
import {
  directAgentWorkflowInputSchema,
  type DirectAgentWorkflowInput,
} from "./direct-agent-workflow-input.js";
import {
  loadMemoryAgentDirectRunSpecStep,
  recordConfigurablePlanningNodeStep,
} from "./configurable-planning-steps.js";
import {
  executeMemoryRetrievalAgentStep,
  executeMemoryWriteAgentStep,
} from "./memory-agent-workflow-steps.js";
import { freezeWorkflowMemoryContextStep } from "./workflow-memory-steps.js";
import { commitRunFailureStep } from "./workflow-result-steps.js";

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
 * Memory Agent family支持三种固定组合：完整查询+回答+整理、只查询+回答、回答+只整理。
 * 真正Memory写副作用始终只会在用户后续批准候选后由既有Memory Write Workflow执行。
 */
export async function memoryAgentDirectWorkflow(
  rawInput: DirectAgentWorkflowInput,
): Promise<DirectAgentWorkflowResult> {
  "use workflow";
  const input = directAgentWorkflowInputSchema.parse(rawInput);
  let runSpec;
  try {
    runSpec = await loadMemoryAgentDirectRunSpecStep({
      productRunId: input.productRunId,
      workflowRunSpecId: input.workflowRunSpecId,
    });
  } catch (error) {
    return fail(
      input,
      failureCode(error, "memory_agent_direct.run_spec_invalid"),
      "Memory Agent Direct冻结运行定义无效",
    );
  }
  const retrieveNode = runSpec.semanticRoot.elements.find(
    (node) => "nodeType" in node && node.nodeType === "agent.memory_retrieve",
  );
  const directNode = runSpec.semanticRoot.elements.find(
    (node) => "nodeType" in node && node.nodeType === "agent.direct",
  );
  const writeNode = runSpec.semanticRoot.elements.find(
    (node) => "nodeType" in node && node.nodeType === "agent.memory_write",
  );
  if (
    directNode?.kind !== "composite" ||
    !("nodeType" in directNode) ||
    (retrieveNode !== undefined &&
      (!("nodeType" in retrieveNode) || retrieveNode.kind !== "task")) ||
    (writeNode !== undefined && (!("nodeType" in writeNode) || writeNode.kind !== "task"))
  ) {
    return fail(input, "memory_agent_direct.sequence_invalid", "Memory Agent节点序列无效");
  }
  if (retrieveNode !== undefined) {
    const retrieveIdentity = {
      workflowAttemptId: input.workflowAttemptId,
      productRunId: input.productRunId,
      workflowRunSpecId: input.workflowRunSpecId,
      definitionNodeId: retrieveNode.definitionNodeId,
      executionPath: [],
      attemptNumber: 1,
    } as const;
    try {
      await recordConfigurablePlanningNodeStep({
        ...retrieveIdentity,
        toStatus: "running",
        publicSummary: "Memory检索Agent正在调用只读工具并筛选相关结果",
      });
      // persistWorkflowMemoryQueryResult会把Query、Snapshots与检索节点终态原子提交；
      // Runner只拥有开始信号，不能随后用另一份摘要重复写同一终态。
      const retrieval = await executeMemoryRetrievalAgentStep({ identity: retrieveIdentity });
      if (retrieval === "required_unavailable") {
        return fail(
          input,
          "memory_agent_direct.retrieval_required_unavailable",
          "必需Memory检索Agent不可用",
        );
      }
      const frozen = await freezeWorkflowMemoryContextStep({
        productRunId: input.productRunId,
        workflowRunSpecId: input.workflowRunSpecId,
        workflowAttemptId: input.workflowAttemptId,
      });
      if (frozen.status !== "ready") {
        return fail(input, "memory_agent_direct.context_missing", "检索Agent未形成冻结Context");
      }
    } catch (error) {
      const errorCode = failureCode(error, "memory_agent_direct.retrieval_failed");
      return fail(input, errorCode, "Memory检索Agent未能安全完成");
    }
  }

  const directResult = await runDirectAgentWorkflowCore(input);
  if (directResult.outcome !== "candidate_ready") return directResult;
  if (writeNode === undefined) return commitDirectAgentCandidate(input, directResult);

  const writeIdentity = {
    productRunId: input.productRunId,
    workflowAttemptId: input.workflowAttemptId,
    workflowRunSpecId: input.workflowRunSpecId,
    definitionNodeId: writeNode.definitionNodeId,
    executionPath: [],
    attemptNumber: 1,
  } as const;
  try {
    await recordConfigurablePlanningNodeStep({
      ...writeIdentity,
      toStatus: "running",
      publicSummary: "Memory写入Agent正在整理待审核候选",
    });
    const writeResult = await executeMemoryWriteAgentStep({
      productRunId: input.productRunId,
      workflowAttemptId: input.workflowAttemptId,
      workflowRunSpecId: input.workflowRunSpecId,
      directAgentCandidateId: directResult.directAgentCandidateId,
      candidateSha256: directResult.candidateSha256,
    });
    await recordConfigurablePlanningNodeStep({
      ...writeIdentity,
      toStatus: writeResult.outcome === "required_unavailable" ? "failed" : "succeeded",
      outcomeCode: writeResult.outcome,
      publicSummary:
        writeResult.outcome === "candidate_ready"
          ? "Memory写入候选已生成，等待用户审核"
          : writeResult.outcome === "nothing_useful"
            ? "本轮没有建议写入的长期记忆"
            : writeResult.outcome === "optional_unavailable"
              ? "可选Memory写入Agent不可用，继续提交本轮结果"
              : "必需Memory写入Agent不可用，已停止提交",
    });
    if (writeResult.outcome === "required_unavailable") {
      return fail(input, writeResult.errorCode, "必需Memory写入Agent不可用");
    }
  } catch (error) {
    const errorCode = failureCode(error, "memory_agent_direct.write_candidate_failed");
    await recordConfigurablePlanningNodeStep({
      ...writeIdentity,
      toStatus: "failed",
      outcomeCode: errorCode,
      publicSummary: "Memory写入Agent未能安全形成候选",
    });
    return fail(input, errorCode, "Memory写入Agent未能安全形成候选");
  }
  return commitDirectAgentCandidate(input, directResult);
}
