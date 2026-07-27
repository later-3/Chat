/**
 * Split the validation_plan section of an ExecutionDraft payload.
 *
 * The `contract` key holds the machine-frozen Validation Contract (Plan
 * revision + Capability compilation + argv/hash binding).  It is read-only in
 * the workbench: users review it here and must revise the Harness Plan to
 * change validation rules (E).  Every other key of validation_plan stays
 * normally editable.
 */

export interface ValidationPlanSplit {
  /** Keys the user may still edit (never contains `contract`). */
  editable: Record<string, unknown>;
  /** The frozen contract object, or null when this turn has none. */
  contract: Record<string, unknown> | null;
  /** Whether the payload carries a `contract` key at all (null vs absent). */
  hasContractKey: boolean;
}

export function splitValidationPlan(value: unknown): ValidationPlanSplit {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { editable: {}, contract: null, hasContractKey: false };
  }
  const record = value as Record<string, unknown>;
  const hasContractKey = "contract" in record;
  const { contract, ...rest } = record;
  return {
    editable: rest,
    contract:
      contract !== null && typeof contract === "object" && !Array.isArray(contract)
        ? (contract as Record<string, unknown>)
        : null,
    hasContractKey,
  };
}

/** Rebuild a validation_plan value after the user edited the editable keys. */
export function mergeValidationPlan(original: unknown, editable: unknown): Record<string, unknown> {
  const split = splitValidationPlan(original);
  const next =
    editable !== null && typeof editable === "object" && !Array.isArray(editable)
      ? { ...(editable as Record<string, unknown>) }
      : {};
  if (split.hasContractKey) {
    next.contract =
      original !== null && typeof original === "object"
        ? ((original as Record<string, unknown>).contract ?? null)
        : null;
  }
  return next;
}
