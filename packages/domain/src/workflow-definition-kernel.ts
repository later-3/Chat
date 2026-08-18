/**
 * 可配置工作流内核的纯领域合同。
 *
 * 这里刻意不出现Zod、Vercel Workflow、React Flow或数据库对象：Definition的
 * 语义是一棵受限递归树，运行时/网络适配器只能在边界解析后把纯值交给本模块。
 * 新Node Type仍必须经代码注册、风险审核和Executor实现，Definition只负责组合。
 */

export const WORKFLOW_NODE_TYPES = [
  "memory.query",
  "memory.write",
  "context.memory",
  "context.project",
  "policy.rules",
  "capability.skills",
  "agent.research",
  "agent.plan",
  "human.plan_review",
  "execute.plan",
  "result.validate",
  "product.commit",
  "note.extract",
  "note.classify",
  "human.note_review",
  "note.commit",
] as const;

export type WorkflowNodeTypeKey = (typeof WORKFLOW_NODE_TYPES)[number];

export const WORKFLOW_EXECUTOR_KINDS = ["step", "human_review", "composite"] as const;
export type WorkflowExecutorKind = (typeof WORKFLOW_EXECUTOR_KINDS)[number];

export const WORKFLOW_RISK_LEVELS = [
  "read_context",
  "generate_candidate",
  "human_decision",
  "external_effect",
  "product_commit",
] as const;
export type WorkflowRiskLevel = (typeof WORKFLOW_RISK_LEVELS)[number];

const RISK_RANK: Readonly<Record<WorkflowRiskLevel, number>> = {
  read_context: 1,
  generate_candidate: 2,
  human_decision: 3,
  external_effect: 4,
  product_commit: 5,
};

export function workflowRiskAtLeast(
  actual: WorkflowRiskLevel,
  required: WorkflowRiskLevel,
): boolean {
  return RISK_RANK[actual] >= RISK_RANK[required];
}

export type WorkflowSkipPolicy =
  | { readonly kind: "never" }
  | {
      readonly kind: "allowed_with_default_outcome";
      readonly defaultOutcome: string;
    }
  | {
      readonly kind: "allowed_with_explicit_value";
      readonly allowedOutcomes: readonly string[];
    };

export type WorkflowReviewMode = "manual" | "auto_continue_if_policy_allows" | "always_auto";

export type WorkflowSlotValueKind =
  | "message_ref"
  | "memory_snapshot_ref"
  | "memory_write_ref"
  | "context_package_ref"
  | "project_context_ref"
  | "rule_resolution_ref"
  | "skill_resolution_ref"
  | "evidence_ref"
  | "plan_revision_ref"
  | "decision_ref"
  | "execution_candidate_ref"
  | "validation_result_ref"
  | "artifact_ref"
  | "note_candidate_ref"
  | "note_revision_ref";

export interface WorkflowSlotDescriptor {
  readonly name: string;
  readonly valueKind: WorkflowSlotValueKind;
  readonly required: boolean;
  readonly multiple: boolean;
}

export type WorkflowDefaultActivation = "enabled" | "skipped";

/**
 * 递归联合由手写TypeScript类型拥有，边界Schema不能用无界z.infer反推它。
 * Sequence顺序具有业务语义；Choice分支和outcome集合是无序集合，规范化时排序。
 */
export interface WorkflowSequence {
  readonly kind: "sequence";
  readonly elements: readonly WorkflowElement[];
}

export interface WorkflowTaskElement {
  readonly kind: "task";
  readonly definitionNodeId: string;
  readonly nodeType: WorkflowNodeTypeKey;
  readonly schemaVersion: number;
  readonly config: Readonly<Record<string, unknown>>;
  readonly defaultActivation?: WorkflowDefaultActivation | undefined;
}

export interface WorkflowChoiceBranch {
  readonly outcome: string;
  readonly body: WorkflowSequence;
}

export interface WorkflowChoiceElement {
  readonly kind: "choice";
  readonly fromDefinitionNodeId: string;
  readonly branches: readonly WorkflowChoiceBranch[];
}

export interface WorkflowBoundedLoopElement {
  readonly kind: "bounded_loop";
  readonly body: WorkflowSequence;
  readonly outcomeFromDefinitionNodeId: string;
  readonly continueOutcomes: readonly string[];
  readonly exitOutcomes: readonly string[];
  readonly maxIterations: number;
  readonly exceededPolicy: "fail" | "request_human";
}

export interface WorkflowCompositeElement {
  readonly kind: "composite";
  readonly definitionNodeId: string;
  readonly nodeType: WorkflowNodeTypeKey;
  readonly schemaVersion: number;
  readonly config: Readonly<Record<string, unknown>>;
  readonly defaultActivation?: WorkflowDefaultActivation | undefined;
}

export type WorkflowElement =
  | WorkflowSequence
  | WorkflowTaskElement
  | WorkflowChoiceElement
  | WorkflowBoundedLoopElement
  | WorkflowCompositeElement;

/**
 * 这组数字是S3实验室的单一服务端基线，不接受Definition或浏览器覆盖。
 * 64个语义节点可覆盖最大Planning Fixture（14节点、5轮审核预算）与Note，
 * 同时让最坏运行展开保持在256次以内；具体测量由Kernel基准测试记录。
 */
export const WORKFLOW_KERNEL_LIMITS = Object.freeze({
  request: {
    maxDefinitionBytes: 128 * 1024,
  },
  structure: {
    maxDepth: 12,
    maxNodes: 64,
    maxBranches: 24,
    maxLoops: 8,
    maxNestedLoops: 2,
    maxLoopIterations: 5,
  },
  runtime: {
    maxNodeExecutions: 256,
    maxCompositeChildren: 32,
    maxWaits: 16,
  },
  projection: {
    maxManifestSlots: 30,
    maxPreviewBytes: 16 * 1024,
  },
} as const);

export interface WorkflowStructureLimits {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxBranches: number;
  readonly maxLoops: number;
  readonly maxNestedLoops: number;
  readonly maxLoopIterations: number;
}

export type WorkflowDiagnosticFamily =
  "definition_invalid" | "policy_denied" | "resource_stale" | "limit_exceeded";

export interface WorkflowDiagnostic {
  readonly family: WorkflowDiagnosticFamily;
  readonly code: string;
  readonly path: string;
  /** 只能保存安全标量；不得把config正文或资源正文复制进诊断。 */
  readonly params: Readonly<Record<string, string | number | boolean>>;
}

export interface WorkflowStructureFacts {
  readonly nodeCount: number;
  readonly branchCount: number;
  readonly loopCount: number;
  readonly maxDepth: number;
  readonly maxLoopDepth: number;
  readonly maximumNodeExecutions: number;
}

export interface WorkflowStructureValidation {
  readonly facts: WorkflowStructureFacts;
  readonly diagnostics: readonly WorkflowDiagnostic[];
}

export interface WorkflowOutcomeLookup {
  outcomesFor(nodeType: WorkflowNodeTypeKey, schemaVersion: number): readonly string[] | undefined;
}

interface InventoryFrame {
  readonly element: WorkflowElement;
  readonly path: string;
  readonly depth: number;
  readonly loopDepth: number;
  readonly multiplier: number;
}

interface ScopeFrame {
  readonly sequence: WorkflowSequence;
  readonly path: string;
  readonly available: ReadonlySet<string>;
  readonly loopDepth: number;
}

/**
 * 显式栈结构校验：先计算全局预算与唯一身份，再验证每个Sequence的支配关系。
 * Choice/Loop内部节点不会泄漏到外层；无条件nested Sequence的节点会支配后续元素。
 */
export function validateWorkflowStructure(
  root: WorkflowSequence,
  lookup: WorkflowOutcomeLookup,
  limits: WorkflowStructureLimits = WORKFLOW_KERNEL_LIMITS.structure,
): WorkflowStructureValidation {
  const diagnostics: WorkflowDiagnostic[] = [];
  const nodeIds = new Set<string>();
  const nodeTypes = new Map<string, { nodeType: WorkflowNodeTypeKey; schemaVersion: number }>();
  let nodeCount = 0;
  let branchCount = 0;
  let loopCount = 0;
  let maxDepth = 0;
  let maxLoopDepth = 0;
  let maximumNodeExecutions = 0;

  const inventory: InventoryFrame[] = [
    { element: root, path: "$", depth: 1, loopDepth: 0, multiplier: 1 },
  ];
  while (inventory.length > 0) {
    const frame = inventory.pop();
    if (frame === undefined) break;
    maxDepth = Math.max(maxDepth, frame.depth);
    maxLoopDepth = Math.max(maxLoopDepth, frame.loopDepth);
    if (frame.depth > limits.maxDepth) {
      diagnostics.push(
        diagnostic("limit_exceeded", "definition.max_depth_exceeded", frame.path, {
          limit: limits.maxDepth,
          actual: frame.depth,
        }),
      );
      // 仍继续有限输入的其余遍历，以便给设计器稳定的多错误反馈。
    }
    const element = frame.element;
    if (element.kind === "task" || element.kind === "composite") {
      nodeCount += 1;
      maximumNodeExecutions += frame.multiplier;
      if (nodeIds.has(element.definitionNodeId)) {
        diagnostics.push(
          diagnostic("definition_invalid", "definition.duplicate_node_id", frame.path, {
            definitionNodeId: element.definitionNodeId,
          }),
        );
      } else {
        nodeIds.add(element.definitionNodeId);
        nodeTypes.set(element.definitionNodeId, {
          nodeType: element.nodeType,
          schemaVersion: element.schemaVersion,
        });
      }
      continue;
    }
    if (element.kind === "sequence") {
      for (let index = element.elements.length - 1; index >= 0; index -= 1) {
        const child = element.elements[index];
        if (child !== undefined) {
          inventory.push({
            element: child,
            path: `${frame.path}.elements[${String(index)}]`,
            depth: frame.depth + 1,
            loopDepth: frame.loopDepth,
            multiplier: frame.multiplier,
          });
        }
      }
      continue;
    }
    if (element.kind === "choice") {
      branchCount += element.branches.length;
      for (let index = element.branches.length - 1; index >= 0; index -= 1) {
        const branch = element.branches[index];
        if (branch !== undefined) {
          inventory.push({
            element: branch.body,
            path: `${frame.path}.branches[${String(index)}].body`,
            depth: frame.depth + 1,
            loopDepth: frame.loopDepth,
            // 最坏分支只会命中一个，不能把互斥分支相乘。
            multiplier: frame.multiplier,
          });
        }
      }
      continue;
    }
    loopCount += 1;
    const nextLoopDepth = frame.loopDepth + 1;
    maxLoopDepth = Math.max(maxLoopDepth, nextLoopDepth);
    inventory.push({
      element: element.body,
      path: `${frame.path}.body`,
      depth: frame.depth + 1,
      loopDepth: nextLoopDepth,
      multiplier: frame.multiplier * Math.max(element.maxIterations, 1),
    });
  }

  pushLimitDiagnostic(diagnostics, "definition.max_nodes_exceeded", nodeCount, limits.maxNodes);
  pushLimitDiagnostic(
    diagnostics,
    "definition.max_branches_exceeded",
    branchCount,
    limits.maxBranches,
  );
  pushLimitDiagnostic(diagnostics, "definition.max_loops_exceeded", loopCount, limits.maxLoops);
  pushLimitDiagnostic(
    diagnostics,
    "definition.max_loop_depth_exceeded",
    maxLoopDepth,
    limits.maxNestedLoops,
  );

  const scopes: ScopeFrame[] = [{ sequence: root, path: "$", available: new Set(), loopDepth: 0 }];
  while (scopes.length > 0) {
    const scope = scopes.pop();
    if (scope === undefined) break;
    const available = new Set(scope.available);
    for (let index = 0; index < scope.sequence.elements.length; index += 1) {
      const element = scope.sequence.elements[index];
      if (element === undefined) continue;
      const path = `${scope.path}.elements[${String(index)}]`;
      if (element.kind === "task" || element.kind === "composite") {
        available.add(element.definitionNodeId);
        continue;
      }
      if (element.kind === "sequence") {
        // nested sequence是无条件顺序分组，因此其顶层可见节点支配后续兄弟。
        scopes.push({
          sequence: element,
          path,
          available: new Set(available),
          loopDepth: scope.loopDepth,
        });
        for (const id of collectUnconditionalNodeIds(element)) available.add(id);
        continue;
      }
      if (element.kind === "choice") {
        validateControlSource(
          diagnostics,
          element.fromDefinitionNodeId,
          available,
          nodeTypes,
          path,
          "choice",
        );
        const source = nodeTypes.get(element.fromDefinitionNodeId);
        if (source !== undefined) {
          validateOutcomePartition(
            diagnostics,
            lookup.outcomesFor(source.nodeType, source.schemaVersion),
            element.branches.map((branch) => branch.outcome),
            path,
            "choice",
          );
        }
        for (let branchIndex = element.branches.length - 1; branchIndex >= 0; branchIndex -= 1) {
          const branch = element.branches[branchIndex];
          if (branch !== undefined) {
            scopes.push({
              sequence: branch.body,
              path: `${path}.branches[${String(branchIndex)}].body`,
              available: new Set(available),
              loopDepth: scope.loopDepth,
            });
          }
        }
        continue;
      }

      if (
        !Number.isInteger(element.maxIterations) ||
        element.maxIterations < 1 ||
        element.maxIterations > limits.maxLoopIterations
      ) {
        diagnostics.push(
          diagnostic("limit_exceeded", "definition.loop_iterations_invalid", path, {
            actual: element.maxIterations,
            limit: limits.maxLoopIterations,
          }),
        );
      }
      const bodyIds = collectUnconditionalNodeIds(element.body);
      const bodyAvailable = new Set([...available, ...bodyIds]);
      validateControlSource(
        diagnostics,
        element.outcomeFromDefinitionNodeId,
        bodyAvailable,
        nodeTypes,
        path,
        "loop",
      );
      if (!bodyIds.has(element.outcomeFromDefinitionNodeId)) {
        diagnostics.push(
          diagnostic("definition_invalid", "definition.loop_source_outside_body", path, {
            definitionNodeId: element.outcomeFromDefinitionNodeId,
          }),
        );
      }
      const source = nodeTypes.get(element.outcomeFromDefinitionNodeId);
      if (source !== undefined) {
        validateOutcomePartition(
          diagnostics,
          lookup.outcomesFor(source.nodeType, source.schemaVersion),
          [...element.continueOutcomes, ...element.exitOutcomes],
          path,
          "loop",
        );
      }
      const overlap = element.continueOutcomes.filter((outcome) =>
        element.exitOutcomes.includes(outcome),
      );
      if (overlap.length > 0) {
        diagnostics.push(
          diagnostic("definition_invalid", "definition.loop_outcome_overlap", path, {
            outcome: [...overlap].sort()[0] ?? "unknown",
          }),
        );
      }
      scopes.push({
        sequence: element.body,
        path: `${path}.body`,
        available: new Set(available),
        loopDepth: scope.loopDepth + 1,
      });
    }
  }

  return {
    facts: {
      nodeCount,
      branchCount,
      loopCount,
      maxDepth,
      maxLoopDepth,
      maximumNodeExecutions,
    },
    diagnostics,
  };
}

function collectUnconditionalNodeIds(sequence: WorkflowSequence): Set<string> {
  const result = new Set<string>();
  const stack: WorkflowElement[] = [...sequence.elements].reverse();
  while (stack.length > 0) {
    const element = stack.pop();
    if (element === undefined) break;
    if (element.kind === "task" || element.kind === "composite") {
      result.add(element.definitionNodeId);
    } else if (element.kind === "sequence") {
      for (let index = element.elements.length - 1; index >= 0; index -= 1) {
        const child = element.elements[index];
        if (child !== undefined) stack.push(child);
      }
    }
    // Choice与Loop的内部输出都不跨容器隐式合并。
  }
  return result;
}

function validateControlSource(
  diagnostics: WorkflowDiagnostic[],
  sourceId: string,
  available: ReadonlySet<string>,
  nodeTypes: ReadonlyMap<string, { nodeType: WorkflowNodeTypeKey; schemaVersion: number }>,
  path: string,
  control: "choice" | "loop",
): void {
  if (!nodeTypes.has(sourceId)) {
    diagnostics.push(
      diagnostic("definition_invalid", "definition.control_source_missing", path, {
        control,
        definitionNodeId: sourceId,
      }),
    );
  } else if (!available.has(sourceId)) {
    diagnostics.push(
      diagnostic("definition_invalid", "definition.control_source_not_dominating", path, {
        control,
        definitionNodeId: sourceId,
      }),
    );
  }
}

function validateOutcomePartition(
  diagnostics: WorkflowDiagnostic[],
  expected: readonly string[] | undefined,
  actual: readonly string[],
  path: string,
  control: "choice" | "loop",
): void {
  if (expected === undefined) return;
  const expectedSorted = [...new Set(expected)].sort();
  const actualSorted = [...new Set(actual)].sort();
  const duplicate = actual.length !== actualSorted.length;
  if (duplicate || expectedSorted.join("\0") !== actualSorted.join("\0")) {
    diagnostics.push(
      diagnostic("definition_invalid", "definition.outcome_partition_mismatch", path, {
        control,
        expectedCount: expectedSorted.length,
        actualCount: actualSorted.length,
        duplicate,
      }),
    );
  }
}

function pushLimitDiagnostic(
  diagnostics: WorkflowDiagnostic[],
  code: string,
  actual: number,
  limit: number,
): void {
  if (actual > limit) {
    diagnostics.push(diagnostic("limit_exceeded", code, "$", { actual, limit }));
  }
}

export function workflowDiagnosticSortKey(diagnostic: WorkflowDiagnostic): string {
  return `${diagnostic.path}\0${diagnostic.family}\0${diagnostic.code}`;
}

export function sortWorkflowDiagnostics(
  diagnostics: readonly WorkflowDiagnostic[],
): readonly WorkflowDiagnostic[] {
  return [...diagnostics].sort((left, right) =>
    workflowDiagnosticSortKey(left).localeCompare(workflowDiagnosticSortKey(right)),
  );
}

function diagnostic(
  family: WorkflowDiagnosticFamily,
  code: string,
  path: string,
  params: Readonly<Record<string, string | number | boolean>>,
): WorkflowDiagnostic {
  return { family, code, path, params };
}
