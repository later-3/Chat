import { describe, expect, it } from "vitest";
import type { WorkflowSequence, WorkflowTaskElement } from "@chat/domain";
import { DEFAULT_WORKFLOW_BLUEPRINTS } from "./workflow-blueprints.js";
import {
  applyWorkflowDesignerOperation,
  initializeWorkflowDesignerHistory,
  reapplyWorkflowOperations,
  redoWorkflowDesignerOperation,
  undoWorkflowDesignerOperation,
  workflowDesignerIsDirty,
  workflowDesignerOperationLog,
} from "./workflow-designer-history.js";
import { NOTE_SEQUENCE_ROOT } from "./workflow-kernel-fixtures.js";
import type { WorkflowDesignerPolicy } from "./workflow-structure-operations.js";

const blueprint = DEFAULT_WORKFLOW_BLUEPRINTS.get("note", 1);
if (blueprint === undefined) throw new Error("note blueprint missing");

const policy: WorkflowDesignerPolicy = {
  blueprint,
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

const insertReview = {
  kind: "insert_task",
  slotId: "note.review",
  index: 2,
  definitionNodeId: "note.review.local",
  nodeType: "human.note_review",
} as const;

describe("Workflow Designer本地语义History与CAS重放", () => {
  it("undo/redo只改变语义版本，dirty由规范Hash决定", () => {
    const initialized = initializeWorkflowDesignerHistory(NOTE_SEQUENCE_ROOT, policy);
    expect(initialized.success).toBe(true);
    if (!initialized.success) return;
    expect(workflowDesignerIsDirty(initialized.history)).toBe(false);

    const applied = applyWorkflowDesignerOperation(initialized.history, insertReview, policy);
    expect(applied.success).toBe(true);
    if (!applied.success) return;
    expect(workflowDesignerIsDirty(applied.history)).toBe(true);
    expect(workflowDesignerOperationLog(applied.history)).toEqual([insertReview]);

    const undone = undoWorkflowDesignerOperation(applied.history);
    expect(undone.current.definitionSha256).toBe(undone.base.definitionSha256);
    expect(workflowDesignerIsDirty(undone)).toBe(false);
    expect(workflowDesignerOperationLog(undone)).toEqual([]);

    const redone = redoWorkflowDesignerOperation(undone);
    expect(redone.current.definitionSha256).toBe(applied.history.current.definitionSha256);
    expect(workflowDesignerOperationLog(redone)).toEqual([insertReview]);
  });

  it("undo后新操作清除redo分支且不修改旧History引用", () => {
    const initialized = initializeWorkflowDesignerHistory(NOTE_SEQUENCE_ROOT, policy);
    if (!initialized.success) throw new Error("init failed");
    const applied = applyWorkflowDesignerOperation(initialized.history, insertReview, policy);
    if (!applied.success) throw new Error("insert failed");
    const undone = undoWorkflowDesignerOperation(applied.history);
    const changed = applyWorkflowDesignerOperation(
      undone,
      {
        kind: "update_node_config",
        target: { definitionNodeId: "note.extract" },
        fieldName: "maxCharacters",
        value: 2_000,
      },
      policy,
    );
    expect(changed.success).toBe(true);
    if (!changed.success) return;
    expect(changed.history.future).toEqual([]);
    expect(undone.future).toHaveLength(1);
    expect(readConfig(changed.history.current.semanticRoot, "note.extract")).toEqual({
      maxCharacters: 2_000,
      defaultKind: "general",
      suggestedTagLabels: [],
    });
  });

  it("CAS新基线按顺序重放语义操作，互不冲突变化可合并", () => {
    const serverBase = updateTaskConfig(NOTE_SEQUENCE_ROOT, "note.classify", {
      allowCustomTags: false,
    });
    const operations = [
      {
        kind: "update_node_config",
        target: { definitionNodeId: "note.extract" },
        fieldName: "maxCharacters",
        value: 2_000,
      },
      insertReview,
    ] as const;
    const result = reapplyWorkflowOperations(serverBase, operations, () => policy);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.appliedOperations).toHaveLength(2);
    expect(readConfig(result.version.semanticRoot, "note.classify")).toEqual({
      allowCustomTags: false,
    });
    expect(readConfig(result.version.semanticRoot, "note.extract")).toEqual({
      maxCharacters: 2_000,
      defaultKind: "general",
      suggestedTagLabels: [],
    });
  });

  it("CAS遇到已删除节点立即停止，返回最后合法版本而非JSON猜测合并", () => {
    const changedBase: WorkflowSequence = {
      kind: "sequence",
      elements: NOTE_SEQUENCE_ROOT.elements.filter(
        (element) => element.kind !== "task" || element.definitionNodeId !== "note.classify",
      ),
    };
    // 缺少required classifier的新基线本身就非法，必须在任何operation前阻断。
    const invalidBase = reapplyWorkflowOperations(changedBase, [insertReview], () => policy);
    expect(invalidBase).toMatchObject({ success: false, reason: "invalid_base" });

    const operationFailure = reapplyWorkflowOperations(
      NOTE_SEQUENCE_ROOT,
      [
        {
          kind: "update_node_config",
          target: { definitionNodeId: "note.extract" },
          fieldName: "maxCharacters",
          value: 2_000,
        },
        {
          kind: "update_node_config",
          target: { definitionNodeId: "note.missing" },
          fieldName: "maxCharacters",
          value: 2_000,
        },
        insertReview,
      ],
      () => policy,
    );
    expect(operationFailure).toMatchObject({
      success: false,
      reason: "operation_rejected",
      operationIndex: 1,
    });
    if (operationFailure.success || operationFailure.reason !== "operation_rejected") return;
    expect(operationFailure.appliedOperations).toHaveLength(1);
    expect(readConfig(operationFailure.lastValidVersion.semanticRoot, "note.extract")).toEqual({
      maxCharacters: 2_000,
      defaultKind: "general",
      suggestedTagLabels: [],
    });
    expect(
      findTask(operationFailure.lastValidVersion.semanticRoot, "note.review.local"),
    ).toBeUndefined();
  });
});

function updateTaskConfig(
  root: WorkflowSequence,
  definitionNodeId: string,
  config: Readonly<Record<string, unknown>>,
): WorkflowSequence {
  return {
    kind: "sequence",
    elements: root.elements.map((element) =>
      element.kind === "task" && element.definitionNodeId === definitionNodeId
        ? { ...element, config }
        : element,
    ),
  };
}

function findTask(
  root: WorkflowSequence,
  definitionNodeId: string,
): WorkflowTaskElement | undefined {
  const stack = [...root.elements];
  while (stack.length > 0) {
    const element = stack.shift();
    if (element === undefined) break;
    if (element.kind === "task") {
      if (element.definitionNodeId === definitionNodeId) return element;
    } else if (element.kind === "sequence") stack.push(...element.elements);
    else if (element.kind === "bounded_loop") stack.push(...element.body.elements);
    else if (element.kind === "choice") {
      for (const branch of element.branches) stack.push(...branch.body.elements);
    }
  }
  return undefined;
}

function readConfig(
  root: WorkflowSequence,
  definitionNodeId: string,
): Readonly<Record<string, unknown>> | undefined {
  return findTask(root, definitionNodeId)?.config;
}
