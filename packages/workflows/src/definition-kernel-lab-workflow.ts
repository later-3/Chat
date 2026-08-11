import { defineHook } from "workflow";
import { z } from "zod";
import type { WorkflowRunSpec } from "@chat/contracts";
import type { WorkflowBoundedLoopElement, WorkflowSequence } from "@chat/domain";
import {
  autoContinueDefinitionKernelReviewStep,
  beginDefinitionKernelLoopLimitReviewStep,
  beginDefinitionKernelReviewStep,
  completeDefinitionKernelCompositeStep,
  executeDefinitionKernelCompositeChildStep,
  executeDefinitionKernelNodeStep,
  loadDefinitionKernelDecisionStep,
  loadDefinitionKernelLoopLimitDecisionStep,
  loadDefinitionKernelRunSpecStep,
  markDefinitionKernelReviewHookReadyStep,
  prepareDefinitionKernelCompositeStep,
  settleDefinitionKernelLabStep,
  skipDefinitionKernelNodeStep,
} from "./definition-kernel-lab-steps.js";
import type { KernelNodeExecutionScope } from "./definition-kernel-lab-runtime.js";

export const definitionKernelLabWorkflowInputSchema = z.strictObject({
  schemaVersion: z.literal("definition-kernel-lab-workflow-input.v1"),
  productRunId: z.string().regex(/^run_[A-Za-z0-9]+$/),
  workflowRunSpecId: z.string().regex(/^wrs_[A-Za-z0-9]+$/),
  attemptNumber: z.number().int().min(1).max(20),
  runtimeCredentialRef: z.string().regex(/^rtc_[A-Za-z0-9]+$/),
});
export type DefinitionKernelLabWorkflowInput = z.infer<
  typeof definitionKernelLabWorkflowInputSchema
>;

export interface DefinitionKernelLabWorkflowResult {
  readonly outcome: "completed" | "cancelled" | "failed";
  readonly productRunId: string;
  readonly workflowRunSpecId: string;
  readonly reasonCode?: string;
}

const reviewResumeHook = defineHook({
  schema: z.strictObject({ decisionRef: z.string().min(3).max(128) }),
});

interface SequenceFrame {
  readonly kind: "sequence";
  readonly sequence: WorkflowSequence;
  readonly path: string;
  index: number;
}

interface LoopFrame {
  readonly kind: "loop";
  readonly loop: WorkflowBoundedLoopElement;
  readonly path: string;
  iteration: number;
  phase: "start_body" | "body_complete";
}

type ExecutionFrame = SequenceFrame | LoopFrame;

/**
 * 固定代码Runner解释不可变RunSpec；不会eval/import/codegen用户Definition。
 * 当前选择只依赖RunSpec、已提交outcome与显式executionPath，重放命令身份稳定。
 */
export async function definitionKernelLabWorkflow(
  rawInput: DefinitionKernelLabWorkflowInput,
): Promise<DefinitionKernelLabWorkflowResult> {
  "use workflow";
  const input = definitionKernelLabWorkflowInputSchema.parse(rawInput);
  let runSpec: WorkflowRunSpec | undefined;
  try {
    runSpec = await loadDefinitionKernelRunSpecStep({
      workflowRunSpecId: input.workflowRunSpecId,
      productRunId: input.productRunId,
    });
    return await interpretRunSpec(input, runSpec);
  } catch {
    // Error正文可能来自Adapter/Provider，不能进入产品settlement或Checkpoint诊断。
    const settlement = await settleDefinitionKernelLabStep({
      workflowRunSpecId: input.workflowRunSpecId,
      productRunId: input.productRunId,
      settlement: { outcome: "failed", reasonCode: "kernel.runner_failed" },
    });
    return {
      ...settlement,
      productRunId: input.productRunId,
      workflowRunSpecId: input.workflowRunSpecId,
    };
  }
}

async function interpretRunSpec(
  input: DefinitionKernelLabWorkflowInput,
  runSpec: WorkflowRunSpec,
): Promise<DefinitionKernelLabWorkflowResult> {
  const outcomes: Record<string, string> = {};
  const stack: ExecutionFrame[] = [
    { kind: "sequence", sequence: runSpec.semanticRoot, path: "root", index: 0 },
  ];
  let nodeExecutions = 0;
  let waitCount = 0;
  let compositeChildren = 0;

  while (stack.length > 0) {
    const frame = stack.at(-1);
    if (frame === undefined) break;
    if (frame.kind === "loop") {
      if (frame.phase === "start_body") {
        frame.phase = "body_complete";
        stack.push({
          kind: "sequence",
          sequence: frame.loop.body,
          path: `${frame.path}/iteration-${String(frame.iteration)}`,
          index: 0,
        });
        continue;
      }
      const outcome = outcomes[frame.loop.outcomeFromDefinitionNodeId];
      if (outcome === undefined) throw new Error("kernel.loop_outcome_missing");
      if (frame.loop.continueOutcomes.includes(outcome)) {
        if (frame.iteration >= frame.loop.maxIterations) {
          if (frame.loop.exceededPolicy === "fail") {
            return settleResult(input, "failed", "kernel.loop_limit_exceeded");
          }
          waitCount += 1;
          assertRuntimeBudget(
            waitCount,
            runSpec.limits.runtime.maxWaits,
            "kernel.wait_budget_exceeded",
          );
          const reviewPath = `${frame.path}/limit-review`;
          const review = await beginDefinitionKernelLoopLimitReviewStep({
            workflowRunSpecId: input.workflowRunSpecId,
            productRunId: input.productRunId,
            executionPath: reviewPath,
          });
          using hook = reviewResumeHook.create({
            token: definitionKernelReviewHookToken(input.workflowRunSpecId, reviewPath),
          });
          if ((await hook.getConflict()) !== null) throw new Error("kernel.review_hook_conflict");
          await markDefinitionKernelReviewHookReadyStep({
            workflowRunSpecId: input.workflowRunSpecId,
            productRunId: input.productRunId,
            executionPath: reviewPath,
            reviewRef: review.reviewRef,
          });
          const signal = await hook;
          await loadDefinitionKernelLoopLimitDecisionStep({
            reviewRef: review.reviewRef,
            decisionRef: signal.decisionRef,
          });
          return settleResult(input, "failed", "kernel.loop_limit_stopped_by_human");
        }
        frame.iteration += 1;
        frame.phase = "start_body";
        continue;
      }
      if (!frame.loop.exitOutcomes.includes(outcome)) {
        throw new Error("kernel.loop_outcome_not_declared");
      }
      stack.pop();
      continue;
    }

    if (frame.index >= frame.sequence.elements.length) {
      stack.pop();
      continue;
    }
    const elementIndex = frame.index;
    frame.index += 1;
    const element = frame.sequence.elements[elementIndex];
    if (element === undefined) continue;
    const elementPath = `${frame.path}/element-${String(elementIndex)}`;
    if (element.kind === "sequence") {
      stack.push({ kind: "sequence", sequence: element, path: elementPath, index: 0 });
      continue;
    }
    if (element.kind === "choice") {
      const outcome = outcomes[element.fromDefinitionNodeId];
      const branch = element.branches.find((candidate) => candidate.outcome === outcome);
      if (branch === undefined) throw new Error("kernel.choice_outcome_missing");
      stack.push({
        kind: "sequence",
        sequence: branch.body,
        path: `${elementPath}/outcome-${branch.outcome}`,
        index: 0,
      });
      continue;
    }
    if (element.kind === "bounded_loop") {
      stack.push({
        kind: "loop",
        loop: element,
        path: elementPath,
        iteration: 1,
        phase: "start_body",
      });
      continue;
    }

    nodeExecutions += 1;
    assertRuntimeBudget(
      nodeExecutions,
      runSpec.limits.runtime.maxNodeExecutions,
      "kernel.node_execution_budget_exceeded",
    );
    const resolution = runSpec.nodeResolutions.find(
      (candidate) => candidate.definitionNodeId === element.definitionNodeId,
    );
    if (resolution === undefined) throw new Error("kernel.node_resolution_missing");
    const context = nodeContext(input, element.definitionNodeId, elementPath);
    let outcome: string;
    if (resolution.activation === "skipped") {
      if (resolution.skipOutcome === undefined) throw new Error("kernel.skip_outcome_missing");
      outcome = (
        await skipDefinitionKernelNodeStep({
          context,
          nodeType: element.nodeType,
          schemaVersion: element.schemaVersion,
          outcomeCode: resolution.skipOutcome,
        })
      ).outcomeCode;
    } else if (element.kind === "composite") {
      const prepared = await prepareDefinitionKernelCompositeStep({ context });
      const configuredMaximum =
        typeof resolution.config.maxActions === "number"
          ? resolution.config.maxActions
          : runSpec.limits.runtime.maxCompositeChildren;
      if (
        prepared.actionManifest.actions.length > configuredMaximum ||
        prepared.actionManifest.actions.length > runSpec.limits.runtime.maxCompositeChildren
      ) {
        throw new Error("kernel.composite_manifest_budget_exceeded");
      }
      let compositeOutcome: "success" | "failed" | "outcome_unknown" =
        prepared.outcomeCode === "outcome_unknown"
          ? "outcome_unknown"
          : prepared.outcomeCode === "success"
            ? "success"
            : "failed";
      for (const action of prepared.actionManifest.actions) {
        compositeChildren += 1;
        assertRuntimeBudget(
          compositeChildren,
          runSpec.limits.runtime.maxCompositeChildren,
          "kernel.composite_children_budget_exceeded",
        );
        const childPath = `${elementPath}/action-${action.actionId}`;
        const child = await executeDefinitionKernelCompositeChildStep({
          context: nodeContext(input, element.definitionNodeId, childPath),
          actionId: action.actionId,
        });
        if (child.outcomeCode === "outcome_unknown") compositeOutcome = "outcome_unknown";
        else if (child.outcomeCode !== "success" && compositeOutcome === "success") {
          compositeOutcome = "failed";
        }
      }
      outcome = (
        await completeDefinitionKernelCompositeStep({ context, outcomeCode: compositeOutcome })
      ).outcomeCode;
    } else if (
      element.nodeType === "human.plan_review" ||
      element.nodeType === "human.note_review"
    ) {
      const reviewResolution = runSpec.reviewResolutions.find(
        (candidate) => candidate.definitionNodeId === element.definitionNodeId,
      );
      if (reviewResolution === undefined) throw new Error("kernel.review_resolution_missing");
      if (reviewResolution.actor === "system_policy") {
        if (reviewResolution.policyRef === undefined)
          throw new Error("kernel.review_policy_ref_missing");
        outcome = (
          await autoContinueDefinitionKernelReviewStep({
            context,
            nodeType: element.nodeType,
            policyRef: reviewResolution.policyRef,
          })
        ).outcomeCode;
      } else {
        waitCount += 1;
        assertRuntimeBudget(
          waitCount,
          runSpec.limits.runtime.maxWaits,
          "kernel.wait_budget_exceeded",
        );
        const review = await beginDefinitionKernelReviewStep({
          context,
          nodeType: element.nodeType,
        });
        using hook = reviewResumeHook.create({
          token: definitionKernelReviewHookToken(input.workflowRunSpecId, elementPath),
        });
        if ((await hook.getConflict()) !== null) throw new Error("kernel.review_hook_conflict");
        await markDefinitionKernelReviewHookReadyStep({
          workflowRunSpecId: input.workflowRunSpecId,
          productRunId: input.productRunId,
          executionPath: elementPath,
          reviewRef: review.reviewRef,
        });
        const signal = await hook;
        outcome = (
          await loadDefinitionKernelDecisionStep({
            context,
            nodeType: element.nodeType,
            reviewRef: review.reviewRef,
            decisionRef: signal.decisionRef,
          })
        ).outcomeCode;
      }
    } else {
      outcome = (
        await executeDefinitionKernelNodeStep({
          context,
          nodeType: element.nodeType,
          schemaVersion: element.schemaVersion,
        })
      ).outcomeCode;
    }
    outcomes[element.definitionNodeId] = outcome;
    if (
      (element.nodeType === "human.plan_review" || element.nodeType === "human.note_review") &&
      outcome === "rejected"
    ) {
      return settleResult(input, "cancelled", "kernel.review_rejected");
    }
    if (FAIL_CLOSED_OUTCOMES.has(outcome)) {
      const next = frame.sequence.elements[frame.index];
      const explicitlyHandled =
        next?.kind === "choice" && next.fromDefinitionNodeId === element.definitionNodeId;
      if (!explicitlyHandled) {
        return settleResult(
          input,
          "failed",
          outcome === "outcome_unknown"
            ? "kernel.node_outcome_unknown"
            : "kernel.node_failed_closed",
        );
      }
    }
  }

  return settleResult(input, "completed");
}

const FAIL_CLOSED_OUTCOMES = new Set([
  "failed",
  "outcome_unknown",
  "invalid",
  "required_unavailable",
  "no_note",
  "needs_input",
]);

function nodeContext(
  input: DefinitionKernelLabWorkflowInput,
  definitionNodeId: string,
  executionPath: string,
): KernelNodeExecutionScope {
  return {
    workflowRunSpecId: input.workflowRunSpecId,
    productRunId: input.productRunId,
    definitionNodeId,
    executionPath,
    attemptNumber: input.attemptNumber,
  };
}

export function definitionKernelReviewHookToken(
  workflowRunSpecId: string,
  executionPath: string,
): string {
  const safePath = executionPath.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 180);
  return `dkr-${workflowRunSpecId}-${safePath}`;
}

async function settleResult(
  input: DefinitionKernelLabWorkflowInput,
  outcome: DefinitionKernelLabWorkflowResult["outcome"],
  reasonCode?: string,
): Promise<DefinitionKernelLabWorkflowResult> {
  const settlement = await settleDefinitionKernelLabStep({
    workflowRunSpecId: input.workflowRunSpecId,
    productRunId: input.productRunId,
    settlement: { outcome, ...(reasonCode !== undefined ? { reasonCode } : {}) },
  });
  return {
    ...settlement,
    productRunId: input.productRunId,
    workflowRunSpecId: input.workflowRunSpecId,
  };
}

function assertRuntimeBudget(actual: number, maximum: number, code: string): void {
  if (actual > maximum) throw new Error(code);
}
