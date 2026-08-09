import type { WorkflowRunSpec } from "@chat/contracts";
import { recordConfigurablePlanningNodeStep } from "./configurable-planning-steps.js";
import {
  preparePlanningLegacyMemoryContextStep,
  preparePlanningMemoryContextStep,
  preparePlanningProjectContextStep,
  preparePlanningRulesContextStep,
} from "./workflow-planning-steps.js";
import type {
  ConfigurablePlanningWorkflowInput,
  PlanningInterpreterState,
  PlanningNodeIdentity,
} from "./configurable-planning-types.js";

export async function executeMemoryContext(
  input: ConfigurablePlanningWorkflowInput,
  runSpec: WorkflowRunSpec,
  state: PlanningInterpreterState,
  nodeIdentity: PlanningNodeIdentity,
): Promise<"success" | "optional_unavailable" | "required_unavailable"> {
  if (hasIncludedResource(runSpec, nodeIdentity.definitionNodeId, "memory")) {
    let selected;
    try {
      selected = await preparePlanningMemoryContextStep({
        productRunId: input.productRunId,
        attemptId: input.attemptId,
        workflowRunSpecId: input.workflowRunSpecId,
        definitionNodeId: nodeIdentity.definitionNodeId,
        executionPath: nodeIdentity.executionPath,
        attemptNumber: nodeIdentity.attemptNumber,
      });
    } catch {
      state.failure = {
        code: "configurable_planning.memory_selection_unavailable",
        summary: "Memory Selection无法按冻结引用准备",
      };
      return "required_unavailable";
    }
    if (selected.status !== "ready") {
      state.failure = {
        code: "configurable_planning.memory_selection_missing",
        summary: "冻结配置选择了Memory Snapshot，但没有得到权威Selection",
      };
      return "required_unavailable";
    }
    // Application在Selection事务内原子投影context.memory terminal；Runner不双写。
    state.planningMemorySelectionRef = selected.selectionRef;
    return "success";
  }
  const prepared = await preparePlanningLegacyMemoryContextStep({
    productRunId: input.productRunId,
    attemptId: input.attemptId,
  });
  if (prepared.status === "none") {
    await recordConfigurablePlanningNodeStep({
      ...nodeIdentity,
      toStatus: "skipped",
      outcomeCode: "optional_unavailable",
      publicSummary: "本轮未选择Memory上下文",
    });
    return "optional_unavailable";
  }
  await recordConfigurablePlanningNodeStep({
    ...nodeIdentity,
    toStatus: "running",
    publicSummary: "正在读取Memory上下文",
  });
  if (prepared.status === "required_failed") {
    await recordConfigurablePlanningNodeStep({
      ...nodeIdentity,
      toStatus: "failed",
      outcomeCode: "required_unavailable",
      publicSummary: "必需Memory上下文不可用",
    });
    return "required_unavailable";
  }
  if (prepared.status === "ready" || prepared.status === "optional_failed") {
    state.contextPackageRef = prepared.contextPackageRef;
    const outcome = prepared.status === "ready" ? "success" : "optional_unavailable";
    await recordConfigurablePlanningNodeStep({
      ...nodeIdentity,
      toStatus: "succeeded",
      outcomeCode: outcome,
      publicSummary:
        prepared.status === "ready" ? "Memory上下文已冻结" : "可选Memory不可用，继续规划",
    });
    return outcome;
  }
  throw new Error("configurable_planning.memory_context_status_unreachable");
}

export async function executeProjectContext(
  input: ConfigurablePlanningWorkflowInput,
  state: PlanningInterpreterState,
  nodeIdentity: PlanningNodeIdentity,
): Promise<"success" | "optional_unavailable" | "required_unavailable"> {
  let prepared;
  try {
    prepared = await preparePlanningProjectContextStep({
      productRunId: input.productRunId,
      attemptId: input.attemptId,
      workflowRunSpecId: input.workflowRunSpecId,
      definitionNodeId: nodeIdentity.definitionNodeId,
      executionPath: nodeIdentity.executionPath,
      attemptNumber: nodeIdentity.attemptNumber,
    });
  } catch {
    return failPlanningResource(
      state,
      "configurable_planning.project_context_unavailable",
      "Project上下文无法按冻结引用准备",
    );
  }
  // selected/none都由Application在业务事务内原子提交Node terminal；Workflow不补写。
  if (prepared.status === "none") return "optional_unavailable";
  state.planningProjectContextRef = prepared.contextRef;
  return "success";
}

export async function executeRulesContext(
  input: ConfigurablePlanningWorkflowInput,
  state: PlanningInterpreterState,
  nodeIdentity: PlanningNodeIdentity,
): Promise<"success" | "optional_unavailable" | "required_unavailable"> {
  let prepared;
  try {
    prepared = await preparePlanningRulesContextStep({
      productRunId: input.productRunId,
      attemptId: input.attemptId,
      workflowRunSpecId: input.workflowRunSpecId,
      definitionNodeId: nodeIdentity.definitionNodeId,
      executionPath: nodeIdentity.executionPath,
      attemptNumber: nodeIdentity.attemptNumber,
    });
  } catch {
    return failPlanningResource(
      state,
      "configurable_planning.rules_context_unavailable",
      "Rule Selection无法按冻结引用准备",
    );
  }
  // selected/none都由Application在业务事务内原子提交Node terminal；Workflow不补写。
  if (prepared.status === "none") return "optional_unavailable";
  state.ruleSelectionRef = prepared.selectionRef;
  return "success";
}

function hasIncludedResource(
  runSpec: WorkflowRunSpec,
  definitionNodeId: string,
  resourceKind: "memory" | "project" | "rule",
): boolean {
  return runSpec.resourceResolutions.some(
    (resource) =>
      resource.definitionNodeId === definitionNodeId &&
      resource.resourceKind === resourceKind &&
      resource.resolution === "included",
  );
}

function failPlanningResource(
  state: PlanningInterpreterState,
  code: string,
  summary: string,
): "required_unavailable" {
  state.failure = { code, summary };
  return "required_unavailable";
}
