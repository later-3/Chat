import type {
  WorkflowChoiceElement,
  WorkflowElement,
  WorkflowNodeTypeKey,
  WorkflowSequence,
} from "@chat/domain";
import type { WorkflowDesignerSlotV3Dto } from "@chat/contracts";
import type { WorkflowBlueprint } from "./workflow-blueprints.js";
import type {
  WorkflowDesignerPolicy,
  WorkflowDesignerSlot,
  WorkflowSequenceAddress,
} from "./workflow-structure-operations.js";

/**
 * Blueprint描述“哪些类型允许”；本函数结合具体Revision生成稳定的语义drop zone。
 * Slot锚定Choice/Loop业务身份，不包含画布坐标。未知结构宁可不开放drop zone，
 * 发布时仍由完整Validator决定是否合法。
 */
export function deriveWorkflowDesignerPolicy(
  root: WorkflowSequence,
  blueprint: WorkflowBlueprint,
): WorkflowDesignerPolicy {
  if (blueprint.blueprintKey === "planning") {
    return {
      blueprint,
      slots: planningSlots(root, blueprint),
      allowedChoiceSourceTypes: ["human.plan_review"],
    };
  }
  return {
    blueprint,
    slots: noteSlots(root, blueprint),
    allowedChoiceSourceTypes: ["note.classify"],
  };
}

export function toWorkflowDesignerSlotDto(
  slot: WorkflowDesignerSlot,
  label: string,
): WorkflowDesignerSlotV3Dto {
  return {
    slotId: slot.slotId,
    address: slot.address.map((segment) => ({ ...segment })),
    label,
    allowedNodeTypes: [...slot.allowedNodeTypes],
    minimumIndex: slot.minimumIndex,
    maximumIndex: slot.maximumIndex,
    ...(slot.maximumElements !== undefined ? { maximumElements: slot.maximumElements } : {}),
  };
}

function planningSlots(
  root: WorkflowSequence,
  blueprint: WorkflowBlueprint,
): readonly WorkflowDesignerSlot[] {
  const controlIndex = root.elements.findIndex(
    (element) =>
      element.kind === "bounded_loop" ||
      ((element.kind === "task" || element.kind === "composite") &&
        !blueprint.optionalNodeTypes.includes(element.nodeType)),
  );
  const prefixEnd = controlIndex < 0 ? root.elements.length : controlIndex;
  return [
    {
      slotId: "planning.context",
      address: [],
      allowedNodeTypes: blueprint.optionalNodeTypes,
      minimumIndex: 0,
      maximumIndex: prefixEnd,
      maximumElements: 64,
    },
  ];
}

function noteSlots(
  root: WorkflowSequence,
  blueprint: WorkflowBlueprint,
): readonly WorkflowDesignerSlot[] {
  const choice = findTopLevelChoice(root, "note.classify");
  if (choice !== undefined) {
    const reviewBranch = choice.branches.find((branch) => branch.outcome === "needs_review");
    if (reviewBranch === undefined) return [];
    const address: WorkflowSequenceAddress = [
      {
        kind: "choice_branch",
        fromDefinitionNodeId: choice.fromDefinitionNodeId,
        outcome: reviewBranch.outcome,
      },
    ];
    return [noteReviewSlot(address, 0, reviewBranch.body.elements.length, blueprint)];
  }
  const classifyIndex = indexOfTopLevelNodeType(root, "note.classify");
  const commitIndex = indexOfTopLevelNodeType(root, "note.commit");
  if (classifyIndex < 0 || commitIndex < 0 || classifyIndex >= commitIndex) return [];
  return [noteReviewSlot([], classifyIndex + 1, commitIndex, blueprint)];
}

function noteReviewSlot(
  address: WorkflowSequenceAddress,
  minimumIndex: number,
  maximumIndex: number,
  blueprint: WorkflowBlueprint,
): WorkflowDesignerSlot {
  const allowed = blueprint.optionalNodeTypes.filter(
    (nodeType): nodeType is WorkflowNodeTypeKey => nodeType === "human.note_review",
  );
  return {
    slotId: "note.review",
    address,
    allowedNodeTypes: allowed,
    minimumIndex,
    maximumIndex,
    maximumElements: 1,
  };
}

function findTopLevelChoice(
  root: WorkflowSequence,
  fromDefinitionNodeId: string,
): WorkflowChoiceElement | undefined {
  const matches = root.elements.filter(
    (element): element is WorkflowChoiceElement =>
      element.kind === "choice" && element.fromDefinitionNodeId === fromDefinitionNodeId,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function indexOfTopLevelNodeType(root: WorkflowSequence, nodeType: WorkflowNodeTypeKey): number {
  return root.elements.findIndex(
    (element: WorkflowElement) =>
      (element.kind === "task" || element.kind === "composite") && element.nodeType === nodeType,
  );
}
