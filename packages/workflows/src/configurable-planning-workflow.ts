import type { WorkflowRunSpec } from "@chat/contracts";
import {
  loadConfigurablePlanningRunSpecStep,
  recordConfigurablePlanningNodeStep,
} from "./configurable-planning-steps.js";
import { executePlanningNode } from "./configurable-planning-node-executors.js";
import {
  executeMemoryContext,
  executeProjectContext,
  executeRulesContext,
} from "./configurable-planning-resource-executors.js";
import {
  configurablePlanningWorkflowInputSchema,
  type ConfigurablePlanningWorkflowInput,
  type ConfigurablePlanningWorkflowResult,
  type PlanningInterpreterState,
} from "./configurable-planning-types.js";
import { PiStepFailure } from "./workflow-error.js";
import { interpretRestrictedRunSpec } from "./restricted-run-spec-interpreter.js";
import { commitRunFailureStep, commitRunOutcomeUnknownStep } from "./workflow-result-steps.js";

export {
  configurablePlanningWorkflowInputSchema,
  type ConfigurablePlanningWorkflowInput,
  type ConfigurablePlanningWorkflowResult,
} from "./configurable-planning-types.js";

/**
 * S4固定Runner解释已冻结RunSpec；节点只能落到静态注册的真实业务操作。
 * Definition不能提供函数名、URL或代码，运行中也不会回读最新Definition。
 */
export async function configurablePlanningWorkflow(
  rawInput: ConfigurablePlanningWorkflowInput,
): Promise<ConfigurablePlanningWorkflowResult> {
  "use workflow";
  const input = configurablePlanningWorkflowInputSchema.parse(rawInput);
  try {
    const runSpec = await loadConfigurablePlanningRunSpecStep({
      productRunId: input.productRunId,
      workflowRunSpecId: input.workflowRunSpecId,
    });
    return await interpretPlanningRunSpec(input, runSpec);
  } catch (error) {
    const failure = failureSummary(error);
    await commitRunFailureStep({
      productRunId: input.productRunId,
      attemptId: input.attemptId,
      errorCode: failure.code,
      summary: failure.summary,
    });
    return workflowResult(input, "failed", failure.code);
  }
}

async function interpretPlanningRunSpec(
  input: ConfigurablePlanningWorkflowInput,
  runSpec: WorkflowRunSpec,
): Promise<ConfigurablePlanningWorkflowResult> {
  const state: PlanningInterpreterState = {
    planRevision: 0,
    productCommitted: false,
    cancelled: false,
  };
  const interpreted = await interpretRestrictedRunSpec<ConfigurablePlanningWorkflowResult>({
    runSpec,
    onLoopLimitExceeded: async () =>
      // 正式Planning seed使用fail。request_human没有独立产品Review事实，拒绝伪造。
      failRun(
        input,
        state,
        "plan_revision_limit_reached",
        "规划修订已达上限，请调整目标后重新开始",
      ),
    executeNode: async ({ element, resolution, executionPath, nextElement }) => {
      const nodeIdentity = {
        productRunId: input.productRunId,
        workflowRunSpecId: input.workflowRunSpecId,
        definitionNodeId: element.definitionNodeId,
        executionPath,
        attemptNumber: 1,
      } as const;
      let outcome: string;
      const skipOutcome = resolvedSkipOutcome(runSpec, resolution);
      if (skipOutcome !== undefined) {
        outcome = skipOutcome;
        await recordConfigurablePlanningNodeStep({
          ...nodeIdentity,
          toStatus: "skipped",
          outcomeCode: outcome,
          publicSummary: nodeSummary(element.nodeType, outcome),
        });
      } else if (element.nodeType === "context.memory") {
        // Memory是否有旧式ContextRequest只能由Application权威边界判断。none必须从queued
        // 直接skipped；真实查询才进入running，避免制造S1不允许的running→skipped。
        outcome = await executeMemoryContext(input, runSpec, state, nodeIdentity);
      } else if (element.nodeType === "context.project") {
        outcome = await executeProjectContext(input, state, nodeIdentity);
      } else if (element.nodeType === "policy.rules") {
        outcome = await executeRulesContext(input, state, nodeIdentity);
      } else if (
        element.nodeType === "human.plan_review" ||
        element.nodeType === "product.commit" ||
        APPLICATION_OWNS_NODE_TYPES.has(element.nodeType)
      ) {
        // Planning业务Application不仅拥有terminal；Decision/revision也可能在Workflow到达
        // 下一节点前预投影running。Runner因此对这些节点完全不做通用transition。
        outcome = await executePlanningNode({
          input,
          runSpec,
          definitionNodeId: element.definitionNodeId,
          nodeType: element.nodeType,
          config: resolution.config,
          nodeIdentity,
          state,
        });
      } else {
        await recordConfigurablePlanningNodeStep({
          ...nodeIdentity,
          toStatus: "running",
          publicSummary: "正在执行",
        });
        outcome = await executePlanningNode({
          input,
          runSpec,
          definitionNodeId: element.definitionNodeId,
          nodeType: element.nodeType,
          config: resolution.config,
          nodeIdentity,
          state,
        });
        await recordConfigurablePlanningNodeStep({
          ...nodeIdentity,
          toStatus: nodeStatusForOutcome(outcome),
          outcomeCode: outcome,
          publicSummary: nodeSummary(element.nodeType, outcome),
        });
      }

      if (state.cancelled) return { outcome, terminal: workflowResult(input, "cancelled") };
      if (outcome === "outcome_unknown") {
        await commitRunOutcomeUnknownStep({
          productRunId: input.productRunId,
          attemptId: input.attemptId,
          errorCode: state.failure?.code ?? "execution.outcome_unknown",
          summary: "执行结果无法确认，已停止自动重试并等待人工对账",
        });
        return {
          outcome,
          terminal: workflowResult(input, "outcome_unknown", "execution.outcome_unknown"),
        };
      }
      if (
        FAIL_CLOSED_OUTCOMES.has(outcome) &&
        !(
          nextElement?.kind === "choice" &&
          nextElement.fromDefinitionNodeId === element.definitionNodeId
        )
      ) {
        const failure = state.failure ?? {
          code: `configurable_planning.${outcome}`,
          summary: "后台工作未满足继续条件，已安全停止",
        };
        return { outcome, terminal: await failRun(input, state, failure.code, failure.summary) };
      }
      return { outcome };
    },
  });
  if (interpreted.kind === "terminal") return interpreted.value;

  if (!state.productCommitted) {
    return failRun(
      input,
      state,
      "configurable_planning.terminal_commit_missing",
      "工作流没有提交正式结果，已安全停止",
    );
  }
  return workflowResult(input, "product_committed");
}

async function failRun(
  input: ConfigurablePlanningWorkflowInput,
  state: PlanningInterpreterState,
  code: string,
  summary: string,
): Promise<ConfigurablePlanningWorkflowResult> {
  if (!state.cancelled && !state.productCommitted) {
    await commitRunFailureStep({
      productRunId: input.productRunId,
      attemptId: input.attemptId,
      errorCode: code,
      summary,
    });
  }
  return workflowResult(input, "failed", code);
}

function failureSummary(error: unknown): { readonly code: string; readonly summary: string } {
  if (error instanceof PiStepFailure) {
    return {
      code: error.stableCode,
      summary: "后台工作失败，请稍后重试或调整目标后重新开始",
    };
  }
  if (error instanceof Error && STABLE_ERROR_CODE.test(error.message)) {
    return { code: error.message, summary: "后台工作遇到不可恢复的合同错误" };
  }
  return { code: "configurable_planning.runner_failed", summary: "后台工作遇到内部错误" };
}

function nodeStatusForOutcome(outcome: string): "succeeded" | "failed" | "outcome_unknown" {
  if (outcome === "outcome_unknown") return "outcome_unknown";
  if (FAIL_CLOSED_OUTCOMES.has(outcome)) return "failed";
  return "succeeded";
}

function nodeSummary(nodeType: string, outcome: string): string {
  if (nodeType === "agent.research" && outcome === "no_evidence") {
    return "调研并入规划边界；未伪造独立证据或重复调用模型";
  }
  if (outcome === "optional_unavailable") return "冻结配置未选择该可选输入";
  if (outcome === "request_revision") return "已要求修订计划";
  if (outcome === "approved") return "计划已批准";
  if (outcome === "rejected") return "计划已拒绝";
  if (outcome === "outcome_unknown") return "执行结果未知，等待对账";
  return "节点已完成";
}

function resolvedSkipOutcome(
  runSpec: WorkflowRunSpec,
  resolution: WorkflowRunSpec["nodeResolutions"][number],
): string | undefined {
  if (resolution.activation === "skipped") {
    if (resolution.skipOutcome === undefined) {
      throw new Error("configurable_planning.skip_outcome_missing");
    }
    return resolution.skipOutcome;
  }
  if (resolution.nodeType === "agent.research") {
    // 没有独立research产品提交边界；显式跳过并说明已合并，不能写成功假证据。
    return "no_evidence";
  }
  if (
    resolution.nodeType === "context.memory" ||
    resolution.nodeType === "context.project" ||
    resolution.nodeType === "policy.rules"
  ) {
    // 资源selected/none由Application业务事务原子投影；Runner不能预判后通用补写。
    // Memory的legacy ContextRequest与RunSpec Snapshot也不能因同名互相覆盖。
    return undefined;
  }
  const resourceKind = OPTIONAL_RESOURCE_KIND_BY_NODE_TYPE[resolution.nodeType];
  if (resourceKind === undefined) return undefined;
  const resources = runSpec.resourceResolutions.filter(
    (candidate) =>
      candidate.definitionNodeId === resolution.definitionNodeId &&
      candidate.resourceKind === resourceKind,
  );
  return resources.length > 0 &&
    resources.every(
      (candidate) =>
        candidate.resolution === "excluded" && candidate.exclusionReason === "not_selected",
    )
    ? "optional_unavailable"
    : undefined;
}

function workflowResult(
  input: ConfigurablePlanningWorkflowInput,
  outcome: ConfigurablePlanningWorkflowResult["outcome"],
  errorCode?: string,
): ConfigurablePlanningWorkflowResult {
  return {
    outcome,
    productRunId: input.productRunId,
    workflowRunSpecId: input.workflowRunSpecId,
    ...(errorCode !== undefined ? { errorCode } : {}),
  };
}

const FAIL_CLOSED_OUTCOMES = new Set(["failed", "invalid", "required_unavailable", "needs_input"]);

// 这些节点的Product用例拥有running与terminal投影；例如request_revision提交后会先创建
// 下一轮agent.plan/running。任何同状态但不同summary的Runner补写都会破坏可审计重放。
const APPLICATION_OWNS_NODE_TYPES: ReadonlySet<string> = new Set([
  "agent.plan",
  "execute.plan",
  "result.validate",
]);

const OPTIONAL_RESOURCE_KIND_BY_NODE_TYPE: Readonly<Record<string, string>> = {
  "context.memory": "memory",
  "context.project": "project",
  "policy.rules": "rule",
  "capability.skills": "skill",
};

const STABLE_ERROR_CODE = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/;
