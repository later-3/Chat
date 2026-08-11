import { describe, expect, it } from "vitest";
import type { WorkflowCompositeElement, WorkflowSequence, WorkflowTaskElement } from "@chat/domain";
import { DEFAULT_WORKFLOW_BLUEPRINTS, type WorkflowBlueprint } from "./workflow-blueprints.js";
import { NOTE_SEQUENCE_ROOT, PLANNING_MIXED_ROOT } from "./workflow-kernel-fixtures.js";
import {
  applyWorkflowStructureOperation,
  type WorkflowDesignerPolicy,
} from "./workflow-structure-operations.js";

const noteBlueprint = requiredBlueprint("note");
const planningBlueprint = requiredBlueprint("planning");

const notePolicy: WorkflowDesignerPolicy = {
  blueprint: noteBlueprint,
  slots: [
    {
      slotId: "note.review",
      address: [],
      allowedNodeTypes: ["human.note_review"],
      minimumIndex: 2,
      maximumIndex: 2,
      maximumElements: 4,
    },
  ],
  allowedChoiceSourceTypes: ["note.classify"],
};

const planningPolicy: WorkflowDesignerPolicy = {
  blueprint: planningBlueprint,
  slots: [
    {
      slotId: "planning.root",
      address: [],
      allowedNodeTypes: [
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
      ],
      minimumIndex: 0,
      maximumIndex: 9,
    },
    {
      slotId: "planning.loop",
      address: [{ kind: "loop_body", outcomeFromDefinitionNodeId: "planning.review" }],
      allowedNodeTypes: ["agent.plan", "human.plan_review", "product.commit"],
      minimumIndex: 0,
      maximumIndex: 3,
    },
  ],
  allowedChoiceSourceTypes: ["human.plan_review"],
};

describe("Workflow Designer语义结构操作", () => {
  it("只在允许slot插入optional Task，保持原Definition不变并返回服务端Hash", () => {
    const original = structuredClone(NOTE_SEQUENCE_ROOT);
    const result = applyWorkflowStructureOperation(
      original,
      {
        kind: "insert_task",
        slotId: "note.review",
        index: 2,
        nodeType: "human.note_review",
        definitionNodeId: "note.review.custom",
      },
      notePolicy,
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(nodeIds(result.semanticRoot)).toEqual([
      "note.extract",
      "note.classify",
      "note.review.custom",
      "note.commit",
    ]);
    expect(result.definitionSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(original).toEqual(NOTE_SEQUENCE_ROOT);
  });

  it("拒绝插入required节点、错误slot、重复ID和超出drop zone", () => {
    const required = applyWorkflowStructureOperation(
      NOTE_SEQUENCE_ROOT,
      {
        kind: "insert_task",
        slotId: "note.review",
        index: 2,
        nodeType: "note.commit",
        definitionNodeId: "note.extra.commit",
      },
      notePolicy,
    );
    expect(firstCode(required)).toBe("designer.insert_requires_optional_node");

    const missingSlot = applyWorkflowStructureOperation(
      NOTE_SEQUENCE_ROOT,
      {
        kind: "insert_task",
        slotId: "unknown",
        index: 2,
        nodeType: "human.note_review",
        definitionNodeId: "note.review.custom",
      },
      notePolicy,
    );
    expect(firstCode(missingSlot)).toBe("designer.slot_not_found");

    const duplicate = applyWorkflowStructureOperation(
      NOTE_SEQUENCE_ROOT,
      {
        kind: "insert_task",
        slotId: "note.review",
        index: 2,
        nodeType: "human.note_review",
        definitionNodeId: "note.extract",
      },
      notePolicy,
    );
    expect(firstCode(duplicate)).toBe("designer.definition_node_id_exists");

    const outside = applyWorkflowStructureOperation(
      NOTE_SEQUENCE_ROOT,
      {
        kind: "insert_task",
        slotId: "note.review",
        index: 1,
        nodeType: "human.note_review",
        definitionNodeId: "note.review.custom",
      },
      notePolicy,
    );
    expect(firstCode(outside)).toBe("designer.target_index_out_of_slot");
  });

  it("required不能删除，optional删除和配置更新都重新完整校验", () => {
    const required = applyWorkflowStructureOperation(
      NOTE_SEQUENCE_ROOT,
      { kind: "remove_optional_task", target: { definitionNodeId: "note.commit" } },
      notePolicy,
    );
    expect(firstCode(required)).toBe("designer.required_node_cannot_be_removed");

    const withReview = expectSuccess(
      applyWorkflowStructureOperation(
        NOTE_SEQUENCE_ROOT,
        {
          kind: "insert_task",
          slotId: "note.review",
          index: 2,
          nodeType: "human.note_review",
          definitionNodeId: "note.review.custom",
        },
        notePolicy,
      ),
    );
    const removed = applyWorkflowStructureOperation(
      withReview.semanticRoot,
      {
        kind: "remove_optional_task",
        target: { definitionNodeId: "note.review.custom" },
      },
      notePolicy,
    );
    expect(expectSuccess(removed).semanticRoot).toEqual(
      expectSuccess(normalizedNote()).semanticRoot,
    );

    const invalidConfig = applyWorkflowStructureOperation(
      NOTE_SEQUENCE_ROOT,
      {
        kind: "update_node_config",
        target: { definitionNodeId: "note.extract" },
        fieldName: "maxCharacters",
        value: 20,
      },
      notePolicy,
    );
    expect(firstCode(invalidConfig)).toBe("designer.config_value_invalid");
  });

  it("默认skip只允许Catalog明确可跳节点，高影响审核不能用disabled绕过", () => {
    const skippedMemory = applyWorkflowStructureOperation(
      PLANNING_MIXED_ROOT,
      {
        kind: "set_default_activation",
        target: { definitionNodeId: "planning.memory" },
        activation: "skipped",
      },
      planningPolicy,
    );
    const memory = findTask(expectSuccess(skippedMemory).semanticRoot, "planning.memory");
    expect(memory?.defaultActivation).toBe("skipped");

    const review = applyWorkflowStructureOperation(
      PLANNING_MIXED_ROOT,
      {
        kind: "set_default_activation",
        target: { definitionNodeId: "planning.review" },
        activation: "skipped",
      },
      planningPolicy,
    );
    expect(firstCode(review)).toBe("designer.node_cannot_be_default_skipped");
  });

  it("Choice由Catalog枚举outcome，分支移动与无损unwrap不接受自由表达式", () => {
    const inserted = expectSuccess(
      applyWorkflowStructureOperation(
        NOTE_SEQUENCE_ROOT,
        {
          kind: "insert_task",
          slotId: "note.review",
          index: 2,
          nodeType: "human.note_review",
          definitionNodeId: "note.review.custom",
        },
        notePolicy,
      ),
    );
    const wrapped = expectSuccess(
      applyWorkflowStructureOperation(
        inserted.semanticRoot,
        { kind: "wrap_in_choice", fromDefinitionNodeId: "note.classify" },
        notePolicy,
      ),
    );
    expect(choiceOutcomes(wrapped.semanticRoot, "note.classify")).toEqual([
      "classified",
      "needs_review",
    ]);
    const branched = expectSuccess(
      applyWorkflowStructureOperation(
        wrapped.semanticRoot,
        {
          kind: "move_into_branch",
          target: { definitionNodeId: "note.review.custom" },
          fromDefinitionNodeId: "note.classify",
          outcome: "needs_review",
          index: 0,
        },
        notePolicy,
      ),
    );
    expect(branchNodeIds(branched.semanticRoot, "note.classify", "needs_review")).toEqual([
      "note.review.custom",
    ]);

    const lossy = applyWorkflowStructureOperation(
      branched.semanticRoot,
      {
        kind: "unwrap_choice",
        fromDefinitionNodeId: "note.classify",
        preserveOutcome: "classified",
      },
      notePolicy,
    );
    expect(firstCode(lossy)).toBe("designer.unwrap_would_discard_branch");

    const unwrapped = expectSuccess(
      applyWorkflowStructureOperation(
        branched.semanticRoot,
        {
          kind: "unwrap_choice",
          fromDefinitionNodeId: "note.classify",
          preserveOutcome: "needs_review",
        },
        notePolicy,
      ),
    );
    expect(nodeIds(unwrapped.semanticRoot)).toContain("note.review.custom");
  });

  it("BoundedLoop只按Blueprint outcome与上限包装、更新和展开", () => {
    const updated = expectSuccess(
      applyWorkflowStructureOperation(
        PLANNING_MIXED_ROOT,
        {
          kind: "update_loop_policy",
          outcomeFromDefinitionNodeId: "planning.review",
          maxIterations: 2,
          exceededPolicy: "fail",
        },
        planningPolicy,
      ),
    );
    expect(findLoop(updated.semanticRoot)?.maxIterations).toBe(2);

    const tooLarge = applyWorkflowStructureOperation(
      PLANNING_MIXED_ROOT,
      {
        kind: "update_loop_policy",
        outcomeFromDefinitionNodeId: "planning.review",
        maxIterations: 6,
        exceededPolicy: "request_human",
      },
      planningPolicy,
    );
    expect(firstCode(tooLarge)).toBe("designer.operation_contract_invalid");

    const flattened = expectSuccess(
      applyWorkflowStructureOperation(
        PLANNING_MIXED_ROOT,
        { kind: "unwrap_loop", outcomeFromDefinitionNodeId: "planning.review" },
        planningPolicy,
      ),
    );
    expect(findLoop(flattened.semanticRoot)).toBeUndefined();
    const rewrapped = expectSuccess(
      applyWorkflowStructureOperation(
        flattened.semanticRoot,
        {
          kind: "wrap_in_bounded_loop",
          address: [],
          startIndex: 5,
          endIndexExclusive: 7,
          outcomeFromDefinitionNodeId: "planning.review",
          maxIterations: 3,
          exceededPolicy: "request_human",
        },
        planningPolicy,
      ),
    );
    expect(findLoop(rewrapped.semanticRoot)?.maxIterations).toBe(3);
  });

  it("跨容器move保留节点身份，但破坏terminal不变量的移动原子拒绝", () => {
    const before = structuredClone(PLANNING_MIXED_ROOT);
    const invalid = applyWorkflowStructureOperation(
      before,
      {
        kind: "move_element",
        target: { definitionNodeId: "planning.commit" },
        slotId: "planning.loop",
        index: 0,
      },
      planningPolicy,
    );
    expect(invalid.success).toBe(false);
    if (!invalid.success) {
      expect(invalid.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
        "blueprint.terminal_commit_missing",
      );
    }
    expect(before).toEqual(PLANNING_MIXED_ROOT);
  });
});

function requiredBlueprint(key: "planning" | "note"): WorkflowBlueprint {
  const blueprint = DEFAULT_WORKFLOW_BLUEPRINTS.get(key, 1);
  if (blueprint === undefined) throw new Error(`missing blueprint:${key}`);
  return blueprint;
}

function expectSuccess(
  result: ReturnType<typeof applyWorkflowStructureOperation>,
): Extract<ReturnType<typeof applyWorkflowStructureOperation>, { success: true }> {
  expect(result.success).toBe(true);
  if (!result.success) throw new Error(result.diagnostics[0]?.code ?? "operation failed");
  return result;
}

function firstCode(result: ReturnType<typeof applyWorkflowStructureOperation>): string | undefined {
  return result.success ? undefined : result.diagnostics[0]?.code;
}

function normalizedNote(): ReturnType<typeof applyWorkflowStructureOperation> {
  return applyWorkflowStructureOperation(
    NOTE_SEQUENCE_ROOT,
    {
      kind: "update_node_config",
      target: { definitionNodeId: "note.extract" },
      fieldName: "maxCharacters",
      value: 4_000,
    },
    notePolicy,
  );
}

function nodeIds(root: WorkflowSequence): string[] {
  const ids: string[] = [];
  const stack = [...root.elements].reverse();
  while (stack.length > 0) {
    const element = stack.pop();
    if (element === undefined) break;
    if (element.kind === "task" || element.kind === "composite") ids.push(element.definitionNodeId);
    else if (element.kind === "sequence") stack.push(...[...element.elements].reverse());
    else if (element.kind === "bounded_loop") stack.push(...[...element.body.elements].reverse());
    else {
      for (const branch of [...element.branches].reverse()) {
        stack.push(...[...branch.body.elements].reverse());
      }
    }
  }
  return ids;
}

function findTask(
  root: WorkflowSequence,
  definitionNodeId: string,
): WorkflowTaskElement | WorkflowCompositeElement | undefined {
  const stack = [...root.elements];
  while (stack.length > 0) {
    const element = stack.shift();
    if (element === undefined) break;
    if (element.kind === "task" || element.kind === "composite") {
      if (element.definitionNodeId === definitionNodeId) return element;
    } else if (element.kind === "sequence") stack.push(...element.elements);
    else if (element.kind === "bounded_loop") stack.push(...element.body.elements);
    else for (const branch of element.branches) stack.push(...branch.body.elements);
  }
  return undefined;
}

function choiceOutcomes(root: WorkflowSequence, fromDefinitionNodeId: string): string[] {
  const choice = root.elements.find(
    (element) => element.kind === "choice" && element.fromDefinitionNodeId === fromDefinitionNodeId,
  );
  return choice?.kind === "choice" ? choice.branches.map((branch) => branch.outcome) : [];
}

function branchNodeIds(
  root: WorkflowSequence,
  fromDefinitionNodeId: string,
  outcome: string,
): string[] {
  const choice = root.elements.find(
    (element) => element.kind === "choice" && element.fromDefinitionNodeId === fromDefinitionNodeId,
  );
  if (choice?.kind !== "choice") return [];
  const branch = choice.branches.find((candidate) => candidate.outcome === outcome);
  return branch === undefined ? [] : nodeIds(branch.body);
}

function findLoop(root: WorkflowSequence) {
  return root.elements.find((element) => element.kind === "bounded_loop");
}
