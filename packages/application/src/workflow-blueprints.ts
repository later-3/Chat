import {
  sortWorkflowDiagnostics,
  workflowRiskAtLeast,
  type WorkflowDiagnostic,
  type WorkflowNodeTypeKey,
  type WorkflowRiskLevel,
  type WorkflowSequence,
} from "@chat/domain";
import {
  DEFAULT_NODE_CATALOG,
  type NodeCatalog,
  type NodeCatalogDescriptor,
} from "./workflow-node-catalog.js";

export type WorkflowBlueprintKey = "planning" | "note" | "direct";

export interface WorkflowRequiredRole {
  readonly role: string;
  readonly nodeType: WorkflowNodeTypeKey;
  readonly exactlyOnce: boolean;
}

export interface WorkflowLoopRule {
  readonly outcomeNodeType: WorkflowNodeTypeKey;
  readonly continueOutcomes: readonly string[];
  readonly exitOutcomes: readonly string[];
  readonly maxIterations: number;
}

export interface WorkflowRunOverrideRule {
  readonly nodeType: WorkflowNodeTypeKey;
  readonly fields: readonly ("enabled" | "selection" | "reviewMode")[];
  /** 具体节点config字段；字段本身仍必须由Node Catalog公开并通过其Schema。 */
  readonly configFields?: readonly string[];
}

export interface WorkflowBlueprint {
  readonly blueprintKey: WorkflowBlueprintKey;
  readonly blueprintVersion: number;
  readonly runnerFamily: "configurable-planning.v1" | "note-capture.v1" | "direct-agent.v1";
  readonly allowedNodeTypes: readonly WorkflowNodeTypeKey[];
  readonly optionalNodeTypes: readonly WorkflowNodeTypeKey[];
  readonly repeatableNodeTypes: readonly {
    readonly nodeType: WorkflowNodeTypeKey;
    readonly maxCount: number;
  }[];
  readonly requiredRoles: readonly WorkflowRequiredRole[];
  readonly loopRules: readonly WorkflowLoopRule[];
  readonly perRunOverrides: readonly WorkflowRunOverrideRule[];
  readonly immutableMinimumRisk: Readonly<Partial<Record<WorkflowNodeTypeKey, WorkflowRiskLevel>>>;
  readonly mandatoryManualReviewTypes: readonly WorkflowNodeTypeKey[];
  readonly terminalNodeType: WorkflowNodeTypeKey;
}

export class WorkflowBlueprintRegistry {
  readonly #byKey: ReadonlyMap<string, WorkflowBlueprint>;

  constructor(blueprints: readonly WorkflowBlueprint[], catalog: NodeCatalog) {
    const byKey = new Map<string, WorkflowBlueprint>();
    for (const blueprint of blueprints) {
      const key = workflowBlueprintRef(blueprint.blueprintKey, blueprint.blueprintVersion);
      if (byKey.has(key)) throw new Error(`workflow.blueprint.duplicate_key:${key}`);
      assertBlueprintConformance(blueprint, catalog);
      byKey.set(key, blueprint);
    }
    this.#byKey = byKey;
  }

  get(key: WorkflowBlueprintKey, version: number): WorkflowBlueprint | undefined {
    return this.#byKey.get(workflowBlueprintRef(key, version));
  }

  list(): readonly WorkflowBlueprint[] {
    return [...this.#byKey.values()].sort((left, right) =>
      workflowBlueprintRef(left.blueprintKey, left.blueprintVersion).localeCompare(
        workflowBlueprintRef(right.blueprintKey, right.blueprintVersion),
      ),
    );
  }
}

export function workflowBlueprintRef(key: WorkflowBlueprintKey, version: number): string {
  return `${key}@${String(version)}`;
}

const PLANNING_NODE_TYPES: readonly WorkflowNodeTypeKey[] = [
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
];

const NOTE_NODE_TYPES: readonly WorkflowNodeTypeKey[] = [
  "note.extract",
  "note.classify",
  "human.note_review",
  "note.commit",
];

const DIRECT_NODE_TYPES: readonly WorkflowNodeTypeKey[] = ["agent.direct"];

export const WORKFLOW_BLUEPRINTS: readonly WorkflowBlueprint[] = [
  {
    blueprintKey: "planning",
    blueprintVersion: 1,
    runnerFamily: "configurable-planning.v1",
    allowedNodeTypes: PLANNING_NODE_TYPES,
    optionalNodeTypes: [
      "memory.query",
      "context.memory",
      "context.project",
      "policy.rules",
      "capability.skills",
    ],
    repeatableNodeTypes: [{ nodeType: "memory.query", maxCount: 8 }],
    requiredRoles: [
      { role: "planner", nodeType: "agent.plan", exactlyOnce: true },
      { role: "plan_reviewer", nodeType: "human.plan_review", exactlyOnce: true },
      { role: "executor", nodeType: "execute.plan", exactlyOnce: true },
      { role: "validator", nodeType: "result.validate", exactlyOnce: true },
      { role: "terminal_commit", nodeType: "product.commit", exactlyOnce: true },
    ],
    loopRules: [
      {
        outcomeNodeType: "human.plan_review",
        continueOutcomes: ["request_revision"],
        exitOutcomes: ["approved", "rejected"],
        maxIterations: 5,
      },
    ],
    perRunOverrides: [
      { nodeType: "memory.query", fields: ["enabled"] },
      { nodeType: "context.memory", fields: ["enabled", "selection"] },
      { nodeType: "context.project", fields: ["enabled", "selection"] },
      { nodeType: "policy.rules", fields: ["enabled", "selection"] },
      { nodeType: "capability.skills", fields: ["enabled", "selection"] },
    ],
    immutableMinimumRisk: {
      "human.plan_review": "human_decision",
      "execute.plan": "external_effect",
      "product.commit": "product_commit",
    },
    mandatoryManualReviewTypes: ["human.plan_review"],
    terminalNodeType: "product.commit",
  },
  {
    blueprintKey: "note",
    blueprintVersion: 1,
    runnerFamily: "note-capture.v1",
    allowedNodeTypes: NOTE_NODE_TYPES,
    optionalNodeTypes: ["human.note_review"],
    repeatableNodeTypes: [],
    requiredRoles: [
      { role: "extractor", nodeType: "note.extract", exactlyOnce: true },
      { role: "classifier", nodeType: "note.classify", exactlyOnce: true },
      { role: "terminal_commit", nodeType: "note.commit", exactlyOnce: true },
    ],
    loopRules: [
      {
        outcomeNodeType: "human.note_review",
        continueOutcomes: ["request_revision"],
        exitOutcomes: ["approved", "rejected"],
        maxIterations: 2,
      },
    ],
    perRunOverrides: [{ nodeType: "human.note_review", fields: ["reviewMode"] }],
    immutableMinimumRisk: {
      "human.note_review": "human_decision",
      "note.commit": "product_commit",
    },
    mandatoryManualReviewTypes: [],
    terminalNodeType: "note.commit",
  },
  {
    blueprintKey: "direct",
    blueprintVersion: 1,
    runnerFamily: "direct-agent.v1",
    allowedNodeTypes: DIRECT_NODE_TYPES,
    optionalNodeTypes: [],
    repeatableNodeTypes: [],
    requiredRoles: [{ role: "direct_agent", nodeType: "agent.direct", exactlyOnce: true }],
    // Prompt Review是Execution Agent节点内部的Provider Gate状态，不是第二个业务节点。
    loopRules: [],
    perRunOverrides: [{ nodeType: "agent.direct", fields: [], configFields: ["promptReviewMode"] }],
    immutableMinimumRisk: {
      "agent.direct": "generate_candidate",
    },
    mandatoryManualReviewTypes: [],
    // Direct流程没有独立product.commit图节点；Agent完成候选后仍由Application提交正式Message。
    // 结构终点就是唯一的agent.direct；审核等待与恢复均投影为该NodeRun的内部状态。
    terminalNodeType: "agent.direct",
  },
] satisfies readonly WorkflowBlueprint[];

export const DEFAULT_WORKFLOW_BLUEPRINTS = new WorkflowBlueprintRegistry(
  WORKFLOW_BLUEPRINTS,
  DEFAULT_NODE_CATALOG,
);

export function validateDefinitionAgainstBlueprint(
  root: WorkflowSequence,
  blueprint: WorkflowBlueprint,
  catalog: NodeCatalog,
): readonly WorkflowDiagnostic[] {
  const diagnostics: WorkflowDiagnostic[] = [];
  const nodes: {
    readonly nodeType: WorkflowNodeTypeKey;
    readonly path: string;
    readonly config: Readonly<Record<string, unknown>>;
  }[] = [];
  const loops: {
    readonly outcomeNodeId: string;
    readonly continueOutcomes: readonly string[];
    readonly exitOutcomes: readonly string[];
    readonly maxIterations: number;
    readonly path: string;
  }[] = [];
  const typeById = new Map<string, WorkflowNodeTypeKey>();
  const stack: {
    readonly element: WorkflowSequence["elements"][number] | WorkflowSequence;
    readonly path: string;
  }[] = [{ element: root, path: "$" }];
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) break;
    const element = frame.element;
    if (element.kind === "task" || element.kind === "composite") {
      nodes.push({ nodeType: element.nodeType, path: frame.path, config: element.config });
      typeById.set(element.definitionNodeId, element.nodeType);
      if (!blueprint.allowedNodeTypes.includes(element.nodeType)) {
        diagnostics.push(
          invalid("blueprint.node_type_not_allowed", frame.path, { nodeType: element.nodeType }),
        );
      }
      const descriptor = catalog.get(element.nodeType, element.schemaVersion);
      if (
        descriptor === undefined ||
        !descriptor.supportedBlueprints.includes(blueprint.blueprintKey)
      ) {
        diagnostics.push(
          invalid("blueprint.node_version_not_supported", frame.path, {
            nodeType: element.nodeType,
            schemaVersion: element.schemaVersion,
          }),
        );
      }
      continue;
    }
    if (element.kind === "sequence") {
      for (let index = element.elements.length - 1; index >= 0; index -= 1) {
        const child = element.elements[index];
        if (child !== undefined)
          stack.push({ element: child, path: `${frame.path}.elements[${String(index)}]` });
      }
      continue;
    }
    if (element.kind === "choice") {
      for (let index = element.branches.length - 1; index >= 0; index -= 1) {
        const branch = element.branches[index];
        if (branch !== undefined)
          stack.push({
            element: branch.body,
            path: `${frame.path}.branches[${String(index)}].body`,
          });
      }
      continue;
    }
    loops.push({
      outcomeNodeId: element.outcomeFromDefinitionNodeId,
      continueOutcomes: element.continueOutcomes,
      exitOutcomes: element.exitOutcomes,
      maxIterations: element.maxIterations,
      path: frame.path,
    });
    stack.push({ element: element.body, path: `${frame.path}.body` });
  }

  for (const role of blueprint.requiredRoles) {
    const count = nodes.filter((node) => node.nodeType === role.nodeType).length;
    if (count === 0 || (role.exactlyOnce && count !== 1)) {
      diagnostics.push(
        invalid("blueprint.required_role_mismatch", "$", { role: role.role, count }),
      );
    }
  }
  for (const nodeType of blueprint.optionalNodeTypes) {
    const count = nodes.filter((node) => node.nodeType === nodeType).length;
    const repeatable = blueprint.repeatableNodeTypes.find(
      (candidate) => candidate.nodeType === nodeType,
    );
    const maxCount = repeatable?.maxCount ?? 1;
    if (count > maxCount) {
      diagnostics.push(invalid("blueprint.optional_node_duplicated", "$", { nodeType, count }));
    }
  }
  for (const node of nodes) {
    if (
      blueprint.mandatoryManualReviewTypes.includes(node.nodeType) &&
      node.config["reviewMode"] !== undefined &&
      node.config["reviewMode"] !== "manual"
    ) {
      diagnostics.push(
        invalid("blueprint.mandatory_manual_review", node.path, { nodeType: node.nodeType }),
      );
    }
  }
  for (const loop of loops) {
    const sourceType = typeById.get(loop.outcomeNodeId);
    const rule = blueprint.loopRules.find((candidate) => candidate.outcomeNodeType === sourceType);
    if (
      rule === undefined ||
      loop.maxIterations > rule.maxIterations ||
      !sameSet(loop.continueOutcomes, rule.continueOutcomes) ||
      !sameSet(loop.exitOutcomes, rule.exitOutcomes)
    ) {
      diagnostics.push(
        invalid("blueprint.loop_not_allowed", loop.path, {
          outcomeNodeType: sourceType ?? "unknown",
        }),
      );
    }
  }
  const terminal = lastTopLevelNodeType(root);
  if (terminal !== blueprint.terminalNodeType) {
    diagnostics.push(
      invalid("blueprint.terminal_commit_missing", "$", {
        expectedNodeType: blueprint.terminalNodeType,
      }),
    );
  }
  return sortWorkflowDiagnostics(diagnostics);
}

function assertBlueprintConformance(blueprint: WorkflowBlueprint, catalog: NodeCatalog): void {
  if (!Number.isInteger(blueprint.blueprintVersion) || blueprint.blueprintVersion < 1) {
    throw new Error(`workflow.blueprint.invalid_version:${blueprint.blueprintKey}`);
  }
  if (new Set(blueprint.allowedNodeTypes).size !== blueprint.allowedNodeTypes.length) {
    throw new Error(`workflow.blueprint.duplicate_allowed_type:${blueprint.blueprintKey}`);
  }
  for (const repeatable of blueprint.repeatableNodeTypes) {
    if (
      !blueprint.optionalNodeTypes.includes(repeatable.nodeType) ||
      !Number.isInteger(repeatable.maxCount) ||
      repeatable.maxCount < 2
    ) {
      throw new Error(
        `workflow.blueprint.invalid_repeatable_type:${blueprint.blueprintKey}:${repeatable.nodeType}`,
      );
    }
  }
  const roles = new Set<string>();
  for (const role of blueprint.requiredRoles) {
    if (roles.has(role.role))
      throw new Error(`workflow.blueprint.duplicate_role:${blueprint.blueprintKey}:${role.role}`);
    roles.add(role.role);
    assertCatalogSupport(blueprint, role.nodeType, catalog);
  }
  for (const nodeType of blueprint.allowedNodeTypes)
    assertCatalogSupport(blueprint, nodeType, catalog);
  if (!blueprint.allowedNodeTypes.includes(blueprint.terminalNodeType)) {
    throw new Error(`workflow.blueprint.terminal_not_allowed:${blueprint.blueprintKey}`);
  }
  for (const [nodeType, minimum] of Object.entries(blueprint.immutableMinimumRisk)) {
    const descriptor = catalog.get(nodeType as WorkflowNodeTypeKey, 1);
    if (descriptor === undefined || !workflowRiskAtLeast(descriptor.riskPolicy, minimum)) {
      throw new Error(`workflow.blueprint.risk_lowered:${blueprint.blueprintKey}:${nodeType}`);
    }
  }
  for (const rule of blueprint.perRunOverrides) {
    const descriptor = catalog.get(rule.nodeType, 1);
    if (descriptor === undefined)
      throw new Error(`workflow.blueprint.override_unknown_type:${rule.nodeType}`);
    const publicNames = new Set(descriptor.publicConfigFields.map((field) => field.name));
    for (const field of rule.fields) {
      const projectedName =
        field === "enabled" ? undefined : field === "selection" ? "selection" : "reviewMode";
      if (projectedName !== undefined && !publicNames.has(projectedName)) {
        throw new Error(`workflow.blueprint.override_not_public:${rule.nodeType}:${field}`);
      }
    }
    for (const field of rule.configFields ?? []) {
      if (!publicNames.has(field)) {
        throw new Error(`workflow.blueprint.override_not_public:${rule.nodeType}:${field}`);
      }
    }
    if (rule.fields.length === 0 && (rule.configFields?.length ?? 0) === 0) {
      throw new Error(`workflow.blueprint.override_fields_empty:${rule.nodeType}`);
    }
  }
}

function assertCatalogSupport(
  blueprint: WorkflowBlueprint,
  nodeType: WorkflowNodeTypeKey,
  catalog: NodeCatalog,
): NodeCatalogDescriptor {
  const descriptor = catalog.get(nodeType, 1);
  if (
    descriptor === undefined ||
    !descriptor.supportedBlueprints.includes(blueprint.blueprintKey)
  ) {
    throw new Error(`workflow.blueprint.catalog_mismatch:${blueprint.blueprintKey}:${nodeType}`);
  }
  return descriptor;
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return [...new Set(left)].sort().join("\0") === [...new Set(right)].sort().join("\0");
}

function lastTopLevelNodeType(root: WorkflowSequence): WorkflowNodeTypeKey | undefined {
  const stack = [...root.elements].reverse();
  while (stack.length > 0) {
    const element = stack.shift();
    if (element === undefined) break;
    if (element.kind === "task" || element.kind === "composite") return element.nodeType;
    if (element.kind === "sequence") stack.unshift(...[...element.elements].reverse());
    if (element.kind === "bounded_loop") {
      // Loop本身是顶层终点时，以控制其正常退出的叶子节点作为结构终点。
      // Direct Agent的审核分支可能提前返回reject终态，但正常完成只由agent.direct产生。
      return nodeTypeById(element.body, element.outcomeFromDefinitionNodeId);
    }
  }
  return undefined;
}

function nodeTypeById(
  root: WorkflowSequence,
  definitionNodeId: string,
): WorkflowNodeTypeKey | undefined {
  const stack = [...root.elements];
  while (stack.length > 0) {
    const element = stack.pop();
    if (element === undefined) break;
    if (element.kind === "task" || element.kind === "composite") {
      if (element.definitionNodeId === definitionNodeId) return element.nodeType;
    } else if (element.kind === "sequence") {
      stack.push(...element.elements);
    } else if (element.kind === "choice") {
      for (const branch of element.branches) stack.push(...branch.body.elements);
    } else {
      stack.push(...element.body.elements);
    }
  }
  return undefined;
}

function invalid(
  code: string,
  path: string,
  params: Readonly<Record<string, string | number | boolean>>,
): WorkflowDiagnostic {
  return { family: "definition_invalid", code, path, params };
}
