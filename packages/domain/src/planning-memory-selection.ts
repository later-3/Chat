import { canonicalJsonStringify, hashCanonical } from "./canonical-hash.js";

export interface PlanningMemorySelectionShape {
  readonly planningMemorySelectionId: string;
  readonly productRunId: string;
  readonly workflowRunSpecId: string;
  readonly workflowRunSpecSha256: string;
  readonly definitionNodeId: string;
  readonly maxItems: number;
  readonly selected: readonly {
    readonly memoryResultSnapshotId: string;
    readonly revision: 1;
    readonly sha256: string;
  }[];
  readonly sha256: string;
  readonly revision: 1;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function computePlanningMemorySelectionSha256(
  selection: Pick<
    PlanningMemorySelectionShape,
    | "productRunId"
    | "workflowRunSpecId"
    | "workflowRunSpecSha256"
    | "definitionNodeId"
    | "maxItems"
    | "selected"
  >,
): string {
  return hashCanonical("planning-memory-selection.v1", {
    productRunId: selection.productRunId,
    workflowRunSpecId: selection.workflowRunSpecId,
    workflowRunSpecSha256: selection.workflowRunSpecSha256,
    definitionNodeId: selection.definitionNodeId,
    maxItems: selection.maxItems,
    selected: selection.selected.map((item) => ({ ...item })),
  });
}

export function assertPlanningMemorySelectionIntegrity(
  selection: PlanningMemorySelectionShape,
): void {
  if (
    !Number.isInteger(selection.maxItems) ||
    selection.maxItems < 1 ||
    selection.maxItems > 20 ||
    selection.selected.length === 0 ||
    selection.selected.length > selection.maxItems
  ) {
    throw new Error("planning_memory_selection.items_invalid");
  }
  const identities = selection.selected.map((item) => item.memoryResultSnapshotId);
  if (
    new Set(identities).size !== identities.length ||
    canonicalJsonStringify(identities) !== canonicalJsonStringify([...identities].sort())
  ) {
    throw new Error("planning_memory_selection.order_or_identity_invalid");
  }
  if (computePlanningMemorySelectionSha256(selection) !== selection.sha256) {
    throw new Error("planning_memory_selection.hash_invalid");
  }
  if (selection.createdAt !== selection.updatedAt) {
    throw new Error("planning_memory_selection.immutable_timestamp_invalid");
  }
}
