import type { WorkflowDesignerDiagnosticDto } from "@chat/contracts/public";
import {
  DesignerChoiceInspector,
  DesignerLoopInspector,
  DesignerNodeInspector,
  loopContainsNodeType,
  type DesignerLoopRule,
} from "./DesignerStructureControls.js";
import {
  resolveDesignerSequence,
  type CatalogNode,
  type DesignerOperation,
} from "./structure-operations.js";
import type { DesignerHistory } from "./working-copy.js";
import type {
  EditableWorkflowDefinitionDetail,
  WorkflowDefinitionElement,
  WorkflowDefinitionSequence,
} from "./types.js";
import { uniqueDesignerNodeId, type DesignerSelection } from "./designer-utils.js";

export function DesignerCatalogPanel({
  detail,
  history,
  catalog,
  editing,
  onOperation,
}: {
  readonly detail: EditableWorkflowDefinitionDetail;
  readonly history: DesignerHistory;
  readonly catalog: readonly CatalogNode[];
  readonly editing: boolean;
  readonly onOperation: (operation: DesignerOperation) => void;
}) {
  const compatible = catalog.filter(
    (node) =>
      node.supportedBlueprints.includes(detail.blueprintKey) &&
      node.executorKind !== "composite" &&
      detail.slots.some((slot) => slot.allowedNodeTypes.includes(node.nodeType)),
  );
  return (
    <aside className="designer-catalog" aria-label="允许的节点目录">
      <h3>Catalog</h3>
      <p>只显示 Blueprint 槽位允许、且不是 Composite 的节点。</p>
      {compatible.map((node) => (
        <article
          key={node.nodeType}
          draggable={editing}
          onDragStart={(event) =>
            event.dataTransfer.setData(
              "application/x-chat-workflow-element",
              JSON.stringify({ kind: "catalog", nodeType: node.nodeType }),
            )
          }
        >
          <strong>{node.displayName}</strong>
          <small>{node.description}</small>
          {detail.slots
            .filter((slot) => slot.allowedNodeTypes.includes(node.nodeType))
            .map((slot) => {
              const target = resolveDesignerSequence(history.present, slot.address);
              const index = Math.min(target?.elements.length ?? 0, slot.maximumIndex);
              return (
                <button
                  type="button"
                  key={slot.slotId}
                  disabled={!editing || target === undefined || index < slot.minimumIndex}
                  onClick={() =>
                    onOperation({
                      kind: "insert_task",
                      slotId: slot.slotId,
                      index,
                      nodeType: node.nodeType,
                      definitionNodeId: uniqueDesignerNodeId(node.nodeType, history.present),
                    })
                  }
                >
                  添加到 {slot.label}
                </button>
              );
            })}
        </article>
      ))}
    </aside>
  );
}

export function DesignerInspector({
  root,
  selected,
  selectedValue,
  descriptor,
  optionalNodeTypes,
  allowedChoiceSourceTypes,
  loopRules,
  editing,
  diagnostics,
  onOperation,
  onLocateDiagnostic,
}: {
  readonly root: WorkflowDefinitionSequence;
  readonly selected: DesignerSelection | null;
  readonly selectedValue: WorkflowDefinitionElement | undefined;
  readonly descriptor: CatalogNode | undefined;
  readonly optionalNodeTypes: readonly string[];
  readonly allowedChoiceSourceTypes: readonly string[];
  readonly loopRules: readonly DesignerLoopRule[];
  readonly editing: boolean;
  readonly diagnostics: readonly WorkflowDesignerDiagnosticDto[];
  readonly onOperation: (operation: DesignerOperation) => void;
  readonly onLocateDiagnostic: (diagnostic: WorkflowDesignerDiagnosticDto) => void;
}) {
  return (
    <aside className="designer-inspector" aria-label="节点配置与诊断">
      <h3>Inspector</h3>
      {selected === null || selectedValue === undefined ? (
        <p>选择节点、Choice 或 Bounded Loop 查看可编辑配置。</p>
      ) : selectedValue.kind === "task" || selectedValue.kind === "composite" ? (
        <DesignerNodeInspector
          key={selectedValue.definitionNodeId}
          root={root}
          selected={selected}
          element={selectedValue}
          descriptor={descriptor}
          optionalNodeTypes={optionalNodeTypes}
          allowedChoiceSourceTypes={allowedChoiceSourceTypes}
          loopRules={loopRules}
          editing={editing}
          onOperation={onOperation}
        />
      ) : selectedValue.kind === "choice" ? (
        <DesignerChoiceInspector
          key={selectedValue.fromDefinitionNodeId}
          element={selectedValue}
          editing={editing}
          onOperation={onOperation}
        />
      ) : selectedValue.kind === "bounded_loop" ? (
        <DesignerLoopInspector
          key={selectedValue.outcomeFromDefinitionNodeId}
          element={selectedValue}
          rule={loopRules.find((candidate) =>
            loopContainsNodeType(selectedValue, candidate.outcomeNodeType),
          )}
          editing={editing}
          onOperation={onOperation}
        />
      ) : (
        <p className="designer-blocker" role="alert">
          当前结构选择已变化，请重新选择节点。
        </p>
      )}
      <div id="workflow-designer-global-diagnostics" tabIndex={-1}>
        <DiagnosticsPanel diagnostics={diagnostics} onLocate={onLocateDiagnostic} />
      </div>
    </aside>
  );
}

function DiagnosticsPanel({
  diagnostics,
  onLocate,
}: {
  readonly diagnostics: readonly WorkflowDesignerDiagnosticDto[];
  readonly onLocate: (diagnostic: WorkflowDesignerDiagnosticDto) => void;
}) {
  return (
    <section className="designer-diagnostics" aria-label="定义诊断">
      <h3>诊断</h3>
      {diagnostics.length === 0 ? (
        <p>当前没有诊断。发布仍以服务端再次校验为准。</p>
      ) : (
        <ul>
          {diagnostics.map((diagnostic, index) => (
            <li
              key={`${diagnostic.code}:${diagnostic.path}:${String(index)}`}
              data-severity={diagnostic.severity}
            >
              <button type="button" onClick={() => onLocate(diagnostic)}>
                <strong>{diagnostic.code}</strong>
                <span>{diagnostic.help ?? diagnostic.path}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
