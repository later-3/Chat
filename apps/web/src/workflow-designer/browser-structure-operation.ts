import type {
  WorkflowBlueprintDto,
  WorkflowCatalogDto,
  WorkflowDesignerOperation,
  WorkflowDesignerSlotDto,
} from "@chat/contracts/public";
import type { WorkflowDefinitionElement, WorkflowDefinitionSequence } from "./types.js";

type CatalogNode = WorkflowCatalogDto["nodes"][number];
type Address = WorkflowDesignerSlotDto["address"];
type MutableSequence = { kind: "sequence"; elements: WorkflowDefinitionElement[] };
type Executable = Extract<WorkflowDefinitionElement, { kind: "task" | "composite" }>;
type Choice = Extract<WorkflowDefinitionElement, { kind: "choice" }>;
type Loop = Extract<WorkflowDefinitionElement, { kind: "bounded_loop" }>;

export interface BrowserDesignerOperationPolicy {
  readonly slots: readonly WorkflowDesignerSlotDto[];
  readonly catalog: readonly CatalogNode[];
  readonly optionalNodeTypes: ReadonlySet<CatalogNode["nodeType"]>;
  readonly allowedChoiceSourceTypes: readonly CatalogNode["nodeType"][];
  readonly loopRules: WorkflowBlueprintDto["loopRules"];
}

export type BrowserDesignerOperationErrorCode =
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

export type BrowserDesignerOperationResult =
  | { readonly ok: true; readonly semanticRoot: WorkflowDefinitionSequence }
  | { readonly ok: false; readonly code: BrowserDesignerOperationErrorCode };

/**
 * 浏览器只做无副作用预览。Operation由公开strict合同限定；此处不得加入自由edge、表达式
 * 或Executor字段。Application会用Domain解释同一操作并执行完整发布校验。
 */
export function applyBrowserDesignerOperation(
  root: WorkflowDefinitionSequence,
  operation: WorkflowDesignerOperation,
  policy: BrowserDesignerOperationPolicy,
): BrowserDesignerOperationResult {
  const next = structuredClone(root);
  const error = mutate(next, operation, policy);
  return error === undefined ? { ok: true, semanticRoot: next } : { ok: false, code: error };
}

function mutate(
  root: WorkflowDefinitionSequence,
  operation: WorkflowDesignerOperation,
  policy: BrowserDesignerOperationPolicy,
): BrowserDesignerOperationErrorCode | undefined {
  if (operation.kind === "insert_task") return insertTask(root, operation, policy);
  if (operation.kind === "move_element") return moveElement(root, operation, policy);
  if (operation.kind === "remove_optional_task") {
    const located = findNode(root, operation.target.definitionNodeId);
    if (located === undefined) return "index_out_of_range";
    if (!policy.optionalNodeTypes.has(located.element.nodeType)) {
      return "required_node_change_denied";
    }
    located.parent.elements.splice(located.index, 1);
    return undefined;
  }
  if (operation.kind === "set_default_activation") {
    return setDefaultActivation(root, operation, policy);
  }
  if (operation.kind === "update_node_config") return updateConfig(root, operation, policy);
  if (operation.kind === "wrap_in_choice") return wrapChoice(root, operation, policy);
  if (operation.kind === "move_into_branch") return moveIntoBranch(root, operation);
  if (operation.kind === "unwrap_choice") return unwrapChoice(root, operation);
  if (operation.kind === "wrap_in_bounded_loop") return wrapLoop(root, operation, policy);
  if (operation.kind === "update_loop_policy") return updateLoop(root, operation, policy);
  return unwrapLoop(root, operation.outcomeFromDefinitionNodeId);
}

function insertTask(
  root: WorkflowDefinitionSequence,
  operation: Extract<WorkflowDesignerOperation, { kind: "insert_task" }>,
  policy: BrowserDesignerOperationPolicy,
): BrowserDesignerOperationErrorCode | undefined {
  if (!policy.optionalNodeTypes.has(operation.nodeType)) return "node_type_denied";
  const descriptor = findDescriptor(policy, operation.nodeType);
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
    config: defaultNodeConfig(descriptor),
    defaultActivation: "enabled",
  });
  return undefined;
}

function moveElement(
  root: WorkflowDefinitionSequence,
  operation: Extract<WorkflowDesignerOperation, { kind: "move_element" }>,
  policy: BrowserDesignerOperationPolicy,
): BrowserDesignerOperationErrorCode | undefined {
  const source = findNode(root, operation.target.definitionNodeId);
  if (source === undefined) return "index_out_of_range";
  const target = resolveSlot(root, operation.slotId, source.element.nodeType, policy);
  if (!target.ok) return target.code;
  const sameSequence = source.parent === target.sequence;
  const adjustedIndex =
    sameSequence && source.index < operation.index ? operation.index - 1 : operation.index;
  const indexError = validateSlotIndex(target.slot, target.sequence, adjustedIndex, sameSequence);
  if (indexError !== undefined) return indexError;
  source.parent.elements.splice(source.index, 1);
  target.sequence.elements.splice(adjustedIndex, 0, source.element);
  return undefined;
}

function setDefaultActivation(
  root: WorkflowDefinitionSequence,
  operation: Extract<WorkflowDesignerOperation, { kind: "set_default_activation" }>,
  policy: BrowserDesignerOperationPolicy,
): BrowserDesignerOperationErrorCode | undefined {
  const located = findNode(root, operation.target.definitionNodeId);
  if (located === undefined) return "index_out_of_range";
  if (!policy.optionalNodeTypes.has(located.element.nodeType)) {
    return "required_node_change_denied";
  }
  const descriptor = findDescriptor(policy, located.element.nodeType);
  if (descriptor?.canDefaultSkip !== true && operation.activation === "skipped") {
    return "node_skip_denied";
  }
  replaceNode(located, { ...located.element, defaultActivation: operation.activation });
  return undefined;
}

function updateConfig(
  root: WorkflowDefinitionSequence,
  operation: Extract<WorkflowDesignerOperation, { kind: "update_node_config" }>,
  policy: BrowserDesignerOperationPolicy,
): BrowserDesignerOperationErrorCode | undefined {
  const located = findNode(root, operation.target.definitionNodeId);
  if (located === undefined) return "index_out_of_range";
  const field = findDescriptor(policy, located.element.nodeType)?.publicConfigFields.find(
    (candidate) => candidate.name === operation.fieldName,
  );
  if (field === undefined) return "config_field_unknown";
  if (
    field.type === "resource_selector" ||
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

function wrapChoice(
  root: WorkflowDefinitionSequence,
  operation: Extract<WorkflowDesignerOperation, { kind: "wrap_in_choice" }>,
  policy: BrowserDesignerOperationPolicy,
): BrowserDesignerOperationErrorCode | undefined {
  const source = findNode(root, operation.fromDefinitionNodeId);
  if (source === undefined) return "index_out_of_range";
  if (!policy.allowedChoiceSourceTypes.includes(source.element.nodeType)) {
    return "choice_source_denied";
  }
  if (findChoice(root, operation.fromDefinitionNodeId) !== undefined) {
    return "choice_already_exists";
  }
  const outcomes = findDescriptor(policy, source.element.nodeType)?.outcomes;
  if (outcomes === undefined || new Set(outcomes).size < 2) return "choice_outcomes_invalid";
  source.parent.elements.splice(source.index + 1, 0, {
    kind: "choice",
    fromDefinitionNodeId: operation.fromDefinitionNodeId,
    branches: [...new Set(outcomes)].sort().map((outcome) => ({
      outcome,
      body: { kind: "sequence", elements: [] },
    })),
  });
  return undefined;
}

function moveIntoBranch(
  root: WorkflowDefinitionSequence,
  operation: Extract<WorkflowDesignerOperation, { kind: "move_into_branch" }>,
): BrowserDesignerOperationErrorCode | undefined {
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
  mutable(branch.body).elements.splice(adjustedIndex, 0, source.element);
  return undefined;
}

function unwrapChoice(
  root: WorkflowDefinitionSequence,
  operation: Extract<WorkflowDesignerOperation, { kind: "unwrap_choice" }>,
): BrowserDesignerOperationErrorCode | undefined {
  const choice = findChoice(root, operation.fromDefinitionNodeId);
  if (choice === undefined) return "choice_not_found";
  const selected = choice.element.branches.find(
    (branch) => branch.outcome === operation.preserveOutcome,
  );
  if (selected === undefined) return "choice_branch_not_found";
  if (
    choice.element.branches.some((branch) => branch !== selected && branch.body.elements.length)
  ) {
    return "unwrap_would_discard_branch";
  }
  choice.parent.elements.splice(choice.index, 1, ...selected.body.elements);
  return undefined;
}

function wrapLoop(
  root: WorkflowDefinitionSequence,
  operation: Extract<WorkflowDesignerOperation, { kind: "wrap_in_bounded_loop" }>,
  policy: BrowserDesignerOperationPolicy,
): BrowserDesignerOperationErrorCode | undefined {
  const sequence = resolveBrowserDesignerSequence(root, operation.address);
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
  if (rule === undefined || operation.maxIterations > rule.maxIterations) {
    return "loop_policy_invalid";
  }
  mutable(sequence).elements.splice(
    operation.startIndex,
    operation.endIndexExclusive - operation.startIndex,
    {
      kind: "bounded_loop",
      body: { kind: "sequence", elements: selected },
      outcomeFromDefinitionNodeId: operation.outcomeFromDefinitionNodeId,
      continueOutcomes: [...rule.continueOutcomes],
      exitOutcomes: [...rule.exitOutcomes],
      maxIterations: operation.maxIterations,
      exceededPolicy: operation.exceededPolicy,
    },
  );
  return undefined;
}

function updateLoop(
  root: WorkflowDefinitionSequence,
  operation: Extract<WorkflowDesignerOperation, { kind: "update_loop_policy" }>,
  policy: BrowserDesignerOperationPolicy,
): BrowserDesignerOperationErrorCode | undefined {
  const located = findLoop(root, operation.outcomeFromDefinitionNodeId);
  if (located === undefined) return "loop_not_found";
  const source = findNode(located.element.body, operation.outcomeFromDefinitionNodeId);
  const rule = policy.loopRules.find(
    (candidate) => candidate.outcomeNodeType === source?.element.nodeType,
  );
  if (rule === undefined || operation.maxIterations > rule.maxIterations) {
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
  root: WorkflowDefinitionSequence,
  outcomeFromDefinitionNodeId: string,
): BrowserDesignerOperationErrorCode | undefined {
  const located = findLoop(root, outcomeFromDefinitionNodeId);
  if (located === undefined) return "loop_not_found";
  located.parent.elements.splice(located.index, 1, ...located.element.body.elements);
  return undefined;
}

export function resolveBrowserDesignerSequence(
  root: WorkflowDefinitionSequence,
  address: Address,
): WorkflowDefinitionSequence | undefined {
  let current = root;
  for (const segment of address) {
    if (segment.kind === "nested_sequence") {
      const nested = current.elements[segment.index];
      if (nested?.kind !== "sequence") return undefined;
      current = nested;
    } else if (segment.kind === "loop_body") {
      const loops = current.elements.filter(
        (element): element is Loop =>
          element.kind === "bounded_loop" &&
          element.outcomeFromDefinitionNodeId === segment.outcomeFromDefinitionNodeId,
      );
      if (loops.length !== 1) return undefined;
      current = loops[0]!.body;
    } else {
      const choices = current.elements.filter(
        (element): element is Choice =>
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

interface LocatedNode {
  readonly parent: MutableSequence;
  readonly index: number;
  readonly element: Executable;
}

function findNode(
  root: WorkflowDefinitionSequence,
  definitionNodeId: string,
): LocatedNode | undefined {
  const sequences: MutableSequence[] = [mutable(root)];
  while (sequences.length) {
    const sequence = sequences.pop();
    if (sequence === undefined) continue;
    for (const [index, element] of sequence.elements.entries()) {
      if (element.kind === "task" || element.kind === "composite") {
        if (element.definitionNodeId === definitionNodeId)
          return { parent: sequence, index, element };
      } else pushChildren(sequences, element);
    }
  }
  return undefined;
}

function findNodeInElements(
  elements: readonly WorkflowDefinitionElement[],
  definitionNodeId: string,
): Executable | undefined {
  return findNode({ kind: "sequence", elements }, definitionNodeId)?.element;
}

function findChoice(root: WorkflowDefinitionSequence, sourceId: string) {
  return findContainer(
    root,
    (element): element is Choice =>
      element.kind === "choice" && element.fromDefinitionNodeId === sourceId,
  );
}

function findLoop(root: WorkflowDefinitionSequence, sourceId: string) {
  return findContainer(
    root,
    (element): element is Loop =>
      element.kind === "bounded_loop" && element.outcomeFromDefinitionNodeId === sourceId,
  );
}

function findContainer<T extends Choice | Loop>(
  root: WorkflowDefinitionSequence,
  matches: (element: WorkflowDefinitionElement) => element is T,
): { readonly parent: MutableSequence; readonly index: number; readonly element: T } | undefined {
  const sequences: MutableSequence[] = [mutable(root)];
  while (sequences.length) {
    const sequence = sequences.pop();
    if (sequence === undefined) continue;
    for (const [index, element] of sequence.elements.entries()) {
      if (matches(element)) return { parent: sequence, index, element };
      if (element.kind !== "task" && element.kind !== "composite") {
        pushChildren(sequences, element);
      }
    }
  }
  return undefined;
}

function pushChildren(target: MutableSequence[], element: WorkflowDefinitionElement): void {
  if (element.kind === "sequence") target.push(mutable(element));
  else if (element.kind === "bounded_loop") target.push(mutable(element.body));
  else if (element.kind === "choice") {
    for (const branch of element.branches) target.push(mutable(branch.body));
  }
}

function resolveSlot(
  root: WorkflowDefinitionSequence,
  slotId: string,
  nodeType: CatalogNode["nodeType"],
  policy: BrowserDesignerOperationPolicy,
) {
  const slot = policy.slots.find((candidate) => candidate.slotId === slotId);
  if (slot === undefined) return { ok: false as const, code: "slot_not_found" as const };
  if (!slot.allowedNodeTypes.includes(nodeType)) {
    return { ok: false as const, code: "node_type_denied" as const };
  }
  const sequence = resolveBrowserDesignerSequence(root, slot.address);
  return sequence === undefined
    ? { ok: false as const, code: "address_not_found" as const }
    : { ok: true as const, slot, sequence: mutable(sequence) };
}

function validateSlotIndex(
  slot: WorkflowDesignerSlotDto,
  sequence: MutableSequence,
  index: number,
  movingWithin: boolean,
): BrowserDesignerOperationErrorCode | undefined {
  const upper = Math.min(slot.maximumIndex, sequence.elements.length);
  if (index < slot.minimumIndex || index > upper) return "slot_index_denied";
  if (
    slot.maximumElements !== undefined &&
    sequence.elements.length >= slot.maximumElements &&
    !movingWithin
  ) {
    return "slot_full";
  }
  return undefined;
}

function findDescriptor(policy: BrowserDesignerOperationPolicy, nodeType: string) {
  return policy.catalog.find((candidate) => candidate.nodeType === nodeType);
}

function defaultNodeConfig(descriptor: CatalogNode): Readonly<Record<string, unknown>> {
  const entries: [string, unknown][] = [];
  for (const field of descriptor.publicConfigFields) {
    if ("defaultValue" in field) entries.push([field.name, field.defaultValue]);
    else if (field.type === "tag_list") entries.push([field.name, []]);
  }
  return Object.fromEntries(entries);
}

function validConfigValue(
  field: CatalogNode["publicConfigFields"][number],
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
    value.every((item) => item.length > 0 && item.length <= field.maxLabelLength)
  );
}

function replaceNode(located: LocatedNode, element: Executable): void {
  located.parent.elements.splice(located.index, 1, element);
}

function mutable(sequence: WorkflowDefinitionSequence): MutableSequence {
  return sequence as MutableSequence;
}
