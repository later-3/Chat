import type { WorkflowDesignerSlotDto } from "@chat/contracts/public";
import {
  slotsForAddress,
  type CatalogNode,
  type DesignerAddress,
  type DesignerOperation,
} from "./structure-operations.js";
import type { WorkflowDefinitionSequence } from "./types.js";
import type { DesignerSelection } from "./designer-utils.js";

function DropZone({
  slots,
  index,
  disabled,
  onDropPayload,
}: {
  readonly slots: readonly WorkflowDesignerSlotDto[];
  readonly index: number;
  readonly disabled: boolean;
  readonly onDropPayload: (slot: WorkflowDesignerSlotDto, payload: unknown, index: number) => void;
}) {
  const valid = slots.filter((slot) => index >= slot.minimumIndex && index <= slot.maximumIndex);
  if (valid.length === 0) return null;
  return (
    <div className="designer-drop-zones" aria-label={`第 ${String(index + 1)} 个结构位置`}>
      {valid.map((slot) => (
        <button
          key={slot.slotId}
          type="button"
          className="designer-drop-zone"
          disabled={disabled}
          aria-label={`放到${slot.label}第${String(index + 1)}位`}
          onDragOver={(event) => {
            if (!disabled) event.preventDefault();
          }}
          onDrop={(event) => {
            event.preventDefault();
            const raw = event.dataTransfer.getData("application/x-chat-workflow-element");
            try {
              onDropPayload(slot, JSON.parse(raw), index);
            } catch {
              // 非本设计器的拖拽数据不产生结构操作。
            }
          }}
        >
          <span aria-hidden="true">＋</span>
          {slot.label}
        </button>
      ))}
    </div>
  );
}

export function DesignerCanvas({
  sequence,
  address = [],
  slots,
  catalog,
  optionalNodeTypes,
  editing,
  selected,
  onSelect,
  onOperation,
  onDropPayload,
}: {
  readonly sequence: WorkflowDefinitionSequence;
  readonly address?: DesignerAddress;
  readonly slots: readonly WorkflowDesignerSlotDto[];
  readonly catalog: readonly CatalogNode[];
  readonly optionalNodeTypes: ReadonlySet<string>;
  readonly editing: boolean;
  readonly selected: DesignerSelection | null;
  readonly onSelect: (selection: DesignerSelection) => void;
  readonly onOperation: (operation: DesignerOperation) => void;
  readonly onDropPayload: (slot: WorkflowDesignerSlotDto, payload: unknown, index: number) => void;
}) {
  const addressSlots = slotsForAddress(slots, address);
  return (
    <div className="designer-sequence" role="list" aria-label="受约束顺序结构">
      {sequence.elements.map((element, index) => {
        const descriptor =
          element.kind === "task" || element.kind === "composite"
            ? catalog.find((candidate) => candidate.nodeType === element.nodeType)
            : undefined;
        const selectedHere =
          selected !== null &&
          selected.index === index &&
          JSON.stringify(selected.address) === JSON.stringify(address);
        return (
          <div className="designer-element-wrap" key={elementKey(element, index)}>
            <DropZone
              slots={addressSlots}
              index={index}
              disabled={!editing}
              onDropPayload={onDropPayload}
            />
            {element.kind === "task" || element.kind === "composite" ? (
              <article
                role="listitem"
                className={`designer-node-card${selectedHere ? " selected" : ""}`}
                data-node-id={element.definitionNodeId}
                draggable={editing && element.kind === "task"}
                onDragStart={(event) => {
                  event.dataTransfer.setData(
                    "application/x-chat-workflow-element",
                    JSON.stringify({ kind: "move", definitionNodeId: element.definitionNodeId }),
                  );
                }}
              >
                <button
                  type="button"
                  className="designer-node-main"
                  aria-pressed={selectedHere}
                  onClick={() => onSelect({ kind: "node", address, index })}
                >
                  <span>{descriptor?.displayName ?? element.nodeType}</span>
                  <small>{element.nodeType}</small>
                  <em>
                    {element.kind === "composite"
                      ? "运行时展开 · 不可手工创建"
                      : optionalNodeTypes.has(element.nodeType)
                        ? element.defaultActivation === "skipped"
                          ? "可选 · 默认跳过"
                          : "可选 · 默认启用"
                        : "Blueprint 必需"}
                  </em>
                </button>
                {editing && element.kind === "task" && (
                  <div className="designer-node-move" role="group" aria-label="节点顺序操作">
                    <MoveButton
                      direction="up"
                      index={index}
                      label={descriptor?.displayName ?? element.nodeType}
                      nodeType={element.nodeType}
                      definitionNodeId={element.definitionNodeId}
                      slots={addressSlots}
                      onOperation={onOperation}
                    />
                    <MoveButton
                      direction="down"
                      index={index}
                      label={descriptor?.displayName ?? element.nodeType}
                      nodeType={element.nodeType}
                      definitionNodeId={element.definitionNodeId}
                      slots={addressSlots}
                      onOperation={onOperation}
                    />
                  </div>
                )}
              </article>
            ) : element.kind === "sequence" ? (
              <section className="designer-structure-container">
                <span className="designer-container-label">嵌套顺序</span>
                <DesignerCanvas
                  {...{
                    sequence: element,
                    address: [...address, { kind: "nested_sequence", index }],
                    slots,
                    catalog,
                    optionalNodeTypes,
                    editing,
                    selected,
                    onSelect,
                    onOperation,
                    onDropPayload,
                  }}
                />
              </section>
            ) : element.kind === "choice" ? (
              <section
                className={`designer-structure-container designer-choice${selectedHere ? " selected" : ""}`}
              >
                <button
                  type="button"
                  className="designer-container-heading"
                  onClick={() => onSelect({ kind: "choice", address, index })}
                >
                  Choice · 由 {element.fromDefinitionNodeId} 的固定 outcome 决定
                </button>
                <div className="designer-branch-lanes">
                  {element.branches.map((branch) => (
                    <section key={branch.outcome} className="designer-branch-lane">
                      <h4>{branch.outcome}</h4>
                      <DesignerCanvas
                        {...{
                          sequence: branch.body,
                          address: [
                            ...address,
                            {
                              kind: "choice_branch" as const,
                              fromDefinitionNodeId: element.fromDefinitionNodeId,
                              outcome: branch.outcome,
                            },
                          ],
                          slots,
                          catalog,
                          optionalNodeTypes,
                          editing,
                          selected,
                          onSelect,
                          onOperation,
                          onDropPayload,
                        }}
                      />
                    </section>
                  ))}
                </div>
              </section>
            ) : (
              <section
                className={`designer-structure-container designer-loop${selectedHere ? " selected" : ""}`}
              >
                <button
                  type="button"
                  className="designer-container-heading"
                  onClick={() => onSelect({ kind: "loop", address, index })}
                >
                  Bounded Loop · 最多 {element.maxIterations} 次 · {element.exceededPolicy}
                </button>
                <p>
                  {element.continueOutcomes.join(" / ")} 继续；{element.exitOutcomes.join(" / ")}{" "}
                  退出
                </p>
                <DesignerCanvas
                  {...{
                    sequence: element.body,
                    address: [
                      ...address,
                      {
                        kind: "loop_body" as const,
                        outcomeFromDefinitionNodeId: element.outcomeFromDefinitionNodeId,
                      },
                    ],
                    slots,
                    catalog,
                    optionalNodeTypes,
                    editing,
                    selected,
                    onSelect,
                    onOperation,
                    onDropPayload,
                  }}
                />
              </section>
            )}
          </div>
        );
      })}
      <DropZone
        slots={addressSlots}
        index={sequence.elements.length}
        disabled={!editing}
        onDropPayload={onDropPayload}
      />
    </div>
  );
}

function MoveButton({
  direction,
  index,
  label,
  nodeType,
  definitionNodeId,
  slots,
  onOperation,
}: {
  readonly direction: "up" | "down";
  readonly index: number;
  readonly label: string;
  readonly nodeType: CatalogNode["nodeType"];
  readonly definitionNodeId: string;
  readonly slots: readonly WorkflowDesignerSlotDto[];
  readonly onOperation: (operation: DesignerOperation) => void;
}) {
  return (
    <button
      type="button"
      aria-label={`${direction === "up" ? "上移" : "下移"} ${label}`}
      onClick={() => {
        const slot = slots.find((candidate) => candidate.allowedNodeTypes.includes(nodeType));
        if (slot === undefined) return;
        onOperation({
          kind: "move_element",
          target: { definitionNodeId },
          slotId: slot.slotId,
          index: direction === "up" ? Math.max(0, index - 1) : index + 2,
        });
      }}
    >
      {direction === "up" ? "←" : "→"}
    </button>
  );
}

function elementKey(element: WorkflowDefinitionSequence["elements"][number], index: number) {
  if (element.kind === "task" || element.kind === "composite") return element.definitionNodeId;
  if (element.kind === "choice") return `choice:${element.fromDefinitionNodeId}`;
  if (element.kind === "bounded_loop") return `loop:${element.outcomeFromDefinitionNodeId}`;
  return `sequence:${String(index)}`;
}
