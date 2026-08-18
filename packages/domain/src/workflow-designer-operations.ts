import type {
  WorkflowBoundedLoopElement,
  WorkflowChoiceElement,
  WorkflowCompositeElement,
  WorkflowElement,
  WorkflowNodeTypeKey,
  WorkflowSequence,
  WorkflowTaskElement,
} from "./workflow-definition-kernel.js";

/** 浏览器与Application共同使用的纯结构操作形状；网络边界由Contracts strict Schema拥有。 */
export type WorkflowDesignerAddressSegmentShape =
  | {
      readonly kind: "choice_branch";
      readonly fromDefinitionNodeId: string;
      readonly outcome: string;
    }
  | { readonly kind: "loop_body"; readonly outcomeFromDefinitionNodeId: string }
  | { readonly kind: "nested_sequence"; readonly index: number };

export type WorkflowDesignerAddressShape = readonly WorkflowDesignerAddressSegmentShape[];

interface ElementTargetShape {
  readonly definitionNodeId: string;
}

export type WorkflowDesignerOperationShape =
  | {
      readonly kind: "insert_task";
      readonly slotId: string;
      readonly index: number;
      readonly nodeType: WorkflowNodeTypeKey;
      readonly definitionNodeId: string;
    }
  | {
      readonly kind: "move_element";
      readonly target: ElementTargetShape;
      readonly slotId: string;
      readonly index: number;
    }
  | { readonly kind: "remove_optional_task"; readonly target: ElementTargetShape }
  | {
      readonly kind: "set_default_activation";
      readonly target: ElementTargetShape;
      readonly activation: "enabled" | "skipped";
    }
  | {
      readonly kind: "update_node_config";
      readonly target: ElementTargetShape;
      readonly fieldName: string;
      readonly value: boolean | number | string | readonly string[];
    }
  | { readonly kind: "wrap_in_choice"; readonly fromDefinitionNodeId: string }
  | {
      readonly kind: "move_into_branch";
      readonly target: ElementTargetShape;
      readonly fromDefinitionNodeId: string;
      readonly outcome: string;
      readonly index: number;
    }
  | {
      readonly kind: "unwrap_choice";
      readonly fromDefinitionNodeId: string;
      readonly preserveOutcome: string;
    }
  | {
      readonly kind: "wrap_in_bounded_loop";
      readonly address: WorkflowDesignerAddressShape;
      readonly startIndex: number;
      readonly endIndexExclusive: number;
      readonly outcomeFromDefinitionNodeId: string;
      readonly maxIterations: number;
      readonly exceededPolicy: "fail" | "request_human";
    }
  | {
      readonly kind: "update_loop_policy";
      readonly outcomeFromDefinitionNodeId: string;
      readonly maxIterations: number;
      readonly exceededPolicy: "fail" | "request_human";
    }
  | { readonly kind: "unwrap_loop"; readonly outcomeFromDefinitionNodeId: string };

export type WorkflowDesignerConfigFieldShape =
  | { readonly type: "boolean"; readonly name: string }
  | {
      readonly type: "enum_select" | "review_mode";
      readonly name: string;
      readonly options: readonly string[];
    }
  | {
      readonly type: "bounded_integer";
      readonly name: string;
      readonly minimum: number;
      readonly maximum: number;
    }
  | { readonly type: "short_text"; readonly name: string; readonly maximumLength: number }
  | {
      readonly type: "tag_list";
      readonly name: string;
      readonly maxItems: number;
      readonly maxLabelLength: number;
    }
  | {
      readonly type:
        | "resource_selector"
        | "memory_provider_selector"
        | "rule_selector"
        | "skill_selector"
        | "note_source_selector";
      readonly name: string;
    };

export interface WorkflowDesignerNodePolicyShape {
  readonly nodeType: WorkflowNodeTypeKey;
  readonly schemaVersion: number;
  readonly executorKind: "step" | "human_review" | "composite";
  readonly defaultConfig: Readonly<Record<string, unknown>>;
  readonly publicConfigFields: readonly WorkflowDesignerConfigFieldShape[];
  readonly outcomes: readonly string[];
  readonly skipPolicyKind: "never" | "allowed_with_default_outcome" | "allowed_with_explicit_value";
}

export interface WorkflowDesignerSlotPolicyShape {
  readonly slotId: string;
  readonly address: WorkflowDesignerAddressShape;
  readonly allowedNodeTypes: readonly WorkflowNodeTypeKey[];
  readonly minimumIndex: number;
  readonly maximumIndex: number;
  readonly maximumElements?: number | undefined;
}

export interface WorkflowDesignerLoopRuleShape {
  readonly outcomeNodeType: WorkflowNodeTypeKey;
  readonly continueOutcomes: readonly string[];
  readonly exitOutcomes: readonly string[];
  readonly maxIterations: number;
}

export interface WorkflowDesignerOperationPolicyShape {
  readonly slots: readonly WorkflowDesignerSlotPolicyShape[];
  readonly nodes: readonly WorkflowDesignerNodePolicyShape[];
  readonly optionalNodeTypes: readonly WorkflowNodeTypeKey[];
  readonly allowedChoiceSourceTypes: readonly WorkflowNodeTypeKey[];
  readonly loopRules: readonly WorkflowDesignerLoopRuleShape[];
}

export type WorkflowDesignerOperationErrorCode =
  | "operation_contract_invalid"
  | "slot_not_found"
  | "address_not_found"
  | "index_out_of_range"
  | "slot_index_denied"
  | "slot_full"
  | "node_type_denied"
  | "node_type_unknown"
  | "composite_creation_denied"
  | "definition_node_id_duplicate"
  | "required_node_change_denied"
  | "node_skip_denied"
  | "structure_move_denied"
  | "config_field_unknown"
  | "config_value_invalid"
  | "selector_runtime_only"
  | "choice_source_denied"
  | "choice_already_exists"
  | "choice_not_found"
  | "choice_branch_not_found"
  | "choice_outcomes_invalid"
  | "unwrap_would_discard_branch"
  | "loop_range_invalid"
  | "loop_source_outside_range"
  | "loop_already_exists"
  | "loop_not_found"
  | "loop_policy_invalid";

export type WorkflowDesignerOperationResultShape =
  | { readonly ok: true; readonly semanticRoot: WorkflowSequence }
  | { readonly ok: false; readonly code: WorkflowDesignerOperationErrorCode };

type MutableSequence = { kind: "sequence"; elements: WorkflowElement[] };
type MutableExecutableElement = (WorkflowTaskElement | WorkflowCompositeElement) & {
  config: Readonly<Record<string, unknown>>;
};

interface LocatedNode {
  readonly parent: MutableSequence;
  readonly index: number;
  readonly element: MutableExecutableElement;
}

interface LocatedChoice {
  readonly parent: MutableSequence;
  readonly index: number;
  readonly element: WorkflowChoiceElement & {
    branches: { outcome: string; body: MutableSequence }[];
  };
}

interface LocatedLoop {
  readonly parent: MutableSequence;
  readonly index: number;
  readonly element: WorkflowBoundedLoopElement & { body: MutableSequence };
}

/**
 * 唯一的Designer机械变换器。它只操作受限IR，不做发布判断；Application必须在成功后
 * 再运行完整Domain/Blueprint/Catalog Validator，浏览器的成功只代表本地操作可应用。
 */
export function applyWorkflowDesignerOperation(
  root: WorkflowSequence,
  operation: WorkflowDesignerOperationShape,
  policy: WorkflowDesignerOperationPolicyShape,
): WorkflowDesignerOperationResultShape {
  const next = structuredClone(root) as WorkflowSequence;
  const error = mutate(next, operation, policy);
  return error === undefined ? { ok: true, semanticRoot: next } : { ok: false, code: error };
}

function mutate(
  root: WorkflowSequence,
  operation: WorkflowDesignerOperationShape,
  policy: WorkflowDesignerOperationPolicyShape,
): WorkflowDesignerOperationErrorCode | undefined {
  switch (operation.kind) {
    case "insert_task":
      return insertTask(root, operation, policy);
    case "move_element":
      return moveElement(root, operation, policy);
    case "remove_optional_task":
      return removeOptionalTask(root, operation.target, policy);
    case "set_default_activation":
      return setDefaultActivation(root, operation.target, operation.activation, policy);
    case "update_node_config":
      return updateNodeConfig(root, operation, policy);
    case "wrap_in_choice":
      return wrapInChoice(root, operation.fromDefinitionNodeId, policy);
    case "move_into_branch":
      return moveIntoBranch(root, operation);
    case "unwrap_choice":
      return unwrapChoice(root, operation.fromDefinitionNodeId, operation.preserveOutcome);
    case "wrap_in_bounded_loop":
      return wrapInBoundedLoop(root, operation, policy);
    case "update_loop_policy":
      return updateLoopPolicy(root, operation, policy);
    case "unwrap_loop":
      return unwrapLoop(root, operation.outcomeFromDefinitionNodeId);
  }
}

function insertTask(
  root: WorkflowSequence,
  operation: Extract<WorkflowDesignerOperationShape, { kind: "insert_task" }>,
  policy: WorkflowDesignerOperationPolicyShape,
): WorkflowDesignerOperationErrorCode | undefined {
  if (!policy.optionalNodeTypes.includes(operation.nodeType)) return "node_type_denied";
  const descriptor = nodePolicy(policy, operation.nodeType);
  if (descriptor === undefined) return "node_type_unknown";
  if (descriptor.executorKind === "composite") return "composite_creation_denied";
  if (findNode(root, operation.definitionNodeId) !== undefined) {
    return "definition_node_id_duplicate";
  }
  const target = resolveSlot(root, operation.slotId, operation.nodeType, policy);
  if (!target.ok) return target.code;
  const indexError = validateSlotIndex(target.slot, target.sequence, operation.index, false);
  if (indexError !== undefined) return indexError;
  target.sequence.elements.splice(operation.index, 0, {
    kind: "task",
    definitionNodeId: operation.definitionNodeId,
    nodeType: operation.nodeType,
    schemaVersion: descriptor.schemaVersion,
    config: structuredClone(descriptor.defaultConfig),
    defaultActivation: "enabled",
  });
  return undefined;
}

function moveElement(
  root: WorkflowSequence,
  operation: Extract<WorkflowDesignerOperationShape, { kind: "move_element" }>,
  policy: WorkflowDesignerOperationPolicyShape,
): WorkflowDesignerOperationErrorCode | undefined {
  const located = findNode(root, operation.target.definitionNodeId);
  if (located === undefined) return "index_out_of_range";
  const target = resolveSlot(root, operation.slotId, located.element.nodeType, policy);
  if (!target.ok) return target.code;
  const sameSequence = located.parent === target.sequence;
  const adjustedIndex =
    sameSequence && located.index < operation.index ? operation.index - 1 : operation.index;
  const indexError = validateSlotIndex(target.slot, target.sequence, adjustedIndex, sameSequence);
  if (indexError !== undefined) return indexError;
  located.parent.elements.splice(located.index, 1);
  target.sequence.elements.splice(adjustedIndex, 0, located.element);
  return undefined;
}

function removeOptionalTask(
  root: WorkflowSequence,
  target: ElementTargetShape,
  policy: WorkflowDesignerOperationPolicyShape,
): WorkflowDesignerOperationErrorCode | undefined {
  const located = findNode(root, target.definitionNodeId);
  if (located === undefined) return "index_out_of_range";
  if (!policy.optionalNodeTypes.includes(located.element.nodeType)) {
    return "required_node_change_denied";
  }
  located.parent.elements.splice(located.index, 1);
  return undefined;
}

function setDefaultActivation(
  root: WorkflowSequence,
  target: ElementTargetShape,
  activation: "enabled" | "skipped",
  policy: WorkflowDesignerOperationPolicyShape,
): WorkflowDesignerOperationErrorCode | undefined {
  const located = findNode(root, target.definitionNodeId);
  if (located === undefined) return "index_out_of_range";
  const descriptor = nodePolicy(policy, located.element.nodeType);
  if (!policy.optionalNodeTypes.includes(located.element.nodeType)) {
    return "required_node_change_denied";
  }
  if (
    descriptor === undefined ||
    (activation === "skipped" && descriptor.skipPolicyKind === "never")
  ) {
    return "node_skip_denied";
  }
  replaceNode(located, { ...located.element, defaultActivation: activation });
  return undefined;
}

function updateNodeConfig(
  root: WorkflowSequence,
  operation: Extract<WorkflowDesignerOperationShape, { kind: "update_node_config" }>,
  policy: WorkflowDesignerOperationPolicyShape,
): WorkflowDesignerOperationErrorCode | undefined {
  const located = findNode(root, operation.target.definitionNodeId);
  if (located === undefined) return "index_out_of_range";
  const descriptor = nodePolicy(policy, located.element.nodeType);
  const field = descriptor?.publicConfigFields.find(
    (candidate) => candidate.name === operation.fieldName,
  );
  if (field === undefined) return "config_field_unknown";
  if (
    field.type === "resource_selector" ||
    field.type === "memory_provider_selector" ||
    field.type === "rule_selector" ||
    field.type === "skill_selector" ||
    field.type === "note_source_selector"
  ) {
    return "selector_runtime_only";
  }
  if (!validConfigValue(field, operation.value)) return "config_value_invalid";
  replaceNode(located, {
    ...located.element,
    config: { ...located.element.config, [operation.fieldName]: structuredClone(operation.value) },
  });
  return undefined;
}

function wrapInChoice(
  root: WorkflowSequence,
  fromDefinitionNodeId: string,
  policy: WorkflowDesignerOperationPolicyShape,
): WorkflowDesignerOperationErrorCode | undefined {
  const source = findNode(root, fromDefinitionNodeId);
  if (source === undefined) return "index_out_of_range";
  if (!policy.allowedChoiceSourceTypes.includes(source.element.nodeType)) {
    return "choice_source_denied";
  }
  if (findChoice(root, fromDefinitionNodeId) !== undefined) return "choice_already_exists";
  const outcomes = nodePolicy(policy, source.element.nodeType)?.outcomes;
  if (outcomes === undefined || new Set(outcomes).size < 2) return "choice_outcomes_invalid";
  const choice: WorkflowChoiceElement = {
    kind: "choice",
    fromDefinitionNodeId,
    branches: [...new Set(outcomes)].sort().map((outcome) => ({
      outcome,
      body: { kind: "sequence", elements: [] },
    })),
  };
  source.parent.elements.splice(source.index + 1, 0, choice);
  return undefined;
}

function moveIntoBranch(
  root: WorkflowSequence,
  operation: Extract<WorkflowDesignerOperationShape, { kind: "move_into_branch" }>,
): WorkflowDesignerOperationErrorCode | undefined {
  if (operation.target.definitionNodeId === operation.fromDefinitionNodeId) {
    return "structure_move_denied";
  }
  const source = findNode(root, operation.target.definitionNodeId);
  if (source === undefined) return "index_out_of_range";
  const choice = findChoice(root, operation.fromDefinitionNodeId);
  if (choice === undefined) return "choice_not_found";
  const branch = choice.element.branches.find(
    (candidate) => candidate.outcome === operation.outcome,
  );
  if (branch === undefined) return "choice_branch_not_found";
  if (operation.index < 0 || operation.index > branch.body.elements.length) {
    return "index_out_of_range";
  }
  const adjustedIndex =
    source.parent === branch.body && source.index < operation.index
      ? operation.index - 1
      : operation.index;
  source.parent.elements.splice(source.index, 1);
  (branch.body as MutableSequence).elements.splice(adjustedIndex, 0, source.element);
  return undefined;
}

function unwrapChoice(
  root: WorkflowSequence,
  fromDefinitionNodeId: string,
  preserveOutcome: string,
): WorkflowDesignerOperationErrorCode | undefined {
  const choice = findChoice(root, fromDefinitionNodeId);
  if (choice === undefined) return "choice_not_found";
  const selected = choice.element.branches.find((branch) => branch.outcome === preserveOutcome);
  if (selected === undefined) return "choice_branch_not_found";
  if (
    choice.element.branches.some((branch) => branch !== selected && branch.body.elements.length > 0)
  ) {
    return "unwrap_would_discard_branch";
  }
  choice.parent.elements.splice(choice.index, 1, ...selected.body.elements);
  return undefined;
}

function wrapInBoundedLoop(
  root: WorkflowSequence,
  operation: Extract<WorkflowDesignerOperationShape, { kind: "wrap_in_bounded_loop" }>,
  policy: WorkflowDesignerOperationPolicyShape,
): WorkflowDesignerOperationErrorCode | undefined {
  const sequence = resolveWorkflowDesignerSequence(root, operation.address);
  if (sequence === undefined) return "address_not_found";
  if (
    operation.startIndex < 0 ||
    operation.endIndexExclusive <= operation.startIndex ||
    operation.endIndexExclusive > sequence.elements.length
  ) {
    return "loop_range_invalid";
  }
  if (findLoop(root, operation.outcomeFromDefinitionNodeId) !== undefined) {
    return "loop_already_exists";
  }
  const selected = sequence.elements.slice(operation.startIndex, operation.endIndexExclusive);
  const source = findNodeInElements(selected, operation.outcomeFromDefinitionNodeId);
  if (source === undefined) return "loop_source_outside_range";
  const rule = policy.loopRules.find((candidate) => candidate.outcomeNodeType === source.nodeType);
  if (
    rule === undefined ||
    !Number.isInteger(operation.maxIterations) ||
    operation.maxIterations < 1 ||
    operation.maxIterations > rule.maxIterations
  ) {
    return "loop_policy_invalid";
  }
  const loop: WorkflowBoundedLoopElement = {
    kind: "bounded_loop",
    body: { kind: "sequence", elements: selected },
    outcomeFromDefinitionNodeId: operation.outcomeFromDefinitionNodeId,
    continueOutcomes: [...rule.continueOutcomes],
    exitOutcomes: [...rule.exitOutcomes],
    maxIterations: operation.maxIterations,
    exceededPolicy: operation.exceededPolicy,
  };
  (sequence as MutableSequence).elements.splice(
    operation.startIndex,
    operation.endIndexExclusive - operation.startIndex,
    loop,
  );
  return undefined;
}

function updateLoopPolicy(
  root: WorkflowSequence,
  operation: Extract<WorkflowDesignerOperationShape, { kind: "update_loop_policy" }>,
  policy: WorkflowDesignerOperationPolicyShape,
): WorkflowDesignerOperationErrorCode | undefined {
  const located = findLoop(root, operation.outcomeFromDefinitionNodeId);
  if (located === undefined) return "loop_not_found";
  const source = findNode(located.element.body, operation.outcomeFromDefinitionNodeId);
  const rule =
    source === undefined
      ? undefined
      : policy.loopRules.find((candidate) => candidate.outcomeNodeType === source.element.nodeType);
  if (
    rule === undefined ||
    !Number.isInteger(operation.maxIterations) ||
    operation.maxIterations < 1 ||
    operation.maxIterations > rule.maxIterations
  ) {
    return "loop_policy_invalid";
  }
  located.parent.elements.splice(located.index, 1, {
    ...located.element,
    maxIterations: operation.maxIterations,
    exceededPolicy: operation.exceededPolicy,
    continueOutcomes: [...rule.continueOutcomes],
    exitOutcomes: [...rule.exitOutcomes],
  });
  return undefined;
}

function unwrapLoop(
  root: WorkflowSequence,
  outcomeFromDefinitionNodeId: string,
): WorkflowDesignerOperationErrorCode | undefined {
  const located = findLoop(root, outcomeFromDefinitionNodeId);
  if (located === undefined) return "loop_not_found";
  located.parent.elements.splice(located.index, 1, ...located.element.body.elements);
  return undefined;
}

function nodePolicy(
  policy: WorkflowDesignerOperationPolicyShape,
  nodeType: WorkflowNodeTypeKey,
): WorkflowDesignerNodePolicyShape | undefined {
  return policy.nodes.find((candidate) => candidate.nodeType === nodeType);
}

function validConfigValue(
  field: WorkflowDesignerConfigFieldShape,
  value: boolean | number | string | readonly string[],
): boolean {
  if (field.type === "boolean") return typeof value === "boolean";
  if (field.type === "enum_select" || field.type === "review_mode") {
    return typeof value === "string" && field.options.includes(value);
  }
  if (field.type === "bounded_integer") {
    return (
      typeof value === "number" &&
      Number.isInteger(value) &&
      value >= field.minimum &&
      value <= field.maximum
    );
  }
  if (field.type === "short_text") {
    return typeof value === "string" && value.length <= field.maximumLength;
  }
  if (field.type !== "tag_list") return false;
  return (
    Array.isArray(value) &&
    value.length <= field.maxItems &&
    value.every(
      (item) => typeof item === "string" && item.length > 0 && item.length <= field.maxLabelLength,
    )
  );
}

function findNode(root: WorkflowSequence, definitionNodeId: string): LocatedNode | undefined {
  const sequences: MutableSequence[] = [root as MutableSequence];
  while (sequences.length > 0) {
    const sequence = sequences.pop();
    if (sequence === undefined) break;
    for (let index = 0; index < sequence.elements.length; index += 1) {
      const element = sequence.elements[index];
      if (element === undefined) continue;
      if (element.kind === "task" || element.kind === "composite") {
        if (element.definitionNodeId === definitionNodeId) {
          return { parent: sequence, index, element: element as MutableExecutableElement };
        }
      } else pushChildSequences(sequences, element);
    }
  }
  return undefined;
}

function findNodeInElements(
  elements: readonly WorkflowElement[],
  definitionNodeId: string,
): WorkflowTaskElement | WorkflowCompositeElement | undefined {
  return findNode({ kind: "sequence", elements }, definitionNodeId)?.element;
}

function findChoice(
  root: WorkflowSequence,
  fromDefinitionNodeId: string,
): LocatedChoice | undefined {
  const sequences: MutableSequence[] = [root as MutableSequence];
  while (sequences.length > 0) {
    const sequence = sequences.pop();
    if (sequence === undefined) break;
    for (let index = 0; index < sequence.elements.length; index += 1) {
      const element = sequence.elements[index];
      if (element === undefined) continue;
      if (element.kind === "choice" && element.fromDefinitionNodeId === fromDefinitionNodeId) {
        return { parent: sequence, index, element: element as LocatedChoice["element"] };
      }
      if (element.kind !== "task" && element.kind !== "composite") {
        pushChildSequences(sequences, element);
      }
    }
  }
  return undefined;
}

function findLoop(
  root: WorkflowSequence,
  outcomeFromDefinitionNodeId: string,
): LocatedLoop | undefined {
  const sequences: MutableSequence[] = [root as MutableSequence];
  while (sequences.length > 0) {
    const sequence = sequences.pop();
    if (sequence === undefined) break;
    for (let index = 0; index < sequence.elements.length; index += 1) {
      const element = sequence.elements[index];
      if (element === undefined) continue;
      if (
        element.kind === "bounded_loop" &&
        element.outcomeFromDefinitionNodeId === outcomeFromDefinitionNodeId
      ) {
        return { parent: sequence, index, element: element as LocatedLoop["element"] };
      }
      if (element.kind !== "task" && element.kind !== "composite") {
        pushChildSequences(sequences, element);
      }
    }
  }
  return undefined;
}

function pushChildSequences(target: MutableSequence[], element: WorkflowElement): void {
  if (element.kind === "sequence") target.push(element as MutableSequence);
  else if (element.kind === "bounded_loop") target.push(element.body as MutableSequence);
  else if (element.kind === "choice") {
    for (const branch of element.branches) target.push(branch.body as MutableSequence);
  }
}

function replaceNode(
  located: LocatedNode,
  replacement: WorkflowTaskElement | WorkflowCompositeElement,
): void {
  located.parent.elements.splice(located.index, 1, replacement);
}

export function resolveWorkflowDesignerSequence(
  root: WorkflowSequence,
  address: WorkflowDesignerAddressShape,
): WorkflowSequence | undefined {
  let current = root;
  for (const segment of address) {
    if (segment.kind === "nested_sequence") {
      const nested = current.elements[segment.index];
      if (nested?.kind !== "sequence") return undefined;
      current = nested;
    } else if (segment.kind === "loop_body") {
      const matches = current.elements.filter(
        (element): element is WorkflowBoundedLoopElement =>
          element.kind === "bounded_loop" &&
          element.outcomeFromDefinitionNodeId === segment.outcomeFromDefinitionNodeId,
      );
      if (matches.length !== 1) return undefined;
      current = matches[0]!.body;
    } else {
      const choices = current.elements.filter(
        (element): element is WorkflowChoiceElement =>
          element.kind === "choice" &&
          element.fromDefinitionNodeId === segment.fromDefinitionNodeId,
      );
      if (choices.length !== 1) return undefined;
      const branch = choices[0]!.branches.find(
        (candidate) => candidate.outcome === segment.outcome,
      );
      if (branch === undefined) return undefined;
      current = branch.body;
    }
  }
  return current;
}

type SlotResolution =
  | {
      readonly ok: true;
      readonly slot: WorkflowDesignerSlotPolicyShape;
      readonly sequence: MutableSequence;
    }
  | { readonly ok: false; readonly code: WorkflowDesignerOperationErrorCode };

function resolveSlot(
  root: WorkflowSequence,
  slotId: string,
  nodeType: WorkflowNodeTypeKey,
  policy: WorkflowDesignerOperationPolicyShape,
): SlotResolution {
  const slot = policy.slots.find((candidate) => candidate.slotId === slotId);
  if (slot === undefined) return { ok: false, code: "slot_not_found" };
  if (!slot.allowedNodeTypes.includes(nodeType)) return { ok: false, code: "node_type_denied" };
  const sequence = resolveWorkflowDesignerSequence(root, slot.address);
  return sequence === undefined
    ? { ok: false, code: "address_not_found" }
    : { ok: true, slot, sequence: sequence as MutableSequence };
}

function validateSlotIndex(
  slot: WorkflowDesignerSlotPolicyShape,
  sequence: MutableSequence,
  index: number,
  movingWithinSameSequence: boolean,
): WorkflowDesignerOperationErrorCode | undefined {
  const upper = Math.min(slot.maximumIndex, sequence.elements.length);
  if (index < slot.minimumIndex || index > upper) return "slot_index_denied";
  if (
    slot.maximumElements !== undefined &&
    sequence.elements.length >= slot.maximumElements &&
    !movingWithinSameSequence
  ) {
    return "slot_full";
  }
  return undefined;
}
