import type {
  SaveWorkflowDefinitionDraftPayload,
  WorkflowDefinitionDetailDto,
} from "@chat/contracts/public";

// 浏览器只从公开Designer DTO反推受限IR形状，不导入Domain/Application内部类型。
export type WorkflowDefinitionSequence = SaveWorkflowDefinitionDraftPayload["semanticRoot"];
export type WorkflowDefinitionElement = WorkflowDefinitionSequence["elements"][number];
export type EditableWorkflowDefinitionDetail = WorkflowDefinitionDetailDto & {
  readonly compatibility: "editable";
  readonly semanticRoot: WorkflowDefinitionSequence;
  readonly baseRevisionId: SaveWorkflowDefinitionDraftPayload["baseRevisionId"];
  readonly baseDefinitionSha256: SaveWorkflowDefinitionDraftPayload["baseDefinitionSha256"];
  readonly allowedActions: readonly (
    "copy" | "save" | "validate" | "publish" | "archive" | "restore"
  )[];
};

export function isEditableWorkflowDefinition(
  value: WorkflowDefinitionDetailDto | undefined,
): value is EditableWorkflowDefinitionDetail {
  return value?.compatibility === "editable";
}
