import type {
  WorkflowBlueprintDto,
  WorkflowDefinitionDetailDto,
  WorkflowDefinitionPublishedDto,
  WorkflowDesignerDiagnosticDto,
  WorkflowDesignerSlotDto,
} from "@chat/contracts/public";
import { DesignerCanvas } from "./DesignerCanvas.js";
import { DesignerConflictPanel, DesignerCopyPanel, DesignerToolbar } from "./DesignerChrome.js";
import { DesignerCatalogPanel, DesignerInspector } from "./DesignerPanels.js";
import type { CatalogNode, DesignerOperation } from "./structure-operations.js";
import type { DesignerHistory } from "./working-copy.js";
import type { EditableWorkflowDefinitionDetail, WorkflowDefinitionElement } from "./types.js";
import type { DesignerConflictState, DesignerSelection } from "./designer-utils.js";

export interface DesignerSurfaceProps {
  readonly detail: WorkflowDefinitionDetailDto | undefined;
  readonly editableDetail: EditableWorkflowDefinitionDetail | undefined;
  readonly definitions: readonly WorkflowDefinitionPublishedDto[];
  readonly definitionId: string;
  readonly detailPending: boolean;
  readonly detailError: boolean;
  readonly history: DesignerHistory | null;
  readonly selected: DesignerSelection | null;
  readonly selectedValue: WorkflowDefinitionElement | undefined;
  readonly selectedDescriptor: CatalogNode | undefined;
  readonly catalog: readonly CatalogNode[];
  readonly optionalNodeTypes: readonly string[];
  readonly allowedChoiceSourceTypes: readonly string[];
  readonly loopRules: WorkflowBlueprintDto["loopRules"];
  readonly editing: boolean;
  readonly dirty: boolean;
  readonly saveBlocked: boolean;
  readonly validationPending: boolean;
  readonly serverValid: boolean;
  readonly busy: string | null;
  readonly notice: string | null;
  readonly copyTitle: string;
  readonly copyDescription: string;
  readonly operationError: string | null;
  readonly conflict: DesignerConflictState | null;
  readonly diagnostics: readonly WorkflowDesignerDiagnosticDto[];
  readonly onDefinitionChange: (definitionId: string) => void;
  readonly onUndo: () => void;
  readonly onRedo: () => void;
  readonly onValidate: () => void;
  readonly onSave: () => void;
  readonly onPublish: () => void;
  readonly onArchive: () => void;
  readonly onCopyTitleChange: (value: string) => void;
  readonly onCopyDescriptionChange: (value: string) => void;
  readonly onCopy: () => void;
  readonly onConflictReload: () => void;
  readonly onConflictReapply: () => void;
  readonly onConflictCopy: () => void;
  readonly onSelect: (selection: DesignerSelection) => void;
  readonly onOperation: (operation: DesignerOperation) => void;
  readonly onDropPayload: (slot: WorkflowDesignerSlotDto, payload: unknown, index: number) => void;
  readonly onLocateDiagnostic: (diagnostic: WorkflowDesignerDiagnosticDto) => void;
}

export function DesignerSurface(props: DesignerSurfaceProps) {
  return (
    <section className="workflow-designer" aria-label="工作流 Definition 设计器">
      <DesignerToolbar
        detail={props.detail}
        definitions={props.definitions}
        definitionId={props.definitionId}
        dirty={props.dirty}
        editing={props.editing}
        saveBlocked={props.saveBlocked}
        validationPending={props.validationPending}
        serverValid={props.serverValid}
        busy={props.busy}
        canUndo={(props.history?.past.length ?? 0) > 0}
        canRedo={(props.history?.future.length ?? 0) > 0}
        notice={props.notice}
        onDefinitionChange={props.onDefinitionChange}
        onUndo={props.onUndo}
        onRedo={props.onRedo}
        onValidate={props.onValidate}
        onSave={props.onSave}
        onPublish={props.onPublish}
        onArchive={props.onArchive}
      />
      {props.detailPending && <p className="loading-note">正在读取 Definition 详情…</p>}
      {props.detailError && <p className="error-note">Definition 详情读取失败。</p>}
      {props.detail?.compatibility === "read_only_incompatible" && (
        <div className="designer-blocker" role="alert">
          当前客户端不能安全解释此版本（{props.detail.incompatibilityCode}），仅显示
          {props.detail.safeStructureSummary.nodeCount} 个节点的安全摘要；禁止编辑和发布。
        </div>
      )}
      <DesignerCopyPanel
        detail={props.detail}
        title={props.copyTitle}
        description={props.copyDescription}
        busy={props.busy}
        onTitleChange={props.onCopyTitleChange}
        onDescriptionChange={props.onCopyDescriptionChange}
        onCopy={props.onCopy}
      />
      {props.operationError && (
        <p className="designer-operation-error" role="alert">
          {props.operationError}
        </p>
      )}
      <DesignerConflictPanel
        conflict={props.conflict}
        busy={props.busy}
        onReload={props.onConflictReload}
        onReapply={props.onConflictReapply}
        onCopy={props.onConflictCopy}
      />
      {props.editableDetail !== undefined && props.history !== null && (
        <div className="workflow-designer-grid">
          <DesignerCatalogPanel
            detail={props.editableDetail}
            history={props.history}
            catalog={props.catalog}
            editing={props.editing}
            onOperation={props.onOperation}
          />
          <main className="designer-canvas-region" aria-label="Definition LR 结构画布">
            <div className="designer-canvas-help">
              桌面按左到右结构显示；手机自动切换为同一语义的线性树。拖动只命中标出的 drop zone。
            </div>
            <DesignerCanvas
              sequence={props.history.present}
              slots={props.editableDetail.slots}
              catalog={props.catalog}
              optionalNodeTypes={new Set(props.optionalNodeTypes)}
              editing={props.editing}
              selected={props.selected}
              onSelect={props.onSelect}
              onOperation={props.onOperation}
              onDropPayload={props.onDropPayload}
            />
          </main>
          <DesignerInspector
            root={props.history.present}
            selected={props.selected}
            selectedValue={props.selectedValue}
            descriptor={props.selectedDescriptor}
            optionalNodeTypes={props.optionalNodeTypes}
            allowedChoiceSourceTypes={props.allowedChoiceSourceTypes}
            loopRules={props.loopRules}
            editing={props.editing}
            diagnostics={props.diagnostics}
            onOperation={props.onOperation}
            onLocateDiagnostic={props.onLocateDiagnostic}
          />
        </div>
      )}
    </section>
  );
}
