import type {
  CommandId,
  WorkflowBlueprintDto,
  WorkflowDefinitionDetailDto,
  WorkflowDesignerDiagnosticDto,
  WorkflowDesignerSlotDto,
} from "@chat/contracts/public";
import type {
  CatalogNode,
  DesignerAddress,
  DesignerOperation,
  DesignerOperationContext,
} from "./structure-operations.js";
import { resolveDesignerSequence } from "./structure-operations.js";
import type {
  EditableWorkflowDefinitionDetail,
  WorkflowDefinitionElement,
  WorkflowDefinitionSequence,
} from "./types.js";

export type DesignerSelection =
  | { readonly kind: "node"; readonly address: DesignerAddress; readonly index: number }
  | { readonly kind: "choice"; readonly address: DesignerAddress; readonly index: number }
  | { readonly kind: "loop"; readonly address: DesignerAddress; readonly index: number };

export interface DesignerConflictState {
  readonly latest: WorkflowDefinitionDetailDto;
  readonly operations: readonly import("./structure-operations.js").DesignerOperation[];
  readonly failedOperation?: { readonly index: number; readonly code: string };
}

export const designerDetailQueryKey = (workflowDefinitionId: string) =>
  ["chat-product-api.v1", "workflow-designer", "definition", workflowDefinitionId] as const;

export function nextDesignerCommandId(): CommandId {
  return `cmd_${crypto.randomUUID().replaceAll("-", "")}` as CommandId;
}

export function operationErrorText(code: string): string {
  const messages: Readonly<Record<string, string>> = {
    slot_not_found: "目标槽位已经不存在。",
    address_not_found: "目标结构已经变化，请重新选择。",
    index_out_of_range: "目标位置已经变化。",
    slot_index_denied: "Blueprint 不允许放到这个位置。",
    slot_full: "这个槽位已经达到最大节点数。",
    node_type_denied: "该槽位不允许这种节点。",
    node_type_unknown: "当前 Catalog 不认识这个节点。",
    composite_creation_denied: "Composite 只能由 Blueprint/Executor 定义，不能手工创建。",
    definition_node_id_duplicate: "节点身份重复，已拒绝添加。",
    required_node_change_denied: "必需节点不能删除或停用。",
    structure_move_denied: "Choice、Loop 和 Composite 只能使用专用结构控件。",
    config_field_unknown: "配置字段已经变化，请重新加载 Catalog。",
    config_value_invalid: "配置值超出服务端公开范围。",
    selector_runtime_only: "资源选择发生在发起 Run 时，不写入 Definition。",
    operation_contract_invalid: "结构操作合同已变化，请重新加载设计器。",
    choice_source_denied: "该节点不是 Blueprint 允许的 Choice 来源。",
    choice_already_exists: "该 outcome 节点已经拥有 Choice。",
    choice_not_found: "Choice 已变化，请重新选择。",
    choice_branch_not_found: "固定 outcome 分支已变化，请重新选择。",
    choice_outcomes_invalid: "Choice 必须来自 Catalog 的至少两个固定 outcome。",
    unwrap_would_discard_branch: "其他分支仍有节点；为防止数据丢失，不能展开 Choice。",
    loop_range_invalid: "Bounded Loop 的起止范围无效。",
    loop_source_outside_range: "循环 outcome 来源必须位于所选范围内。",
    loop_already_exists: "该 outcome 节点已经拥有 Bounded Loop。",
    loop_not_found: "Bounded Loop 已变化，请重新选择。",
    loop_policy_invalid: "循环次数必须在 1–5 次内。",
  };
  return messages[code] ?? `结构操作未应用（${code}）。`;
}

export function designerOperationClearsSelection(operation: DesignerOperation): boolean {
  return ![
    "insert_task",
    "set_default_activation",
    "update_node_config",
    "update_loop_policy",
  ].includes(operation.kind);
}

export function designerOperationContext(
  detail: EditableWorkflowDefinitionDetail,
  catalog: readonly CatalogNode[],
  blueprint: WorkflowBlueprintDto | undefined,
): DesignerOperationContext {
  return {
    slots: detail.slots,
    catalog,
    optionalNodeTypes: new Set(blueprint?.optionalNodeTypes ?? []),
    allowedChoiceSourceTypes: detail.allowedChoiceSourceTypes,
    loopRules: blueprint?.loopRules ?? [],
  };
}

export function uniqueDesignerNodeId(nodeType: string, root: WorkflowDefinitionSequence): string {
  const text = JSON.stringify(root);
  const prefix = `user.${nodeType}`;
  for (let suffix = 1; suffix <= 999; suffix += 1) {
    const candidate = `${prefix}.${String(suffix)}`;
    if (!text.includes(`"definitionNodeId":"${candidate}"`)) return candidate;
  }
  return `${prefix}.${Date.now().toString(36)}`;
}

export function selectedDesignerElement(
  root: WorkflowDefinitionSequence,
  selection: DesignerSelection | null,
): WorkflowDefinitionElement | undefined {
  if (selection === null) return undefined;
  return resolveDesignerSequence(root, selection.address)?.elements[selection.index];
}

export function diagnosticNodeId(
  diagnostic: WorkflowDesignerDiagnosticDto,
  root: WorkflowDefinitionSequence,
): string | undefined {
  const stack: WorkflowDefinitionElement[] = [...root.elements];
  while (stack.length > 0) {
    const element = stack.pop();
    if (element === undefined) continue;
    if (element.kind === "task" || element.kind === "composite") {
      if (diagnostic.path.includes(element.definitionNodeId)) return element.definitionNodeId;
    } else if (element.kind === "sequence") stack.push(...element.elements);
    else if (element.kind === "choice") {
      for (const branch of element.branches) stack.push(...branch.body.elements);
    } else stack.push(...element.body.elements);
  }
  return undefined;
}

export function designerDropOperation(
  slot: WorkflowDesignerSlotDto,
  payload: unknown,
  index: number,
  root: WorkflowDefinitionSequence,
): DesignerOperation | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const value = payload as Record<string, unknown>;
  if (value["kind"] === "catalog" && typeof value["nodeType"] === "string") {
    return {
      kind: "insert_task",
      slotId: slot.slotId,
      index,
      nodeType: value["nodeType"] as CatalogNode["nodeType"],
      definitionNodeId: uniqueDesignerNodeId(value["nodeType"], root),
    };
  }
  if (value["kind"] === "move" && typeof value["definitionNodeId"] === "string") {
    return {
      kind: "move_element",
      target: { definitionNodeId: value["definitionNodeId"] },
      slotId: slot.slotId,
      index,
    };
  }
  return undefined;
}

export function focusDesignerDiagnostic(
  diagnostic: WorkflowDesignerDiagnosticDto,
  root: WorkflowDefinitionSequence,
): void {
  const nodeId = diagnosticNodeId(diagnostic, root);
  const target =
    nodeId === undefined
      ? undefined
      : document.querySelector(`[data-node-id="${CSS.escape(nodeId)}"] button`);
  if (target instanceof HTMLElement) {
    target.focus();
    target.scrollIntoView({ block: "nearest", inline: "nearest" });
  } else document.getElementById("workflow-designer-global-diagnostics")?.focus();
}
