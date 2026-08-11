import {
  workflowDesignerOperationSchema,
  type WorkflowCatalogDto,
  type WorkflowDesignerAddress,
  type WorkflowDesignerDiagnosticDto,
  type WorkflowDesignerOperation,
  type WorkflowDesignerSlotDto,
} from "@chat/contracts/public";
import {
  applyBrowserDesignerOperation,
  resolveBrowserDesignerSequence,
  type BrowserDesignerOperationErrorCode,
  type BrowserDesignerOperationPolicy,
} from "./browser-structure-operation.js";
import type { WorkflowDefinitionSequence } from "./types.js";

export type DesignerAddress = WorkflowDesignerAddress;
export type CatalogNode = WorkflowCatalogDto["nodes"][number];
export type DesignerOperation = WorkflowDesignerOperation;
export type DesignerOperationErrorCode =
  BrowserDesignerOperationErrorCode | "operation_contract_invalid";

export type DesignerOperationContext = BrowserDesignerOperationPolicy;

export type DesignerOperationResult =
  | { readonly ok: true; readonly semanticRoot: WorkflowDefinitionSequence }
  | { readonly ok: false; readonly code: DesignerOperationErrorCode };

/**
 * 浏览器与Application调用同一个Domain纯变换器；这里只负责strict合同解析和安全公开
 * Catalog/Blueprint投影。浏览器结果是即时预览，保存与发布仍由服务端完整校验。
 */
export function applyDesignerOperation(
  root: WorkflowDefinitionSequence,
  operation: DesignerOperation,
  context: DesignerOperationContext,
): DesignerOperationResult {
  const parsed = workflowDesignerOperationSchema.safeParse(operation);
  if (!parsed.success) return { ok: false, code: "operation_contract_invalid" };
  return applyBrowserDesignerOperation(root, parsed.data, context);
}

export function resolveDesignerSequence(
  root: WorkflowDefinitionSequence,
  address: DesignerAddress,
): WorkflowDefinitionSequence | undefined {
  return resolveBrowserDesignerSequence(root, address);
}

export function reapplyDesignerOperations(
  base: WorkflowDefinitionSequence,
  operations: readonly DesignerOperation[],
  context: DesignerOperationContext,
):
  | { readonly ok: true; readonly semanticRoot: WorkflowDefinitionSequence }
  | {
      readonly ok: false;
      readonly semanticRoot: WorkflowDefinitionSequence;
      readonly failedIndex: number;
      readonly code: DesignerOperationErrorCode;
    } {
  let current = structuredClone(base);
  for (const [index, operation] of operations.entries()) {
    const result = applyDesignerOperation(current, operation, context);
    if (!result.ok)
      return { ok: false, semanticRoot: current, failedIndex: index, code: result.code };
    current = result.semanticRoot;
  }
  return { ok: true, semanticRoot: current };
}

/** 快速反馈只覆盖浏览器能确定的结构事实；发布是否合法仍由服务端Validator决定。 */
export function quickDesignerDiagnostics(
  root: WorkflowDefinitionSequence,
): readonly WorkflowDesignerDiagnosticDto[] {
  const diagnostics: WorkflowDesignerDiagnosticDto[] = [];
  const seen = new Set<string>();
  const visit = (sequence: WorkflowDefinitionSequence, path: string) => {
    for (const [index, element] of sequence.elements.entries()) {
      const elementPath = `${path}.elements.${String(index)}`;
      if (element.kind === "task" || element.kind === "composite") {
        if (seen.has(element.definitionNodeId)) {
          diagnostics.push({
            family: "definition_invalid",
            code: "definition.node_id_duplicate",
            path: `${elementPath}.definitionNodeId`,
            severity: "error",
            params: { definitionNodeId: element.definitionNodeId },
          });
        }
        seen.add(element.definitionNodeId);
      } else if (element.kind === "sequence") visit(element, elementPath);
      else if (element.kind === "choice") {
        for (const branch of element.branches) {
          visit(branch.body, `${elementPath}.branches.${branch.outcome}.body`);
        }
      } else {
        const rule = contextFreeLoopLimit(element.outcomeFromDefinitionNodeId);
        if (element.maxIterations < 1 || element.maxIterations > rule) {
          diagnostics.push({
            family: "limit_exceeded",
            code: "definition.loop_iterations_out_of_range",
            path: `${elementPath}.maxIterations`,
            severity: "error",
            params: { actual: element.maxIterations, limit: rule },
          });
        }
        visit(element.body, `${elementPath}.body`);
      }
    }
  };
  visit(root, "$.semanticRoot");
  return diagnostics;
}

// Contract的结构绝对上限；具体Blueprint上限由共享operation policy校验。
function contextFreeLoopLimit(_outcomeFromDefinitionNodeId: string): number {
  return 5;
}

export function designerSemanticSignature(root: WorkflowDefinitionSequence): string {
  return JSON.stringify(root);
}

export function slotsForAddress(
  slots: readonly WorkflowDesignerSlotDto[],
  address: DesignerAddress,
): readonly WorkflowDesignerSlotDto[] {
  const signature = JSON.stringify(address);
  return slots.filter((slot) => JSON.stringify(slot.address) === signature);
}
