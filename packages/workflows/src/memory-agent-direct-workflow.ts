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
 * 独立Memory Agent纵向：检索Agent调用只读Memory工具并筛选引用 → 同一Direct核心 →
 * 写入Agent产生待审核候选 → Product Commit。真正Memory写副作用只会在用户后续批准候选
 * 后由既有Memory Write Workflow执行。
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
  const [retrieveNode, directNode, writeNode] = runSpec.semanticRoot.elements;
  if (
    retrieveNode?.kind !== "task" ||
    directNode?.kind !== "composite" ||
    writeNode?.kind !== "task"
  ) {
    return fail(input, "memory_agent_direct.sequence_invalid", "Memory Agent节点序列无效");
  }
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
    const retrieval = await executeMemoryRetrievalAgentStep({ identity: retrieveIdentity });
    if (retrieval === "required_unavailable") {
      await recordConfigurablePlanningNodeStep({
        ...retrieveIdentity,
        toStatus: "failed",
        outcomeCode: "required_unavailable",
        publicSummary: "必需Memory检索Agent不可用",
      });
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
      await recordConfigurablePlanningNodeStep({
        ...retrieveIdentity,
        toStatus: "failed",
        outcomeCode: "context_missing",
        publicSummary: "Memory检索Agent未形成冻结Context",
      });
      return fail(input, "memory_agent_direct.context_missing", "检索Agent未形成冻结Context");
    }
    await recordConfigurablePlanningNodeStep({
      ...retrieveIdentity,
      toStatus: "succeeded",
      outcomeCode: retrieval,
      publicSummary:
        retrieval === "success"
          ? "Memory检索Agent已筛选并冻结相关上下文"
          : retrieval === "empty"
            ? "Memory检索Agent未找到可采用的上下文"
            : "可选Memory检索Agent不可用，继续执行本轮任务",
    });
  } catch (error) {
    const errorCode = failureCode(error, "memory_agent_direct.retrieval_failed");
    await recordConfigurablePlanningNodeStep({
      ...retrieveIdentity,
      toStatus: "failed",
      outcomeCode: errorCode,
      publicSummary: "Memory检索Agent未能安全完成",
    });
    return fail(input, errorCode, "Memory检索Agent未能安全完成");
  }

  const directResult = await runDirectAgentWorkflowCore(input);
  if (directResult.outcome !== "candidate_ready") return directResult;

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
