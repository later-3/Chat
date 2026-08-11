import type { WorkflowRunSpec } from "@chat/contracts";
import type {
  WorkflowBoundedLoopElement,
  WorkflowCompositeElement,
  WorkflowSequence,
  WorkflowTaskElement,
} from "@chat/domain";
import {
  DEFINITION_KERNEL_EXECUTORS,
  type KernelExecutorRegistration,
} from "./definition-kernel-executor-registry.js";

export interface RestrictedIrExecutionPathSegment {
  readonly containerNodeId: string;
  readonly iteration: number;
}

export interface RestrictedIrNodeInvocation {
  readonly element: WorkflowTaskElement | WorkflowCompositeElement;
  readonly resolution: WorkflowRunSpec["nodeResolutions"][number];
  readonly registration: KernelExecutorRegistration;
  readonly executionPath: readonly RestrictedIrExecutionPathSegment[];
  readonly nextElement: WorkflowSequence["elements"][number] | undefined;
}

export interface RestrictedIrNodeResult<TTerminal> {
  readonly outcome: string;
  readonly terminal?: TTerminal | undefined;
}

export type RestrictedIrResult<TTerminal> =
  { readonly kind: "completed" } | { readonly kind: "terminal"; readonly value: TTerminal };

interface SequenceFrame {
  readonly kind: "sequence";
  readonly sequence: WorkflowSequence;
  readonly executionPath: readonly RestrictedIrExecutionPathSegment[];
  index: number;
}

interface LoopFrame {
  readonly kind: "loop";
  readonly loop: WorkflowBoundedLoopElement;
  readonly executionPath: readonly RestrictedIrExecutionPathSegment[];
  iteration: number;
  phase: "start_body" | "body_complete";
}

type ExecutionFrame = SequenceFrame | LoopFrame;

/**
 * Planning与Note共用的受限IR控制内核。
 *
 * 它只解释服务端冻结的Sequence/Choice/BoundedLoop，并通过静态Registry把叶子节点
 * 交给调用方的类型化业务执行器；Definition无法提供函数、URL、表达式或动态模块名。
 * 业务执行器只返回Catalog outcome，控制内核据此选择固定分支/循环。任何身份、预算或
 * outcome不一致都会在调用下一个业务边界前失败关闭。
 */
export async function interpretRestrictedRunSpec<TTerminal>(input: {
  readonly runSpec: WorkflowRunSpec;
  readonly executeNode: (
    invocation: RestrictedIrNodeInvocation,
  ) => Promise<RestrictedIrNodeResult<TTerminal>>;
  readonly onLoopLimitExceeded: (input: {
    readonly loop: WorkflowBoundedLoopElement;
    readonly executionPath: readonly RestrictedIrExecutionPathSegment[];
  }) => Promise<TTerminal>;
}): Promise<RestrictedIrResult<TTerminal>> {
  const outcomes: Record<string, string> = {};
  const stack: ExecutionFrame[] = [
    { kind: "sequence", sequence: input.runSpec.semanticRoot, executionPath: [], index: 0 },
  ];
  let nodeExecutions = 0;
  let waits = 0;

  while (stack.length > 0) {
    const frame = stack.at(-1);
    if (frame === undefined) break;
    if (frame.kind === "loop") {
      if (frame.phase === "start_body") {
        frame.phase = "body_complete";
        stack.push({
          kind: "sequence",
          sequence: frame.loop.body,
          executionPath: [
            ...frame.executionPath,
            {
              containerNodeId: loopContainerNodeId(frame.loop),
              iteration: frame.iteration,
            },
          ],
          index: 0,
        });
        continue;
      }
      const outcome = outcomes[frame.loop.outcomeFromDefinitionNodeId];
      if (outcome === undefined) throw new Error("workflow_ir.loop_outcome_missing");
      if (frame.loop.continueOutcomes.includes(outcome)) {
        if (frame.iteration >= frame.loop.maxIterations) {
          return {
            kind: "terminal",
            value: await input.onLoopLimitExceeded({
              loop: frame.loop,
              executionPath: frame.executionPath,
            }),
          };
        }
        frame.iteration += 1;
        frame.phase = "start_body";
        continue;
      }
      if (!frame.loop.exitOutcomes.includes(outcome)) {
        throw new Error("workflow_ir.loop_outcome_not_declared");
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
    if (element.kind === "sequence") {
      stack.push({
        kind: "sequence",
        sequence: element,
        executionPath: frame.executionPath,
        index: 0,
      });
      continue;
    }
    if (element.kind === "choice") {
      const outcome = outcomes[element.fromDefinitionNodeId];
      const branch = element.branches.find((candidate) => candidate.outcome === outcome);
      if (branch === undefined) throw new Error("workflow_ir.choice_outcome_missing");
      stack.push({
        kind: "sequence",
        sequence: branch.body,
        executionPath: frame.executionPath,
        index: 0,
      });
      continue;
    }
    if (element.kind === "bounded_loop") {
      stack.push({
        kind: "loop",
        loop: element,
        executionPath: frame.executionPath,
        iteration: 1,
        phase: "start_body",
      });
      continue;
    }

    nodeExecutions += 1;
    if (nodeExecutions > input.runSpec.limits.runtime.maxNodeExecutions) {
      throw new Error("workflow_ir.node_execution_budget_exceeded");
    }
    const resolution = input.runSpec.nodeResolutions.find(
      (candidate) => candidate.definitionNodeId === element.definitionNodeId,
    );
    if (
      resolution === undefined ||
      resolution.nodeType !== element.nodeType ||
      resolution.schemaVersion !== element.schemaVersion
    ) {
      throw new Error("workflow_ir.node_resolution_mismatch");
    }
    const registration = DEFINITION_KERNEL_EXECUTORS.get(
      resolution.nodeType,
      resolution.schemaVersion,
    );
    if (registration === undefined) throw new Error("workflow_ir.executor_not_registered");
    if (registration.executorKind === "human_review") {
      waits += 1;
      if (waits > input.runSpec.limits.runtime.maxWaits) {
        throw new Error("workflow_ir.wait_budget_exceeded");
      }
    }
    const result = await input.executeNode({
      element,
      resolution,
      registration,
      executionPath: frame.executionPath,
      nextElement: frame.sequence.elements[frame.index],
    });
    outcomes[element.definitionNodeId] = result.outcome;
    if (result.terminal !== undefined) {
      return { kind: "terminal", value: result.terminal };
    }
  }
  return { kind: "completed" };
}

function loopContainerNodeId(loop: WorkflowBoundedLoopElement): string {
  // IR容器没有definitionNodeId；受支配outcome节点在同一Revision内全局唯一，
  // 因而该派生身份在Planning/Note、进程重启和Workflow重放之间都稳定。
  return `${loop.outcomeFromDefinitionNodeId}.loop`;
}
