import { describe, expect, it } from "vitest";
import { DEFAULT_WORKFLOW_BLUEPRINTS, type WorkflowBlueprint } from "./workflow-blueprints.js";
import {
  NOTE_CHOICE_ROOT,
  NOTE_SEQUENCE_ROOT,
  PLANNING_MIXED_ROOT,
} from "./workflow-kernel-fixtures.js";
import {
  deriveWorkflowDesignerPolicy,
  toWorkflowDesignerSlotDto,
} from "./workflow-designer-policy.js";
import { applyWorkflowStructureOperation } from "./workflow-structure-operations.js";

describe("Workflow Designer Blueprint具体slot投影", () => {
  it("Planning optional上下文只能落在有界规划控制容器之前", () => {
    const policy = deriveWorkflowDesignerPolicy(PLANNING_MIXED_ROOT, requiredBlueprint("planning"));
    expect(policy.slots).toEqual([
      expect.objectContaining({
        slotId: "planning.context",
        address: [],
        minimumIndex: 0,
        maximumIndex: 3,
      }),
    ]);
    expect(policy.slots[0]?.allowedNodeTypes).toContain("policy.rules");

    const removed = applyWorkflowStructureOperation(
      PLANNING_MIXED_ROOT,
      { kind: "remove_optional_task", target: { definitionNodeId: "planning.rules" } },
      policy,
    );
    expect(removed.success).toBe(true);
    if (!removed.success) return;
    const nextPolicy = deriveWorkflowDesignerPolicy(
      removed.semanticRoot,
      requiredBlueprint("planning"),
    );
    expect(nextPolicy.slots[0]?.maximumIndex).toBe(2);
  });

  it("Note线性结构把审核slot固定在classify与commit之间", () => {
    const policy = deriveWorkflowDesignerPolicy(NOTE_SEQUENCE_ROOT, requiredBlueprint("note"));
    expect(policy.slots).toEqual([
      expect.objectContaining({
        slotId: "note.review",
        address: [],
        minimumIndex: 2,
        maximumIndex: 2,
        maximumElements: 1,
      }),
    ]);
    expect(policy.allowedChoiceSourceTypes).toEqual(["note.classify"]);
  });

  it("Note Choice结构用稳定source/outcome地址定位needs_review分支", () => {
    const policy = deriveWorkflowDesignerPolicy(NOTE_CHOICE_ROOT, requiredBlueprint("note"));
    expect(policy.slots[0]).toEqual(
      expect.objectContaining({
        address: [
          {
            kind: "choice_branch",
            fromDefinitionNodeId: "note.classify",
            outcome: "needs_review",
          },
        ],
        minimumIndex: 0,
        maximumIndex: 1,
      }),
    );
  });

  it("未知或歧义结构失败关闭，不开放猜测drop zone", () => {
    const malformed = {
      ...NOTE_SEQUENCE_ROOT,
      elements: NOTE_SEQUENCE_ROOT.elements.filter(
        (element) => element.kind !== "task" || element.definitionNodeId !== "note.classify",
      ),
    };
    expect(deriveWorkflowDesignerPolicy(malformed, requiredBlueprint("note")).slots).toEqual([]);
  });

  it("公开slot DTO只含语义地址和容量，不含位置/edge", () => {
    const slot = deriveWorkflowDesignerPolicy(NOTE_SEQUENCE_ROOT, requiredBlueprint("note"))
      .slots[0];
    if (slot === undefined) throw new Error("slot missing");
    const dto = toWorkflowDesignerSlotDto(slot, "审核位置");
    expect(dto).toEqual({
      slotId: "note.review",
      address: [],
      label: "审核位置",
      allowedNodeTypes: ["human.note_review"],
      minimumIndex: 2,
      maximumIndex: 2,
      maximumElements: 1,
    });
    expect(dto).not.toHaveProperty("position");
    expect(dto).not.toHaveProperty("edges");
  });
});

function requiredBlueprint(key: "planning" | "note"): WorkflowBlueprint {
  const blueprint = DEFAULT_WORKFLOW_BLUEPRINTS.get(key, 1);
  if (blueprint === undefined) throw new Error(`missing blueprint:${key}`);
  return blueprint;
}
