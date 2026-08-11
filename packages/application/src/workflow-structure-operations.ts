import { workflowDesignerOperationSchema, type WorkflowDesignerOperation } from "@chat/contracts";
import {
  applyWorkflowDesignerOperation,
  sortWorkflowDiagnostics,
  validateWorkflowStructure,
  type WorkflowDesignerOperationErrorCode,
  type WorkflowDesignerOperationPolicyShape,
  type WorkflowDiagnostic,
  type WorkflowNodeTypeKey,
  type WorkflowSequence,
} from "@chat/domain";
import {
  validateDefinitionAgainstBlueprint,
  type WorkflowBlueprint,
} from "./workflow-blueprints.js";
import { normalizeWorkflowDefinition } from "./workflow-definition-normalize.js";
import { DEFAULT_NODE_CATALOG, type NodeCatalog } from "./workflow-node-catalog.js";

export type WorkflowSequenceAddressSegment =
  | {
      readonly kind: "choice_branch";
      readonly fromDefinitionNodeId: string;
      readonly outcome: string;
    }
  | { readonly kind: "loop_body"; readonly outcomeFromDefinitionNodeId: string }
  | { readonly kind: "nested_sequence"; readonly index: number };

export type WorkflowSequenceAddress = readonly WorkflowSequenceAddressSegment[];

export interface WorkflowDesignerSlot {
  readonly slotId: string;
  readonly address: WorkflowSequenceAddress;
  readonly allowedNodeTypes: readonly WorkflowNodeTypeKey[];
  readonly minimumIndex: number;
  readonly maximumIndex: number;
  readonly maximumElements?: number;
}

export interface WorkflowDesignerPolicy {
  readonly blueprint: WorkflowBlueprint;
  /** 后端根据当前Definition生成具体drop zone；浏览器不能扩展它。 */
  readonly slots: readonly WorkflowDesignerSlot[];
  readonly allowedChoiceSourceTypes: readonly WorkflowNodeTypeKey[];
}

/** 网络、浏览器工作副本和Application历史使用同一组strict受限操作。 */
export type WorkflowStructureOperation = WorkflowDesignerOperation;

export type WorkflowStructureOperationResult =
  | {
      readonly success: true;
      readonly semanticRoot: WorkflowSequence;
      readonly definitionSha256: string;
    }
  | { readonly success: false; readonly diagnostics: readonly WorkflowDiagnostic[] };

/**
 * Domain只做不可变机械变换；Application随后重新执行Structure、Blueprint、Catalog和Hash全门。
 * 因此浏览器预览与服务端不会各自解释操作，而发布权威仍只在Application。
 */
export function applyWorkflowStructureOperation(
  root: WorkflowSequence,
  operation: WorkflowStructureOperation,
  policy: WorkflowDesignerPolicy,
  catalog: NodeCatalog = DEFAULT_NODE_CATALOG,
): WorkflowStructureOperationResult {
  const parsed = workflowDesignerOperationSchema.safeParse(operation);
  if (!parsed.success) {
    return {
      success: false,
      diagnostics: [invalid("designer.operation_contract_invalid", "$", {})],
    };
  }
  const changed = applyWorkflowDesignerOperation(
    root,
    parsed.data,
    toOperationPolicy(policy, catalog),
  );
  if (!changed.ok) {
    return {
      success: false,
      diagnostics: [operationDiagnostic(changed.code, parsed.data)],
    };
  }
  return validateDesignerRoot(changed.semanticRoot, policy.blueprint, catalog);
}

export function validateDesignerRoot(
  root: WorkflowSequence,
  blueprint: WorkflowBlueprint,
  catalog: NodeCatalog = DEFAULT_NODE_CATALOG,
): WorkflowStructureOperationResult {
  const structure = validateWorkflowStructure(root, {
    outcomesFor: (nodeType, schemaVersion) => catalog.get(nodeType, schemaVersion)?.outcomes,
  });
  const blueprintDiagnostics = validateDefinitionAgainstBlueprint(root, blueprint, catalog);
  if (structure.diagnostics.length > 0 || blueprintDiagnostics.length > 0) {
    return {
      success: false,
      diagnostics: sortWorkflowDiagnostics([...structure.diagnostics, ...blueprintDiagnostics]),
    };
  }
  const normalized = normalizeWorkflowDefinition(root, catalog);
  if (!normalized.success) return normalized;
  return {
    success: true,
    semanticRoot: normalized.normalized.semanticRoot,
    definitionSha256: normalized.normalized.definitionSha256,
  };
}

function toOperationPolicy(
  policy: WorkflowDesignerPolicy,
  catalog: NodeCatalog,
): WorkflowDesignerOperationPolicyShape {
  return {
    slots: policy.slots,
    nodes: catalog.list().map((descriptor) => ({
      nodeType: descriptor.nodeType,
      schemaVersion: descriptor.schemaVersion,
      executorKind: descriptor.executorKind,
      defaultConfig: descriptor.defaultConfig,
      publicConfigFields: descriptor.publicConfigFields,
      outcomes: descriptor.outcomes,
      skipPolicyKind: descriptor.skipPolicy.kind,
    })),
    optionalNodeTypes: policy.blueprint.optionalNodeTypes,
    allowedChoiceSourceTypes: policy.allowedChoiceSourceTypes,
    loopRules: policy.blueprint.loopRules,
  };
}

function operationDiagnostic(
  code: WorkflowDesignerOperationErrorCode,
  operation: WorkflowStructureOperation,
): WorkflowDiagnostic {
  const mapped = diagnosticCode(code, operation.kind);
  return invalid(mapped, "$", { operation: operation.kind });
}

function diagnosticCode(
  code: WorkflowDesignerOperationErrorCode,
  operationKind: WorkflowStructureOperation["kind"],
): string {
  if (code === "node_type_denied" && operationKind === "insert_task") {
    return "designer.insert_requires_optional_node";
  }
  if (code === "node_type_unknown" || code === "composite_creation_denied") {
    return "designer.insert_node_not_supported";
  }
  if (code === "definition_node_id_duplicate") return "designer.definition_node_id_exists";
  if (code === "slot_index_denied") return "designer.target_index_out_of_slot";
  if (code === "slot_full") return "designer.slot_cardinality_exceeded";
  if (code === "slot_not_found") return "designer.slot_not_found";
  if (code === "address_not_found") return "designer.slot_address_stale";
  if (code === "required_node_change_denied") {
    return operationKind === "remove_optional_task"
      ? "designer.required_node_cannot_be_removed"
      : "designer.node_cannot_be_default_skipped";
  }
  if (code === "node_skip_denied") return "designer.node_cannot_be_default_skipped";
  if (code === "config_field_unknown") return "designer.config_field_unknown";
  if (code === "config_value_invalid") return "designer.config_value_invalid";
  if (code === "selector_runtime_only") return "designer.selector_runtime_only";
  if (code === "choice_source_denied") return "designer.choice_source_not_allowed";
  if (code === "choice_already_exists") return "designer.choice_already_exists";
  if (code === "choice_not_found") return "designer.choice_not_found";
  if (code === "choice_branch_not_found") return "designer.choice_branch_not_found";
  if (code === "choice_outcomes_invalid") return "designer.choice_requires_enumerated_outcomes";
  if (code === "unwrap_would_discard_branch") return "designer.unwrap_would_discard_branch";
  if (code === "loop_range_invalid") return "designer.loop_range_invalid";
  if (code === "loop_source_outside_range") return "designer.loop_outcome_source_outside_range";
  if (code === "loop_already_exists") return "designer.loop_already_exists";
  if (code === "loop_not_found") return "designer.loop_not_found";
  if (code === "loop_policy_invalid") return "designer.loop_policy_not_allowed";
  if (code === "structure_move_denied") return "designer.structure_move_denied";
  if (code === "index_out_of_range") return "designer.node_not_found";
  return `designer.${code}`;
}

function invalid(
  code: string,
  path: string,
  params: Readonly<Record<string, string | number | boolean>>,
): WorkflowDiagnostic {
  return { family: "definition_invalid", code, path, params };
}
