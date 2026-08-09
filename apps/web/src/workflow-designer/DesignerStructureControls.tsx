import { useState } from "react";
import type { WorkflowBlueprintDto } from "@chat/contracts/public";
import { NodeConfigFieldRenderer, isSupportedDesignerField } from "./NodeConfigFieldRenderer.js";
import {
  resolveDesignerSequence,
  type CatalogNode,
  type DesignerAddress,
  type DesignerOperation,
} from "./structure-operations.js";
import type { WorkflowDefinitionElement, WorkflowDefinitionSequence } from "./types.js";
import type { DesignerSelection } from "./designer-utils.js";

export type DesignerLoopRule = WorkflowBlueprintDto["loopRules"][number];
type ExecutableElement = Extract<WorkflowDefinitionElement, { kind: "task" | "composite" }>;
type ChoiceElement = Extract<WorkflowDefinitionElement, { kind: "choice" }>;
type LoopElement = Extract<WorkflowDefinitionElement, { kind: "bounded_loop" }>;

export function DesignerNodeInspector({
  root,
  selected,
  element,
  descriptor,
  optionalNodeTypes,
  allowedChoiceSourceTypes,
  loopRules,
  editing,
  onOperation,
}: {
  readonly root: WorkflowDefinitionSequence;
  readonly selected: DesignerSelection;
  readonly element: ExecutableElement;
  readonly descriptor: CatalogNode | undefined;
  readonly optionalNodeTypes: readonly string[];
  readonly allowedChoiceSourceTypes: readonly string[];
  readonly loopRules: readonly DesignerLoopRule[];
  readonly editing: boolean;
  readonly onOperation: (operation: DesignerOperation) => void;
}) {
  const optional = optionalNodeTypes.includes(element.nodeType) && element.kind === "task";
  const choices = collectStructures(root, "choice");
  const canWrapChoice =
    allowedChoiceSourceTypes.includes(element.nodeType) &&
    !choices.some((choice) => choice.fromDefinitionNodeId === element.definitionNodeId);
  const loopRule = loopRules.find((candidate) => candidate.outcomeNodeType === element.nodeType);
  const alreadyLoopSource = collectStructures(root, "bounded_loop").some(
    (loop) => loop.outcomeFromDefinitionNodeId === element.definitionNodeId,
  );
  return (
    <section>
      <h4>{descriptor?.displayName ?? element.nodeType}</h4>
      <p>{element.definitionNodeId}</p>
      {descriptor?.publicConfigFields.every(isSupportedDesignerField) === false && (
        <p className="designer-blocker" role="alert">
          存在未知字段，已禁止编辑和发布。
        </p>
      )}
      {(descriptor?.publicConfigFields ?? []).map((field) => (
        <NodeConfigFieldRenderer
          key={field.name}
          field={field}
          value={element.config[field.name]}
          disabled={!editing || element.kind === "composite"}
          inputId={`designer-field-${element.definitionNodeId}-${field.name}`}
          onChange={(value) => {
            const safeValue = toDesignerConfigValue(value);
            if (safeValue === undefined) return;
            onOperation({
              kind: "update_node_config",
              target: { definitionNodeId: element.definitionNodeId },
              fieldName: field.name,
              value: safeValue,
            });
          }}
        />
      ))}
      {optional && (
        <div className="designer-structure-actions">
          <label className="designer-field">
            默认状态
            <select
              aria-label="默认状态"
              value={element.defaultActivation ?? "enabled"}
              disabled={!editing || descriptor?.canDefaultSkip !== true}
              onChange={(event) =>
                onOperation({
                  kind: "set_default_activation",
                  target: { definitionNodeId: element.definitionNodeId },
                  activation: event.target.value as "enabled" | "skipped",
                })
              }
            >
              <option value="enabled">默认启用</option>
              <option value="skipped">默认跳过</option>
            </select>
          </label>
          <button
            type="button"
            disabled={!editing}
            onClick={() =>
              onOperation({
                kind: "remove_optional_task",
                target: { definitionNodeId: element.definitionNodeId },
              })
            }
          >
            移除此可选节点
          </button>
        </div>
      )}
      <section className="designer-structure-actions" aria-label="固定结构操作">
        <h5>结构</h5>
        {canWrapChoice && (
          <button
            type="button"
            disabled={!editing}
            onClick={() =>
              onOperation({
                kind: "wrap_in_choice",
                fromDefinitionNodeId: element.definitionNodeId,
              })
            }
          >
            按固定 outcome 创建 Choice
          </button>
        )}
        {choices
          .filter((choice) => choice.fromDefinitionNodeId !== element.definitionNodeId)
          .flatMap((choice) =>
            choice.branches.map((branch) => (
              <button
                type="button"
                key={`${choice.fromDefinitionNodeId}:${branch.outcome}`}
                disabled={!editing}
                onClick={() =>
                  onOperation({
                    kind: "move_into_branch",
                    target: { definitionNodeId: element.definitionNodeId },
                    fromDefinitionNodeId: choice.fromDefinitionNodeId,
                    outcome: branch.outcome,
                    index: branch.body.elements.length,
                  })
                }
              >
                移入 {choice.fromDefinitionNodeId} → {branch.outcome}
              </button>
            )),
          )}
        {loopRule !== undefined && !alreadyLoopSource && (
          <LoopWrapControl
            root={root}
            address={selected.address}
            sourceIndex={selected.index}
            sourceDefinitionNodeId={element.definitionNodeId}
            rule={loopRule}
            editing={editing}
            onOperation={onOperation}
          />
        )}
      </section>
    </section>
  );
}

export function DesignerChoiceInspector({
  element,
  editing,
  onOperation,
}: {
  readonly element: ChoiceElement;
  readonly editing: boolean;
  readonly onOperation: (operation: DesignerOperation) => void;
}) {
  const [preserveOutcome, setPreserveOutcome] = useState(element.branches[0]?.outcome ?? "");
  return (
    <section>
      <h4>Choice 专用结构</h4>
      <p>来源：{element.fromDefinitionNodeId}</p>
      <p>固定分支：{element.branches.map((branch) => branch.outcome).join("、")}</p>
      <p>分支来自 Catalog outcome；页面不提供表达式或自由 edge handle。</p>
      <label className="designer-field">
        展开时保留分支
        <select
          aria-label="展开 Choice 时保留分支"
          value={preserveOutcome}
          disabled={!editing}
          onChange={(event) => setPreserveOutcome(event.target.value)}
        >
          {element.branches.map((branch) => (
            <option key={branch.outcome} value={branch.outcome}>
              {branch.outcome}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        disabled={!editing || preserveOutcome === ""}
        onClick={() =>
          onOperation({
            kind: "unwrap_choice",
            fromDefinitionNodeId: element.fromDefinitionNodeId,
            preserveOutcome,
          })
        }
      >
        展开 Choice 并保留所选分支
      </button>
    </section>
  );
}

function LoopWrapControl({
  root,
  address,
  sourceIndex,
  sourceDefinitionNodeId,
  rule,
  editing,
  onOperation,
}: {
  readonly root: WorkflowDefinitionSequence;
  readonly address: DesignerAddress;
  readonly sourceIndex: number;
  readonly sourceDefinitionNodeId: string;
  readonly rule: DesignerLoopRule;
  readonly editing: boolean;
  readonly onOperation: (operation: DesignerOperation) => void;
}) {
  const sequence = resolveDesignerSequence(root, address);
  const [startIndex, setStartIndex] = useState(Math.max(0, sourceIndex - 1));
  const [endIndexExclusive, setEndIndexExclusive] = useState(sourceIndex + 1);
  const [maxIterations, setMaxIterations] = useState(rule.maxIterations);
  const [exceededPolicy, setExceededPolicy] = useState<"fail" | "request_human">("fail");
  if (sequence === undefined) return null;
  const rangeValid = startIndex <= sourceIndex && endIndexExclusive > sourceIndex;
  return (
    <fieldset className="designer-loop-wrap">
      <legend>包装为 Bounded Loop</legend>
      <label>
        起点
        <select
          aria-label="Bounded Loop 起点"
          value={startIndex}
          disabled={!editing}
          onChange={(event) => setStartIndex(Number(event.target.value))}
        >
          {sequence.elements.map((_, index) => (
            <option key={index} value={index}>{`第 ${String(index + 1)} 个元素`}</option>
          ))}
        </select>
      </label>
      <label>
        终点
        <select
          aria-label="Bounded Loop 终点"
          value={endIndexExclusive}
          disabled={!editing}
          onChange={(event) => setEndIndexExclusive(Number(event.target.value))}
        >
          {sequence.elements.map((_, index) => (
            <option key={index + 1} value={index + 1}>{`第 ${String(index + 1)} 个元素后`}</option>
          ))}
        </select>
      </label>
      <label>
        最大迭代
        <input
          aria-label="新 Bounded Loop 最大迭代次数"
          type="number"
          min={1}
          max={rule.maxIterations}
          value={maxIterations}
          disabled={!editing}
          onChange={(event) => setMaxIterations(event.target.valueAsNumber)}
        />
      </label>
      <label>
        超限策略
        <select
          aria-label="新 Bounded Loop 超限策略"
          value={exceededPolicy}
          disabled={!editing}
          onChange={(event) => setExceededPolicy(event.target.value as "fail" | "request_human")}
        >
          <option value="fail">失败关闭</option>
          <option value="request_human">转人工处理</option>
        </select>
      </label>
      <button
        type="button"
        disabled={!editing || !rangeValid}
        onClick={() =>
          onOperation({
            kind: "wrap_in_bounded_loop",
            address,
            startIndex,
            endIndexExclusive,
            outcomeFromDefinitionNodeId: sourceDefinitionNodeId,
            maxIterations,
            exceededPolicy,
          })
        }
      >
        包装所选范围
      </button>
      {!rangeValid && <small>范围必须包含 outcome 来源节点。</small>}
    </fieldset>
  );
}

export function DesignerLoopInspector({
  element,
  rule,
  editing,
  onOperation,
}: {
  readonly element: LoopElement;
  readonly rule: DesignerLoopRule | undefined;
  readonly editing: boolean;
  readonly onOperation: (operation: DesignerOperation) => void;
}) {
  const maximum = rule?.maxIterations ?? element.maxIterations;
  return (
    <section>
      <h4>Bounded Loop 专用结构</h4>
      <label className="designer-field">
        最大迭代次数
        <input
          aria-label="Bounded Loop 最大迭代次数"
          type="number"
          min={1}
          max={maximum}
          value={element.maxIterations}
          disabled={!editing || rule === undefined}
          onChange={(event) =>
            onOperation({
              kind: "update_loop_policy",
              outcomeFromDefinitionNodeId: element.outcomeFromDefinitionNodeId,
              maxIterations: event.target.valueAsNumber,
              exceededPolicy: element.exceededPolicy,
            })
          }
        />
      </label>
      <label className="designer-field">
        超限策略
        <select
          aria-label="Bounded Loop 超限策略"
          value={element.exceededPolicy}
          disabled={!editing || rule === undefined}
          onChange={(event) =>
            onOperation({
              kind: "update_loop_policy",
              outcomeFromDefinitionNodeId: element.outcomeFromDefinitionNodeId,
              maxIterations: element.maxIterations,
              exceededPolicy: event.target.value as "fail" | "request_human",
            })
          }
        >
          <option value="fail">失败关闭</option>
          <option value="request_human">转人工处理</option>
        </select>
      </label>
      <button
        type="button"
        disabled={!editing}
        onClick={() =>
          onOperation({
            kind: "unwrap_loop",
            outcomeFromDefinitionNodeId: element.outcomeFromDefinitionNodeId,
          })
        }
      >
        展开 Bounded Loop
      </button>
      <p>continue/exit outcome 固定来自 Blueprint，不允许手工输入表达式。</p>
    </section>
  );
}

export function loopContainsNodeType(loop: LoopElement, nodeType: string): boolean {
  const stack = [...loop.body.elements];
  while (stack.length > 0) {
    const element = stack.pop();
    if (element === undefined) continue;
    if (
      (element.kind === "task" || element.kind === "composite") &&
      element.nodeType === nodeType
    ) {
      return true;
    }
    if (element.kind === "sequence") stack.push(...element.elements);
    else if (element.kind === "choice") {
      for (const branch of element.branches) stack.push(...branch.body.elements);
    } else if (element.kind === "bounded_loop") stack.push(...element.body.elements);
  }
  return false;
}

function collectStructures<K extends "choice" | "bounded_loop">(
  root: WorkflowDefinitionSequence,
  kind: K,
): Extract<WorkflowDefinitionElement, { kind: K }>[] {
  const found: Extract<WorkflowDefinitionElement, { kind: K }>[] = [];
  const stack: WorkflowDefinitionElement[] = [...root.elements];
  while (stack.length > 0) {
    const element = stack.pop();
    if (element === undefined) continue;
    if (element.kind === kind) {
      found.push(element as Extract<WorkflowDefinitionElement, { kind: K }>);
    }
    if (element.kind === "sequence") stack.push(...element.elements);
    else if (element.kind === "choice") {
      for (const branch of element.branches) stack.push(...branch.body.elements);
    } else if (element.kind === "bounded_loop") stack.push(...element.body.elements);
  }
  return found;
}

function toDesignerConfigValue(value: unknown): boolean | number | string | string[] | undefined {
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return value;
  }
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}
