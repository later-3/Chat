import { describe, expect, it } from "vitest";
import type { WorkflowSequence } from "./workflow-definition-kernel.js";
import {
  applyWorkflowDesignerOperation,
  type WorkflowDesignerOperationPolicyShape,
} from "./workflow-designer-operations.js";

const ROOT: WorkflowSequence = {
  kind: "sequence",
  elements: [
    task("memory", "context.memory", { required: false }, "enabled"),
    task("plan", "agent.plan", { maxSteps: 8 }),
    task("review", "human.plan_review", { reviewMode: "manual" }),
    task("commit", "product.commit", {}),
  ],
};

const POLICY: WorkflowDesignerOperationPolicyShape = {
  slots: [
    {
      slotId: "planning.context",
      address: [],
      allowedNodeTypes: ["context.memory", "agent.research"],
      minimumIndex: 0,
      maximumIndex: 2,
      maximumElements: 8,
    },
  ],
  nodes: [
    {
      nodeType: "context.memory",
      schemaVersion: 1,
      executorKind: "step",
      defaultConfig: { required: false },
      publicConfigFields: [{ type: "boolean", name: "required" }],
      outcomes: ["success", "optional_unavailable", "required_unavailable"],
      skipPolicyKind: "allowed_with_default_outcome",
    },
    {
      nodeType: "agent.research",
      schemaVersion: 1,
      executorKind: "step",
      defaultConfig: { maxSources: 8 },
      publicConfigFields: [
        { type: "bounded_integer", name: "maxSources", minimum: 1, maximum: 20 },
      ],
      outcomes: ["researched", "no_evidence"],
      skipPolicyKind: "allowed_with_default_outcome",
    },
    {
      nodeType: "agent.plan",
      schemaVersion: 1,
      executorKind: "step",
      defaultConfig: { maxSteps: 8 },
      publicConfigFields: [{ type: "bounded_integer", name: "maxSteps", minimum: 1, maximum: 20 }],
      outcomes: ["planned", "needs_input"],
      skipPolicyKind: "never",
    },
    {
      nodeType: "human.plan_review",
      schemaVersion: 1,
      executorKind: "human_review",
      defaultConfig: { reviewMode: "manual" },
      publicConfigFields: [
        { type: "review_mode", name: "reviewMode", options: ["manual", "always_auto"] },
      ],
      outcomes: ["approved", "request_revision", "rejected"],
      skipPolicyKind: "never",
    },
    {
      nodeType: "product.commit",
      schemaVersion: 1,
      executorKind: "step",
      defaultConfig: {},
      publicConfigFields: [],
      outcomes: ["committed", "failed"],
      skipPolicyKind: "never",
    },
  ],
  optionalNodeTypes: ["context.memory", "agent.research"],
  allowedChoiceSourceTypes: ["human.plan_review"],
  loopRules: [
    {
      outcomeNodeType: "human.plan_review",
      continueOutcomes: ["request_revision"],
      exitOutcomes: ["approved", "rejected"],
      maxIterations: 5,
    },
  ],
};

describe("Workflow Designer共享纯结构操作", () => {
  it("按Catalog默认值插入可选节点，并保持输入不可变", () => {
    const before = structuredClone(ROOT);
    const result = applyWorkflowDesignerOperation(
      ROOT,
      {
        kind: "insert_task",
        slotId: "planning.context",
        index: 1,
        nodeType: "agent.research",
        definitionNodeId: "research",
      },
      POLICY,
    );
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.semanticRoot.elements[1]).toMatchObject({
      kind: "task",
      definitionNodeId: "research",
      config: { maxSources: 8 },
      defaultActivation: "enabled",
    });
    expect(ROOT).toEqual(before);
  });

  it("Choice只生成Catalog固定分支，支持稳定ID移入与无损展开", () => {
    const wrapped = success(
      applyWorkflowDesignerOperation(
        ROOT,
        { kind: "wrap_in_choice", fromDefinitionNodeId: "review" },
        POLICY,
      ),
    );
    expect(findChoice(wrapped, "review")?.branches.map((branch) => branch.outcome)).toEqual([
      "approved",
      "rejected",
      "request_revision",
    ]);
    const moved = success(
      applyWorkflowDesignerOperation(
        wrapped,
        {
          kind: "move_into_branch",
          target: { definitionNodeId: "memory" },
          fromDefinitionNodeId: "review",
          outcome: "approved",
          index: 0,
        },
        POLICY,
      ),
    );
    expect(findChoice(moved, "review")?.branches[0]?.body.elements[0]).toMatchObject({
      definitionNodeId: "memory",
    });
    expect(
      applyWorkflowDesignerOperation(
        moved,
        { kind: "unwrap_choice", fromDefinitionNodeId: "review", preserveOutcome: "rejected" },
        POLICY,
      ),
    ).toEqual({ ok: false, code: "unwrap_would_discard_branch" });
    const unwrapped = success(
      applyWorkflowDesignerOperation(
        moved,
        { kind: "unwrap_choice", fromDefinitionNodeId: "review", preserveOutcome: "approved" },
        POLICY,
      ),
    );
    expect(findChoice(unwrapped, "review")).toBeUndefined();
    expect(nodeIds(unwrapped)).toContain("memory");
  });

  it("BoundedLoop只能包装包含outcome源的范围，并服从Blueprint上限", () => {
    expect(
      applyWorkflowDesignerOperation(
        ROOT,
        {
          kind: "wrap_in_bounded_loop",
          address: [],
          startIndex: 0,
          endIndexExclusive: 2,
          outcomeFromDefinitionNodeId: "review",
          maxIterations: 2,
          exceededPolicy: "fail",
        },
        POLICY,
      ),
    ).toEqual({ ok: false, code: "loop_source_outside_range" });

    const wrapped = success(
      applyWorkflowDesignerOperation(
        ROOT,
        {
          kind: "wrap_in_bounded_loop",
          address: [],
          startIndex: 1,
          endIndexExclusive: 3,
          outcomeFromDefinitionNodeId: "review",
          maxIterations: 2,
          exceededPolicy: "request_human",
        },
        POLICY,
      ),
    );
    expect(findLoop(wrapped, "review")).toMatchObject({
      maxIterations: 2,
      continueOutcomes: ["request_revision"],
      exitOutcomes: ["approved", "rejected"],
    });
    expect(
      applyWorkflowDesignerOperation(
        wrapped,
        {
          kind: "update_loop_policy",
          outcomeFromDefinitionNodeId: "review",
          maxIterations: 6,
          exceededPolicy: "fail",
        },
        POLICY,
      ),
    ).toEqual({ ok: false, code: "loop_policy_invalid" });
    const unwrapped = success(
      applyWorkflowDesignerOperation(
        wrapped,
        { kind: "unwrap_loop", outcomeFromDefinitionNodeId: "review" },
        POLICY,
      ),
    );
    expect(findLoop(unwrapped, "review")).toBeUndefined();
    expect(nodeIds(unwrapped)).toEqual(["memory", "plan", "review", "commit"]);
  });

  it("配置、skip和结构身份都由共享policy限制", () => {
    expect(
      applyWorkflowDesignerOperation(
        ROOT,
        {
          kind: "update_node_config",
          target: { definitionNodeId: "plan" },
          fieldName: "maxSteps",
          value: 21,
        },
        POLICY,
      ),
    ).toEqual({ ok: false, code: "config_value_invalid" });
    expect(
      applyWorkflowDesignerOperation(
        ROOT,
        {
          kind: "set_default_activation",
          target: { definitionNodeId: "review" },
          activation: "skipped",
        },
        POLICY,
      ),
    ).toEqual({ ok: false, code: "required_node_change_denied" });
    expect(
      applyWorkflowDesignerOperation(
        ROOT,
        {
          kind: "insert_task",
          slotId: "planning.context",
          index: 1,
          nodeType: "agent.research",
          definitionNodeId: "memory",
        },
        POLICY,
      ),
    ).toEqual({ ok: false, code: "definition_node_id_duplicate" });
  });
});

function task(
  definitionNodeId: string,
  nodeType: "context.memory" | "agent.plan" | "human.plan_review" | "product.commit",
  config: Readonly<Record<string, unknown>>,
  defaultActivation?: "enabled" | "skipped",
) {
  return {
    kind: "task" as const,
    definitionNodeId,
    nodeType,
    schemaVersion: 1,
    config,
    ...(defaultActivation === undefined ? {} : { defaultActivation }),
  };
}

function success(result: ReturnType<typeof applyWorkflowDesignerOperation>): WorkflowSequence {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.code);
  return result.semanticRoot;
}

function findChoice(root: WorkflowSequence, fromDefinitionNodeId: string) {
  const stack = [...root.elements];
  while (stack.length > 0) {
    const element = stack.pop();
    if (element === undefined) continue;
    if (element.kind === "choice" && element.fromDefinitionNodeId === fromDefinitionNodeId) {
      return element;
    }
    if (element.kind === "sequence") stack.push(...element.elements);
    else if (element.kind === "choice") {
      for (const branch of element.branches) stack.push(...branch.body.elements);
    } else if (element.kind === "bounded_loop") stack.push(...element.body.elements);
  }
  return undefined;
}

function findLoop(root: WorkflowSequence, outcomeFromDefinitionNodeId: string) {
  const stack = [...root.elements];
  while (stack.length > 0) {
    const element = stack.pop();
    if (element === undefined) continue;
    if (
      element.kind === "bounded_loop" &&
      element.outcomeFromDefinitionNodeId === outcomeFromDefinitionNodeId
    ) {
      return element;
    }
    if (element.kind === "sequence") stack.push(...element.elements);
    else if (element.kind === "choice") {
      for (const branch of element.branches) stack.push(...branch.body.elements);
    } else if (element.kind === "bounded_loop") stack.push(...element.body.elements);
  }
  return undefined;
}

function nodeIds(root: WorkflowSequence): string[] {
  const ids: string[] = [];
  const stack = [...root.elements].reverse();
  while (stack.length > 0) {
    const element = stack.pop();
    if (element === undefined) continue;
    if (element.kind === "task" || element.kind === "composite") ids.push(element.definitionNodeId);
    else if (element.kind === "sequence") stack.push(...[...element.elements].reverse());
    else if (element.kind === "choice") {
      for (const branch of [...element.branches].reverse()) {
        stack.push(...[...branch.body.elements].reverse());
      }
    } else stack.push(...[...element.body.elements].reverse());
  }
  return ids;
}
